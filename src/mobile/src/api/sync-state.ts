// ============================================================
// 移动端同步状态（§21 ChannelStatusRegistry / §22 断线恢复）
//
// 基于 ChannelStatusRegistry：每个 channel（messages/conversations/commands）
// 独立维护连接状态，聚合出 overall status：
//   connected / degraded / connecting / disconnected
//
// 对外保持旧 API 兼容：SyncStatus / SyncState / getSyncState / getSyncStatus /
// onSyncStateChange / markSynced / trackPending / settlePending / resetSyncState。
//
// handleChannelStatus 现在需要指定 channel 名（由 supabase.ts 传入），
// 不再让任意 channel 单独覆盖全局状态。
// ============================================================

import {
  ChannelStatusRegistry,
  type ChannelName,
  type OverallStatus,
} from '../lib/channel-registry';

export type SyncStatus = OverallStatus; // 'connected' | 'degraded' | 'connecting' | 'disconnected'

export interface SyncState {
  status: SyncStatus;
  /** 最近一次成功同步（收到 realtime 事件 / 成功读写）时间 */
  lastSyncAt: string | null;
  /** 当前处于 pending 的本地命令数 */
  pendingCount: number;
}

// 单一注册表实例（模块级，全局共享）
const registry = new ChannelStatusRegistry();

/** 读取当前同步状态 */
export function getSyncState(): SyncState {
  const s = registry.getState();
  return { status: s.status, lastSyncAt: s.lastSyncAt, pendingCount: s.pendingCount };
}

/** 读取当前连接状态（组件据此做轮询降级决策） */
export function getSyncStatus(): SyncStatus {
  return registry.getState().status;
}

/** 订阅同步状态变化。返回取消订阅函数。首次订阅立即收到当前状态。 */
export function onSyncStateChange(listener: (state: SyncState) => void): () => void {
  return registry.onChange((s) => {
    listener({ status: s.status, lastSyncAt: s.lastSyncAt, pendingCount: s.pendingCount });
  });
}

/** 记录一次成功同步（收到 realtime 事件 / 成功读写） */
export function markSynced(): void {
  registry.markSynced();
}

/** 记录一条命令进入 pending */
export function trackPending(commandId: string): void {
  registry.trackPending(commandId);
}

/** 命令离开 pending（处理完成 / 失败 / 删除） */
export function settlePending(commandId: string): void {
  registry.settlePending(commandId);
}

/** 登出清理：重置全部同步状态 */
export function resetSyncState(): void {
  registry.reset();
}

/**
 * 统一处理某 channel 的订阅状态。
 * @param channel 该状态所属的 channel（不再允许匿名覆盖全局）
 */
export function handleChannelStatus(channel: ChannelName, status: string): void {
  switch (status) {
    case 'SUBSCRIBED':
      registry.setChannelStatus(channel, 'connected');
      markSynced();
      break;
    case 'CHANNEL_ERROR':
    case 'CLOSED':
    case 'TIMED_OUT':
      registry.setChannelStatus(channel, 'disconnected');
      break;
    case 'CLOSING':
      // 主动关闭过程，不改变对外状态
      break;
    default:
      break;
  }
}
