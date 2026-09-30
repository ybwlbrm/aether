/**
 * 统一离线队列管理器（§10 / §78）
 *
 * 收敛 enqueue / flush / retry / remove / getPending 到一个类，
 * 不再散落在业务函数里。支持：
 * - 持久化（localStorage，可注入 storage 便于测试）
 * - 上限保护 / 超期丢弃 / 重试上限
 * - flush 防重入（flushing 标志）
 * - 发送回调返回 sent/failed 决定移除/保留
 */

export interface QueuedCommand {
  id: string;               // client_command_id（幂等键）
  content: string;
  conversation_id: string | null;
  created_at: string;
  attempts?: number;
}

export type QueueFlushResult = 'sent' | 'failed' | 'retry';

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const QUEUE_MAX_SIZE = 100;
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const QUEUE_MAX_RETRY = 5;

export class OfflineQueueManager {
  private readonly key: string;
  private readonly storage: QueueStorage;
  private flushing = false;
  private listeners = new Set<(queue: QueuedCommand[]) => void>();

  constructor(key: string, storage: QueueStorage = typeof localStorage !== 'undefined' ? localStorage : memoryStorage) {
    this.key = key;
    this.storage = storage;
  }

  /** 入队（幂等：同 id 不重复） */
  enqueue(cmd: QueuedCommand): boolean {
    const q = this.getPending();
    if (q.some((c) => c.id === cmd.id)) return true; // 已存在视为成功
    if (q.length >= QUEUE_MAX_SIZE) {
      console.warn(`[queue] 离线队列已满（上限 ${QUEUE_MAX_SIZE}），拒绝 ${cmd.id}`);
      return false;
    }
    q.push(cmd);
    this.save(q);
    return true;
  }

  /** 移除指定命令 */
  remove(id: string): void {
    this.save(this.getPending().filter((c) => c.id !== id));
  }

  /** 当前全部待传命令（过滤超期） */
  getPending(): QueuedCommand[] {
    try {
      const raw = this.storage.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((c) => !this.isExpired(c));
    } catch {
      return [];
    }
  }

  /** 是否有待传命令 */
  get count(): number {
    return this.getPending().length;
  }

  /** 是否正在 flush */
  get isFlushing(): boolean {
    return this.flushing;
  }

  /**
   * 补传队列：逐条调用 sender，按结果移除/保留/重试。
   * @param sender 返回 sent=移除；retry=保留并 attempts+1；failed=保留但计入失败
   * @returns 本次成功发送数量
   */
  async flush(sender: (cmd: QueuedCommand) => Promise<QueueFlushResult>): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      const queue = this.getPending();
      if (queue.length === 0) return 0;
      const remaining: QueuedCommand[] = [];
      let sent = 0;
      for (const cmd of queue) {
        const result = await sender(cmd);
        if (result === 'sent') {
          sent++;
          continue;
        }
        if (result === 'retry') {
          const attempts = (cmd.attempts ?? 0) + 1;
          if (attempts >= QUEUE_MAX_RETRY) {
            console.warn(`[queue] ${cmd.id} 连续失败 ${attempts} 次，进入死信（丢弃）`);
            continue;
          }
          remaining.push({ ...cmd, attempts });
        } else {
          // failed：保留但仅累积尝试（不再无限重试）
          const attempts = (cmd.attempts ?? 0) + 1;
          if (attempts >= QUEUE_MAX_RETRY) {
            console.warn(`[queue] ${cmd.id} 失败 ${attempts} 次，丢弃`);
            continue;
          }
          remaining.push({ ...cmd, attempts });
        }
      }
      this.save(remaining);
      return sent;
    } finally {
      this.flushing = false;
    }
  }

  /** 订阅队列变化（UI 同步，返回取消函数） */
  onChange(listener: (queue: QueuedCommand[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private isExpired(cmd: QueuedCommand): boolean {
    const age = Date.now() - new Date(cmd.created_at).getTime();
    return !Number.isFinite(age) || age > QUEUE_MAX_AGE_MS;
  }

  private save(queue: QueuedCommand[]): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(queue));
    } catch { /* 存储满时忽略 */ }
    this.emit(queue);
  }

  private emit(queue: QueuedCommand[]): void {
    this.listeners.forEach((l) => {
      try { l(queue); } catch { /* ignore */ }
    });
  }
}

/** 无 localStorage 环境（测试/SSR）的内存实现 */
const memoryStorage: QueueStorage = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
})();
