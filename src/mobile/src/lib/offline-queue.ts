/**
 * 统一离线队列管理器（§10 / §78 / AEX-P1-076）
 *
 * 收敛 enqueue / flush / retry / remove / getPending / dead_letter 到一个类，
 * 不再散落在业务函数里。支持：
 * - 持久化（localStorage，可注入 storage 便于测试）
 * - 上限保护 / 超期丢弃 / 重试上限
 * - flush 防重入（flushing 标志）
 * - 发送回调返回 sent/failed 决定移除/保留
 *
 * AEX-P1-076：命令状态机 pending / sending / retrying / failed / dead_letter。
 * 重试次数耗尽的命令进入 dead_letter 而不是被删除 —— 永久失败的命令不得无声消失，
 * 必须由 UI 展示（N actions failed [View] [Retry all]）并由用户决定重试或清除。
 */

export type QueueCommandStatus = 'pending' | 'sending' | 'retrying' | 'failed' | 'dead_letter';

export interface QueuedCommand {
  id: string;               // client_command_id（幂等键）
  content: string;
  conversation_id: string | null;
  created_at: string;
  attempts?: number;
  /** 缺省视为 pending（兼容旧版本已落盘的载荷） */
  status?: QueueCommandStatus;
  /** 进入 dead_letter 的时间（仅 dead_letter 有值） */
  dead_lettered_at?: string | null;
}

export type QueueFlushResult = 'sent' | 'failed' | 'retry';

/** onChange 快照：可重试命令与永久失败命令分开给出 */
export interface QueueSnapshot {
  readonly pending: QueuedCommand[];
  readonly deadLetter: QueuedCommand[];
}

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const QUEUE_MAX_SIZE = 100;
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const QUEUE_MAX_RETRY = 5;

const PENDING_STATUSES: readonly QueueCommandStatus[] = ['pending', 'sending', 'retrying', 'failed'];

/** 缺省状态：旧载荷没有 status 字段，按 pending 处理 */
function statusOf(cmd: QueuedCommand): QueueCommandStatus {
  return cmd.status ?? 'pending';
}

function isDeadLetter(cmd: QueuedCommand): boolean {
  return statusOf(cmd) === 'dead_letter';
}

export class OfflineQueueManager {
  private readonly key: string;
  private readonly storage: QueueStorage;
  private flushing = false;
  private listeners = new Set<(snapshot: QueueSnapshot) => void>();

  constructor(key: string, storage: QueueStorage = typeof localStorage !== 'undefined' ? localStorage : memoryStorage) {
    this.key = key;
    this.storage = storage;
  }

  /** 入队（幂等：同 id 不重复；命中 dead_letter 则复活为 pending） */
  enqueue(cmd: QueuedCommand): boolean {
    const all = this.readAll();
    const index = all.findIndex((c) => c.id === cmd.id);
    if (index !== -1) {
      if (!isDeadLetter(all[index])) return true; // 已在可重试队列中，视为成功
      // 死信被用户重新提交 → 复活并刷新租约（否则超期过滤会把它再次静默吞掉）
      const revived: QueuedCommand = {
        ...cmd,
        attempts: 0,
        status: 'pending',
        dead_lettered_at: null,
      };
      all[index] = revived;
      this.saveAll(all);
      return true;
    }
    if (all.length >= QUEUE_MAX_SIZE) {
      console.warn(`[queue] 离线队列已满（上限 ${QUEUE_MAX_SIZE}），拒绝 ${cmd.id}`);
      return false;
    }
    all.push({ ...cmd, attempts: cmd.attempts ?? 0, status: 'pending' });
    this.saveAll(all);
    return true;
  }

  /** 移除指定命令（pending 与 dead_letter 均可移除） */
  remove(id: string): void {
    this.saveAll(this.readAll().filter((c) => c.id !== id));
  }

  /** 指定 id 是否仍在队列中（含 dead_letter） */
  has(id: string): boolean {
    return this.readAll().some((c) => c.id === id);
  }

  /** 当前可重传命令（过滤超期与 dead_letter） */
  getPending(): QueuedCommand[] {
    return this.readAll().filter((c) => !isDeadLetter(c) && !this.isExpired(c));
  }

  /** 永久失败命令（不再自动重试，也不会消失，直到用户重试或清除） */
  getDeadLetter(): QueuedCommand[] {
    return this.readAll().filter(isDeadLetter);
  }

  /**
   * 将全部 dead_letter 重置 attempts 并重新入队。
   * @returns 复活的命令数
   */
  retryAll(): number {
    const now = new Date().toISOString();
    let revived = 0;
    const next = this.readAll().map((cmd) => {
      if (!isDeadLetter(cmd)) return cmd;
      revived++;
      // created_at 视为「本次重试的租约起点」：超期过滤不得让用户刚点的重试失效
      return { ...cmd, created_at: now, attempts: 0, status: 'pending' as const, dead_lettered_at: null };
    });
    this.saveAll(next);
    return revived;
  }

  /** 是否有待传命令 */
  get count(): number {
    return this.getPending().length;
  }

  /** 永久失败命令数（UI 提示 N actions failed） */
  get deadLetterCount(): number {
    return this.getDeadLetter().length;
  }

  /** 是否正在 flush */
  get isFlushing(): boolean {
    return this.flushing;
  }

  /**
   * 补传队列：逐条调用 sender，按结果移除/保留/重试/死信。
   * @param sender 返回 sent=移除；retry=保留待重试；failed=保留但标记失败
   * @returns 本次成功发送数量
   */
  async flush(sender: (cmd: QueuedCommand) => Promise<QueueFlushResult>): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      // 从完整存储出发：dead_letter 必须原样保留，不能被本轮 save 覆盖清空
      const next = new Map(
        this.readAll()
          .filter((c) => isDeadLetter(c) || !this.isExpired(c))
          .map((c) => [c.id, c]),
      );
      const retryable = [...next.values()].filter((c) => !isDeadLetter(c));
      if (retryable.length === 0) return 0;

      let sent = 0;
      for (const cmd of retryable) {
        const result = await sender({ ...cmd, status: 'sending' });
        if (result === 'sent') {
          next.delete(cmd.id);
          sent++;
          continue;
        }
        const attempts = (cmd.attempts ?? 0) + 1;
        if (attempts >= QUEUE_MAX_RETRY) {
          // 重试耗尽：转入 dead_letter（不删除，UI 可见可重试）
          console.warn(`[queue] ${cmd.id} 连续失败 ${attempts} 次，进入 dead_letter`);
          next.set(cmd.id, {
            ...cmd,
            attempts,
            status: 'dead_letter',
            dead_lettered_at: new Date().toISOString(),
          });
          continue;
        }
        next.set(cmd.id, {
          ...cmd,
          attempts,
          status: result === 'retry' ? 'retrying' : 'failed',
        });
      }
      this.saveAll([...next.values()]);
      return sent;
    } finally {
      this.flushing = false;
    }
  }

  /** 订阅队列变化（UI 同步，返回取消函数） */
  onChange(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    try { listener(this.getSnapshot()); } catch { /* ignore */ }
    return () => this.listeners.delete(listener);
  }

  /** 当前快照（pending + deadLetter） */
  getSnapshot(): QueueSnapshot {
    return { pending: this.getPending(), deadLetter: this.getDeadLetter() };
  }

  private readAll(): QueuedCommand[] {
    try {
      const raw = this.storage.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((c): c is QueuedCommand => typeof c === 'object' && c !== null && typeof c.id === 'string');
    } catch {
      return [];
    }
  }

  private isExpired(cmd: QueuedCommand): boolean {
    const age = Date.now() - new Date(cmd.created_at).getTime();
    return !Number.isFinite(age) || age > QUEUE_MAX_AGE_MS;
  }

  private saveAll(queue: QueuedCommand[]): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(queue));
    } catch { /* 存储满时忽略 */ }
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((l) => {
      try { l(snapshot); } catch { /* ignore */ }
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

/** 供 UI 判断某状态是否仍在自动重试链路中 */
export function isRetryableStatus(status: QueueCommandStatus): boolean {
  return PENDING_STATUSES.includes(status);
}
