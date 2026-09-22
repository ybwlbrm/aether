/**
 * ChannelStatusRegistry（§21 / §22）
 *
 * 不再用单一全局 syncStatusValue 被任意 channel 覆盖。
 * 每个 channel（messages / conversations / commands）独立维护状态，
 * 再聚合出 overall status：
 *   - connected   ：所有活跃 channel 均 connected
 *   - degraded    ：部分 channel connected（如 messages 断、conversations 通）
 *   - connecting  ：无 connected，但有 connecting
 *   - disconnected：全部 disconnected / 无活跃 channel
 *
 * 同时驱动 lastSyncAt（任何 channel 收到真实事件/读写即视为同步成功）
 * 与 pendingCount（命令追踪，独立于连接状态）。
 */

export type ChannelName = 'messages' | 'conversations' | 'commands';
export type ChannelStatus = 'connecting' | 'connected' | 'disconnected';
export type OverallStatus = 'connected' | 'connecting' | 'degraded' | 'disconnected';

export interface ChannelSyncState {
  status: OverallStatus;
  lastSyncAt: string | null;
  pendingCount: number;
  /** 各 channel 细分状态 */
  channels: Record<ChannelName, ChannelStatus>;
}

export const CHANNEL_NAMES: ChannelName[] = ['messages', 'conversations', 'commands'];

export class ChannelStatusRegistry {
  private statuses: Record<ChannelName, ChannelStatus> = {
    messages: 'disconnected',
    conversations: 'disconnected',
    commands: 'disconnected',
  };
  private lastSyncAt: string | null = null;
  private pendingSince = new Map<string, number>();
  private listeners = new Set<(state: ChannelSyncState) => void>();
  private pendingTimeoutMs: number;

  constructor(opts: { pendingTimeoutMs?: number } = {}) {
    this.pendingTimeoutMs = opts.pendingTimeoutMs ?? 10 * 60 * 1000;
  }

  /** 聚合整体状态（纯函数，便于测试） */
  static aggregate(statuses: Record<ChannelName, ChannelStatus>): OverallStatus {
    const list = CHANNEL_NAMES.map((n) => statuses[n]);
    const anyConnected = list.includes('connected');
    const anyConnecting = list.includes('connecting');
    if (anyConnected && list.every((s) => s === 'connected')) return 'connected';
    if (anyConnected) return 'degraded';
    if (anyConnecting) return 'connecting';
    return 'disconnected';
  }

  /** 设置某 channel 的原始订阅状态（SUBSCRIBED/CLOSED/...） */
  setChannelStatus(channel: ChannelName, status: ChannelStatus): void {
    if (this.statuses[channel] !== status) {
      this.statuses[channel] = status;
      this.emit();
    }
  }

  getChannelStatus(channel: ChannelName): ChannelStatus {
    return this.statuses[channel];
  }

  /** 记录一次成功同步（任何 channel 收到真实数据） */
  markSynced(): void {
    this.lastSyncAt = new Date().toISOString();
    this.emit();
  }

  trackPending(commandId: string): void {
    this.pendingSince.set(commandId, Date.now());
    this.emit();
  }

  settlePending(commandId: string): void {
    if (this.pendingSince.delete(commandId)) this.emit();
  }

  /** 订阅状态变化，返回取消函数；首次订阅立即收到当前状态 */
  onChange(listener: (state: ChannelSyncState) => void): () => void {
    this.listeners.add(listener);
    try { listener(this.getState()); } catch { /* ignore */ }
    return () => this.listeners.delete(listener);
  }

  getState(): ChannelSyncState {
    this.prunePending();
    return {
      status: ChannelStatusRegistry.aggregate(this.statuses),
      lastSyncAt: this.lastSyncAt,
      pendingCount: this.pendingSince.size,
      channels: { ...this.statuses },
    };
  }

  reset(): void {
    this.statuses = { messages: 'disconnected', conversations: 'disconnected', commands: 'disconnected' };
    this.pendingSince.clear();
    this.lastSyncAt = null;
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((l) => {
      try { l(state); } catch { /* ignore */ }
    });
  }

  private prunePending(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, ts] of this.pendingSince) {
      if (now - ts > this.pendingTimeoutMs) {
        this.pendingSince.delete(id);
        changed = true;
      }
    }
    // prune 不 emit（避免读操作触发写），由下次变更统一广播
    void changed;
  }
}
