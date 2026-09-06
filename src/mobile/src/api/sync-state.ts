// ============================================================
// 移动端同步状态跟踪（P0-A08/A18/A19）
//
// 模块级 SyncState：连接状态（'connecting' | 'connected' | 'disconnected'）
// + lastSyncAt + pendingCount。由 supabase.ts 的 channel status 事件、
// 数据读写、命令投递驱动；组件通过 onSyncStateChange 订阅决定轮询降级与 UI 展示。
//
// 本模块为纯事件源，不含任何请求/订阅逻辑（避免循环依赖）。
// ============================================================

export type SyncStatus = 'connecting' | 'connected' | 'disconnected';

export interface SyncState {
  status: SyncStatus;
  /** 最近一次成功同步（收到 realtime 事件 / 成功读写）时间 */
  lastSyncAt: string | null;
  /** 当前处于 pending 的本地命令数 */
  pendingCount: number;
}

let syncStatusValue: SyncStatus = 'disconnected';
let lastSyncAtValue: string | null = null;
// command id -> 进入 pending 的时间戳（超时自动清理，防止计数永久滞留）
const pendingSince = new Map<string, number>();
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

const syncStateListeners = new Set<(state: SyncState) => void>();

/** 读取当前同步状态 */
export function getSyncState(): SyncState {
  prunePending();
  return { status: syncStatusValue, lastSyncAt: lastSyncAtValue, pendingCount: pendingSince.size };
}

/** 读取当前连接状态（组件据此做轮询降级决策） */
export function getSyncStatus(): SyncStatus {
  return syncStatusValue;
}

/** 订阅同步状态变化。返回取消订阅函数。首次订阅立即收到当前状态。 */
export function onSyncStateChange(listener: (state: SyncState) => void): () => void {
  syncStateListeners.add(listener);
  try { listener(getSyncState()); } catch { /* listener 异常不阻塞注册 */ }
  return () => { syncStateListeners.delete(listener); };
}

function emitSyncState(): void {
  const state = getSyncState();
  syncStateListeners.forEach((l) => {
    try { l(state); } catch { /* ignore */ }
  });
}

/** 更新连接状态（由 channel status 事件驱动） */
export function updateSyncStatus(status: SyncStatus): void {
  if (syncStatusValue !== status) {
    syncStatusValue = status;
    emitSyncState();
  }
}

/** 记录一次成功同步（收到 realtime 事件 / 成功读写） */
export function markSynced(): void {
  lastSyncAtValue = new Date().toISOString();
  emitSyncState();
}

/** 记录一条命令进入 pending */
export function trackPending(commandId: string): void {
  pendingSince.set(commandId, Date.now());
  emitSyncState();
}

/** 命令离开 pending（处理完成 / 失败 / 删除） */
export function settlePending(commandId: string): void {
  if (pendingSince.delete(commandId)) emitSyncState();
}

/** 登出清理：重置全部同步状态 */
export function resetSyncState(): void {
  pendingSince.clear();
  syncStatusValue = 'disconnected';
  lastSyncAtValue = null;
  emitSyncState();
}

/** 统一处理各受管 channel 的订阅状态（驱动连接状态跟踪） */
export function handleChannelStatus(status: string): void {
  switch (status) {
    case 'SUBSCRIBED':
      updateSyncStatus('connected');
      markSynced();
      break;
    case 'CHANNEL_ERROR':
    case 'CLOSED':
    case 'TIMED_OUT':
      updateSyncStatus('disconnected');
      break;
    case 'CLOSING':
      // 主动关闭过程，不改变对外状态
      break;
    default:
      break;
  }
}

function prunePending(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, ts] of pendingSince) {
    if (now - ts > PENDING_TIMEOUT_MS) {
      pendingSince.delete(id);
      changed = true;
    }
  }
  if (changed) emitSyncState();
}