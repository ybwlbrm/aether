import type { BackendConfig } from '../../config/index.js';
import { setupRealtimeListener } from './realtime.js';
import {
  getSyncConfig,
  getSupabaseClient,
  getRealtimeChannel,
} from './sync-config.js';

// ============================================================
// 同步运行时助手（T4/T5/T6/T7 共享基座）
//
// 职责：把「确保 Supabase 客户端 + Realtime 监听 + 轮询兜底已启动」这段
// 幂等逻辑收敛到一处。setupRealtimeListener 自身已是幂等的
// （进入即清理旧 channel / 旧轮询句柄 / 重连定时器再重订阅），
// 本模块在其之上再补一层重入守卫，避免启动路径并发调用时重复启动。
// ============================================================

/** 同步运行时健康快照（供 status 端点 / 诊断接口复用） */
export interface SyncRuntimeHealth {
  configured: boolean
  connected: boolean
  realtimeListening: boolean
  userIdBound: boolean
}

/**
 * 聚合当前同步运行时状态。
 * 纯读取 —— 未配置时返回全 false 的快照，不抛错。
 */
export function getSyncRuntimeHealth(): SyncRuntimeHealth {
  const cfg = getSyncConfig();
  return {
    configured: cfg !== null,
    connected: getSupabaseClient() !== null,
    realtimeListening: getRealtimeChannel() !== null,
    userIdBound: !!cfg?.userId,
  };
}

/** 重入守卫：并发调用共享同一次启动 promise，启动结束（无论成败）即释放 */
let starting: Promise<boolean> | null = null;

/**
 * 确保同步运行时已启动（Realtime 监听 + 轮询兜底）。
 *
 * 幂等语义：
 * 1. syncConfig / supabase 客户端任一缺失 → 直接返回 false，不抛错（调用方按「未配置」降级）
 * 2. 并发调用共享同一次启动（starting 守卫），不会重复订阅
 * 3. 启动结束即释放守卫 —— 后续显式调用可重新触发（setupRealtimeListener 自身幂等，
 *    会清理旧 channel 与旧轮询句柄再重订阅），保证配置变更后能重新生效
 *
 * @returns 监听已启动返回 true；未配置返回 false；setupRealtimeListener 抛错则向上抛出（由调用方记录日志）
 */
export async function ensureSyncRuntime(config: BackendConfig): Promise<boolean> {
  if (starting) return starting;

  starting = startSyncRuntime(config);
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function startSyncRuntime(config: BackendConfig): Promise<boolean> {
  const cfg = getSyncConfig();
  const sb = getSupabaseClient();
  if (!cfg || !sb) return false;

  await setupRealtimeListener(sb, cfg, config);
  return true;
}
