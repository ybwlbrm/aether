import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackendConfig } from '../../config/index.js';
import type { SyncConfig } from './sync-config.js';
import { processRemoteCommand } from './command-processor.js';
import {
  createSupabaseCancellationLookup,
  isCancellationCommand,
  parseRemoteCommandRow,
  resolveCancellationRunId,
} from './command-cancellation.js';
import { PROCESSABLE_REMOTE_COMMAND_STATUSES } from './remote-command-status.js';
// §15.1 收口：Mobile Stop 真取消 —— 检测 /cancel 命令后触发 RunCancellationRegistry 取消
import { runCancellationRegistry } from '../../lib/run-cancellation-registry.js';
import { logger } from '../../lib/logger.js';

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
 * 每 pollIntervalMs 拉取 status=pending/cancelled 且最近 fiveMinMs 内创建的 remote_commands，
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
          .in('status', PROCESSABLE_REMOTE_COMMAND_STATUSES)
          .gte('created_at', fiveMinAgo)
          .order('created_at', { ascending: true })
          .limit(20);
        if (queryError) {
          logger.warn({ event: 'sync.polling_query_failed', error: queryError.message }, '[Sync] 轮询查询失败:');
          return;
        }
        if (data && data.length > 0) {
          for (const row of data) {
            if (typeof row !== 'object' || row === null) continue;
            const cmd = parseRemoteCommandRow(row);
            if (!cmd) {
              logger.warn({ event: 'sync.polling_command_unparsable' }, '[Sync] 轮询收到无法解析的远程命令，已忽略');
              continue;
            }
            if (processingCommandIds.has(cmd.id)) continue;
            processingCommandIds.add(cmd.id);
            try {
              // §15.1 收口：Mobile Stop 真取消 —— 检测 /cancel 命令（status=cancelled + content=/cancel），
              // 触发 runCancellationRegistry.cancel(runTaskId) → AbortSignal → run.cancelled 终态。
              // 不进入 processRemoteCommand（cancel 不是可执行指令，而是取消信号）。
              if (isCancellationCommand(cmd)) {
                const runId = await resolveCancellationRunId(
                  cmd,
                  createSupabaseCancellationLookup(sb),
                  (conversationId) => runCancellationRegistry.runIdsForConversation(conversationId),
                );
                if (!runId) {
                  logger.warn(
                    { event: 'sync.polling_cancel_run_missing', commandId: cmd.id, clientCommandId: cmd.client_command_id ?? '无' },
                    '[Sync] 收到取消命令但未找到唯一活动 Run',
                  );
                } else if (!runCancellationRegistry.has(runId)) {
                  logger.warn(
                    { event: 'sync.polling_cancel_run_unregistered', runId },
                    '[Sync] 收到取消命令但 Run 未注册（可能已结束）',
                  );
                } else {
                  const aborted = runCancellationRegistry.cancel(runId);
                  if (aborted) {
                    logger.info(
                      { event: 'sync.polling_run_cancelled', runId },
                      `[Sync] 收到 Mobile 取消命令 → 取消 Run ${runId}`,
                    );
                  } else {
                    logger.error(
                      { event: 'sync.polling_cancel_run_failed', runId, commandId: cmd.id },
                      '[Sync] 收到 Mobile 取消命令但 Run 取消失败',
                    );
                  }
                }
                continue;
              }
              if (cmd.status !== 'pending') continue;
              logger.info(
                { event: 'sync.polling_command_processing', commandId: cmd.id, contentPreview: cmd.content.slice(0, 80) },
                '[Sync] 轮询兜底处理命令:',
              );
              await processRemoteCommand(sb, cfg, cmd, backendConfig);
            } catch (cmdErr) {
              // 单条命令失败不阻塞后续命令，记录错误并继续
              logger.error(
                {
                  event: 'sync.polling_command_failed',
                  commandId: cmd.id,
                  isCancellation: isCancellationCommand(cmd),
                  error: cmdErr instanceof Error ? cmdErr.message : String(cmdErr),
                },
                '[Sync] 轮询处理单条命令失败',
              )
            } finally {
              processingCommandIds.delete(cmd.id);
            }
          }
        }
      } catch (e) {
        // 网络抖动或其他异常时静默，下一轮再试
        logger.warn(
          { event: 'sync.polling_cycle_failed', error: e instanceof Error ? e.message : String(e) },
          '[Sync] 轮询兜底失败（将重试）:',
        );
      }
    })().catch((e) => {
      // 双重保险：捕获 IIFE 返回 promise 的任何未处理拒绝
      logger.error(
        { event: 'sync.polling_callback_rejection', error: e instanceof Error ? e.message : String(e) },
        '[Sync] 轮询回调未捕获拒绝:',
      );
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