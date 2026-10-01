/**
 * 对话行构造 + 离线待建对话队列（T5 / T9 基座）
 *
 * 纯函数模块：不 import supabase，不触碰浏览器全局 API（除可选 crypto.randomUUID），
 * 因此可在 Node 里直接 type-stripping 单测。
 *
 * conversations_sync 的 user_id 由 DB 触发器 trg_conversations_sync_user_id
 * （supabase-schema.sql:182-185）用 auth.uid() 填充，故 insert payload 故意省略该列。
 */

/** conversations_sync 完整行（含触发器填充的 user_id） */
export interface ConversationRecord {
  id: string;
  title: string;
  model: string | null;
  message_count: number;
  device_id: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 客户端 insert payload：7 列，不含 user_id */
export interface ConversationInsertPayload {
  id: string;
  title: string;
  model: string | null;
  message_count: number;
  device_id: string;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_CONVERSATION_TITLE = '新对话';

/** UUID v4 模板（crypto.randomUUID 缺失时的回退） */
const UUID_V4_TEMPLATE = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';

/**
 * 生成对话 id：优先 crypto.randomUUID（双路径守卫），缺失时回退 v4 形状字符串。
 */
export function newConversationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return UUID_V4_TEMPLATE.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 构造 conversations_sync 的 insert 行（省略 user_id，交给 DB 触发器） */
export function buildConversationInsert(input: {
  id: string;
  deviceId: string;
  title?: string;
  now?: string;
}): ConversationInsertPayload {
  const timestamp = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    title: input.title ?? DEFAULT_CONVERSATION_TITLE,
    model: null,
    message_count: 0,
    device_id: input.deviceId,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

// ============================================================
// 离线待建对话队列
// ============================================================

export interface PendingConversation {
  id: string;
  title: string;
  created_at: string;
  attempts: number;
}

export interface ConversationQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CONVERSATION_QUEUE_MAX_SIZE = 50;
export const CONVERSATION_QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CONVERSATION_QUEUE_MAX_RETRY = 5;

/**
 * 离线期间新建的对话队列：联网后补传 conversations_sync 行。
 * - enqueue 幂等（同 id 不重复）+ 上限保护
 * - getPending 过滤超 CONVERSATION_QUEUE_MAX_AGE_MS 的过期条目
 * - flush 防重入（并发调用只跑一次 sender 循环）
 */
export class PendingConversationQueue {
  private readonly key: string;
  private readonly storage: ConversationQueueStorage;
  private flushing = false;

  constructor(key: string, storage: ConversationQueueStorage) {
    this.key = key;
    this.storage = storage;
  }

  /** 入队（幂等：同 id 视为成功；超上限拒绝） */
  enqueue(entry: PendingConversation): boolean {
    const pending = this.getPending();
    if (pending.some((item) => item.id === entry.id)) return true;
    if (pending.length >= CONVERSATION_QUEUE_MAX_SIZE) {
      console.warn(`[conversation-queue] 队列已满（上限 ${CONVERSATION_QUEUE_MAX_SIZE}），拒绝 ${entry.id}`);
      return false;
    }
    this.save([...pending, entry]);
    return true;
  }

  /** 当前全部待传对话（过滤超期） */
  getPending(): PendingConversation[] {
    try {
      const raw = this.storage.getItem(this.key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is PendingConversation => this.isFresh(item));
    } catch {
      return [];
    }
  }

  /** 移除指定对话 */
  remove(id: string): void {
    this.save(this.getPending().filter((item) => item.id !== id));
  }

  get count(): number {
    return this.getPending().length;
  }

  /** 是否正在 flush */
  get isFlushing(): boolean {
    return this.flushing;
  }

  /**
   * 补传队列：逐条调用 sender。
   * - sent → 移除
   * - retry → attempts+1，累到 CONVERSATION_QUEUE_MAX_RETRY 丢弃
   * - failed → 原样保留
   * @returns 本次成功补传数量
   */
  async flush(
    sender: (entry: PendingConversation) => Promise<'sent' | 'retry' | 'failed'>,
  ): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      const queue = this.getPending();
      if (queue.length === 0) return 0;
      const remaining: PendingConversation[] = [];
      let sent = 0;
      for (const entry of queue) {
        const result = await sender(entry);
        if (result === 'sent') {
          sent++;
          continue;
        }
        if (result === 'retry') {
          const attempts = entry.attempts + 1;
          if (attempts >= CONVERSATION_QUEUE_MAX_RETRY) {
            console.warn(`[conversation-queue] ${entry.id} 连续失败 ${attempts} 次，丢弃`);
            continue;
          }
          remaining.push({ ...entry, attempts });
          continue;
        }
        remaining.push(entry);
      }
      this.save(remaining);
      return sent;
    } finally {
      this.flushing = false;
    }
  }

  private isFresh(item: PendingConversation): boolean {
    const age = Date.now() - new Date(item.created_at).getTime();
    return Number.isFinite(age) && age <= CONVERSATION_QUEUE_MAX_AGE_MS;
  }

  private save(queue: PendingConversation[]): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(queue));
    } catch {
      /* 存储写满时静默放弃本次持久化 */
    }
  }
}