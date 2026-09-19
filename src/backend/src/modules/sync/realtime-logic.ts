// ============================================================
// Realtime 逻辑纯函数（无副作用，供 realtime.ts 与单测共用）
// ============================================================

/**
 * BE-RL-03: 重连调度判定（纯函数，供单测）
 *
 * 死循环根因：setupRealtimeListener 重连时先 removeChannel(旧 channel)，
 * supabase-js 会触发旧 channel 的 CLOSED 状态回调；若该回调无差别调度重连，
 * 则「重连 → removeChannel → CLOSED 回调 → 再重连」无限循环（electron.log 实证）。
 *
 * 修复：只有「仍是当前注册 channel」的状态回调才允许触发重连；
 * 已被主动移除/替换的旧 channel 回调一律忽略。
 */
export function shouldScheduleReconnect(status: string, isCurrentChannel: boolean): boolean {
  if (!isCurrentChannel) return false; // 已被主动移除/替换的 channel，忽略其回调
  return status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT';
}
