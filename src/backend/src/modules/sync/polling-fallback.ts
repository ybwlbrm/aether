import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackendConfig } from '../../config/index.js';
import type { SyncConfig } from './sync-config.js';
import { processRemoteCommand } from './command-processor.js';

// ============================================================
// 轮询兜底：Realtime 断开/丢失事件时，仍能处理手机端命令
// BE-03(a): 双层错误处理 + processingCommandIds 去重
// ============================================================

export interface PollingFallbackOptions {
  sb: SupabaseClient;
  cfg: SyncConfig;
  backendConfig: BackendConfig;
  processingCommandIds: Set<string>;
  pollIntervalMs?: number;
  fiveMinMs?: number;
}

export interface PollingFallbackHandle {
  stop: () => void;
}

/**
 * 启动轮询兜底机制
 * 每 pollIntervalMs 拉取 status=pending 且最近 fiveMinMs 内创建的 remote_commands，
 * 逐个处理（与 Realtime 处理共用 processRemoteCommand，天然去重）
 *
 * 双层错误处理 (BE-03a):
 * 1. 外层 try/catch 捕获查询/网络层异常，静默记录，下一轮重试
 * 2. 内层 IIFE + .catch() 捕获单条命令处理的未处理拒绝，防止泄漏到进程级
 */
export function startPollingFallback(options: PollingFallbackOptions): PollingFallbackHandle {
  const {
    sb,
    cfg,
    backendConfig,
    processingCommandIds,
    pollIntervalMs = 30_000,
    fiveMinMs = 5 * 60 * 1000,
  } = options;

  const pollTimer = globalThis.setInterval(() => {
    // 使用 IIFE async 函数并显式捕获所有拒绝，防止未处理拒绝泄漏到进程级
    (async () => {
      try {
        const fiveMinAgo = new Date(Date.now() - fiveMinMs).toISOString();
        const { data, error: queryError } = await sb.from('remote_commands')
          .select('*')
          .eq('status', 'pending')
          .gte('created_at', fiveMinAgo)
          .order('created_at', { ascending: true })
          .limit(20);
        if (queryError) {
          console.warn('[Sync] 轮询查询失败:', queryError.message);
          return;
        }
        if (data && data.length > 0) {
          for (const cmd of data) {
            if (processingCommandIds.has(cmd.id)) continue;
            processingCommandIds.add(cmd.id);
            try {
              console.log('[Sync] 轮询兜底处理命令:', cmd.content?.slice(0, 80));
              await processRemoteCommand(sb, cfg, cmd, backendConfig);
            } catch (cmdErr) {
              // 单条命令失败不阻塞后续命令，记录错误并继续
              console.error('[Sync] 轮询处理单条命令失败:', cmd.id, cmdErr instanceof Error ? cmdErr.message : cmdErr);
            } finally {
              processingCommandIds.delete(cmd.id);
            }
          }
        }
      } catch (e) {
        // 网络抖动或其他异常时静默，下一轮再试
        console.warn('[Sync] 轮询兜底失败（将重试）:', e instanceof Error ? e.message : e);
      }
    })().catch((e) => {
      // 双重保险：捕获 IIFE 返回 promise 的任何未处理拒绝
      console.error('[Sync] 轮询回调未捕获拒绝:', e instanceof Error ? e.message : e);
    });
  }, pollIntervalMs);

  // 防止定时器导致进程无法退出（EXE 关闭时）
  pollTimer.unref?.();

  return {
    stop: () => {
      clearInterval(pollTimer);
    },
  };
}