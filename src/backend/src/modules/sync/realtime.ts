import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { conversations } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { getRealtimeChannel, setRealtimeChannel } from './sync-config.js';
import { processRemoteCommand } from './command-processor.js';
import { startPollingFallback, type PollingFallbackHandle } from './polling-fallback.js';
import {
  createSupabaseCancellationLookup,
  isCancellationCommand,
  parseRemoteCommandRow,
  resolveCancellationRunId,
} from './command-cancellation.js';
import { REMOTE_COMMAND_REALTIME_FILTER } from './remote-command-status.js';
// §15.1 收口：Mobile Stop 真取消 —— Realtime 收到 /cancel 命令 → runCancellationRegistry 取消
import { runCancellationRegistry } from '../../lib/run-cancellation-registry.js';
import { deleteConversationCascade } from '../conversations/delete-conversation.js';
import type { SyncConfig } from './sync-config.js';
import { shouldScheduleReconnect } from './realtime-logic.js';
import { logger } from '../../lib/logger.js';

// ============================================================
// 设置 Realtime 监听（远程命令）
// ============================================================

// BE-RC-02: 去重集合提升为模块级单例 — 重连重建监听时复用，
// 避免旧 Set 引用丢失导致重放命令被重复处理
const processingCommandIds = new Set<string>();

// BE-RL-01/02: 模块级句柄 — 重连前显式清理旧轮询与重连定时器，防泄漏
let pollingHandle: PollingFallbackHandle | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

type RealtimeCommandPayload = {
  readonly new?: Record<string, unknown> | null
}

type RealtimeDeletePayload = {
  readonly old?: Record<string, unknown> | null
}

export async function setupRealtimeListener(
  sb: SupabaseClient,
  cfg: SyncConfig,
  backendConfig: BackendConfig
): Promise<void> {
  // BE-RL-01/02: 清理旧资源（重连进入本函数时先停掉旧轮询与定时器）
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pollingHandle) { pollingHandle.stop(); pollingHandle = null; }

  // 清理旧监听
  // BE-RL-03 修复：先摘除模块级注册引用，再 removeChannel。
  // 若不摘除，removeChannel 触发的旧 channel CLOSED 回调会判定
  // 「getRealtimeChannel() !== 新 channel」失败而误走重连调度 → 死循环。
  const existingChannel = getRealtimeChannel();
  if (existingChannel) {
    setRealtimeChannel(null); // 关键：先置空注册，使旧 channel 回调被判定为「非当前 channel」
    try { await sb.removeChannel(existingChannel); } catch { /* ignore */ }
  }

  const realtimeChannel = sb.channel('remote-commands-listener')
    .on('postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'remote_commands',
        filter: REMOTE_COMMAND_REALTIME_FILTER,
      },
      async (payload: RealtimeCommandPayload) => {
        const row = payload.new
        const cmd = row ? parseRemoteCommandRow(row) : null
        if (!cmd) {
          if (row) logger.warn({ event: 'sync.realtime_command_unparsable' }, '[Sync] 收到无法解析的远程命令，已忽略')
          return
        }

        // §15.1 收口：Mobile Stop 真取消 —— Realtime 收到的 /cancel 命令直接触发
        // runCancellationRegistry.cancel（不进入 processRemoteCommand）。
        if (isCancellationCommand(cmd)) {
          if (processingCommandIds.has(cmd.id)) return
          processingCommandIds.add(cmd.id)
          try {
            const runId = await resolveCancellationRunId(
              cmd,
              createSupabaseCancellationLookup(sb),
              (conversationId) => runCancellationRegistry.runIdsForConversation(conversationId),
            )
            if (!runId) {
              logger.warn(
                { event: 'sync.realtime_cancel_run_missing', commandId: cmd.id, clientCommandId: cmd.client_command_id ?? '无' },
                '[Sync] 收到取消命令但未找到唯一活动 Run',
              )
              return
            }
            if (!runCancellationRegistry.has(runId)) {
              logger.warn(
                { event: 'sync.realtime_cancel_run_unregistered', runId },
                '[Sync] 收到取消命令但 Run 未注册，可能已结束',
              )
              return
            }
            const aborted = runCancellationRegistry.cancel(runId)
            if (aborted) {
              logger.info(
                { event: 'sync.realtime_run_cancelled', runId },
                `[Sync] Realtime 收到取消命令 → 取消 Run ${runId}`,
              )
            } else {
              logger.error(
                { event: 'sync.realtime_cancel_run_failed', runId },
                '[Sync] Realtime 取消 Run 失败：注册表未接受取消',
              )
            }
          } catch (e: unknown) {
            logger.error(
              {
                event: 'sync.realtime_cancel_run_lookup_failed',
                commandId: cmd.id,
                clientCommandId: cmd.client_command_id ?? '无',
                error: e instanceof Error ? e.message : String(e),
              },
              '[Sync] Realtime 定位取消 Run 失败',
            )
          } finally {
            processingCommandIds.delete(cmd.id)
          }
          return
        }

        // 去重检查：防止 Supabase Realtime 重复推送同一 INSERT 事件
        if (cmd.status === 'pending' && !processingCommandIds.has(cmd.id)) {
          processingCommandIds.add(cmd.id)
          logger.info(
            { event: 'sync.realtime_command_received', commandId: cmd.id, contentPreview: cmd.content.slice(0, 100) },
            '[Sync] 收到远程命令:',
          )
          // 二次确认：从数据库查当前状态，防止重放已处理完的命令
          try {
            const { data: current, error: statusError } = await sb
              .from('remote_commands')
              .select('status')
              .eq('id', cmd.id)
              .single()
            if (statusError) {
              logger.error(
                { event: 'sync.realtime_status_recheck_failed', commandId: cmd.id, error: statusError.message },
                '[Sync] 二次确认远程命令状态失败，跳过处理',
              )
              processingCommandIds.delete(cmd.id)
              return
            }
            if (current?.status !== 'pending') {
              logger.info(
                { event: 'sync.realtime_command_replay_skipped', commandId: cmd.id },
                '[Sync] 命令已处理，跳过重放:',
              )
              processingCommandIds.delete(cmd.id)
              return
            }
          } catch (e: unknown) {
            logger.warn(
              { event: 'sync.realtime_status_recheck_error', commandId: cmd.id, error: e instanceof Error ? e.message : String(e) },
              '[Sync] 二次确认远程命令状态异常，继续处理:',
            )
          }
          try {
            await processRemoteCommand(sb, cfg, cmd, backendConfig)
          } finally {
            processingCommandIds.delete(cmd.id)
          }
        }
      },
    )
    .on('postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'conversations_sync',
      },
      async (payload: RealtimeDeletePayload) => {
        const deletedId = typeof payload.old?.id === 'string' ? payload.old.id : null;
        if (deletedId) {
          const db = getDb();
          try {
            const existing = db.select().from(conversations).where(eq(conversations.id, deletedId)).get();
            if (existing) {
              // P0-21: 按 FK 依赖顺序级联删除全部关联行（显式删除，兼容未迁移 v13 的旧库）
              deleteConversationCascade(db, deletedId);
              saveDb(backendConfig);
              logger.info(
                { event: 'sync.realtime_conversation_deleted', conversationId: deletedId },
                '[Sync] 已同步删除本地对话:',
              );
            }
          } catch (e: unknown) {
            logger.warn(
              { event: 'sync.realtime_conversation_delete_failed', conversationId: deletedId, error: e instanceof Error ? e.message : String(e) },
              '[Sync] 同步删除本地对话失败:',
            );
          }
        }
      },
    )
    .subscribe((status: string, err: unknown) => {
      logger.info({ event: 'sync.realtime_subscribe_status', status }, '[Sync] Realtime 订阅状态:');
      // BE-RL-03 修复：仅当本 channel 仍是当前注册的 channel 时才处理状态回调。
      // 主动 removeChannel 的旧 channel 触发的 CLOSED/TIMED_OUT 回调被直接忽略，
      // 不再调度重连 → 打断「重连 → removeChannel → 回调 → 再重连」死循环。
      const isCurrent = getRealtimeChannel() === realtimeChannel;
      if (!isCurrent) return;
      // 断线重连：SUBSCRIBED 但之后 CLOSED/CHANNEL_ERROR/TIMED_OUT → 重新订阅
      if (shouldScheduleReconnect(status, isCurrent)) {
        const errorMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
        logger.warn(
          { event: 'sync.realtime_connection_abnormal', status, error: errorMessage },
          '[Sync] Realtime 连接异常，3s 后重新订阅:',
        )
        // 使用闭包捕获重试次数，实现指数退避 + 最大重试次数，防止无限重试风暴
        let reconnectAttempt = 0;
        const MAX_RECONNECT_ATTEMPTS = 10;
        const scheduleReconnect = (attempt: number) => {
          if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            logger.error(
              { event: 'sync.realtime_reconnect_exhausted', attempts: attempt },
              '[Sync] Realtime 重连次数超限，放弃重连。请检查网络或 Supabase 状态。',
            );
            return;
          }
          const delayMs = Math.min(3000 * Math.pow(2, attempt), 60_000); // 指数退避，上限 60s
          logger.info(
            { event: 'sync.realtime_reconnect_scheduled', attempt: attempt + 1, delayMs },
            `[Sync] 安排第 ${attempt + 1} 次重连，延迟 ${delayMs}ms`,
          );
          // BE-RL-02: 保存重连定时器引用，重连前 clearTimeout 防堆积
          if (reconnectTimer) { clearTimeout(reconnectTimer); }
          reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
              await setupRealtimeListener(sb, cfg, backendConfig);
              logger.info({ event: 'sync.realtime_reconnected' }, '[Sync] Realtime 重连成功');
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logger.warn(
                { event: 'sync.realtime_resubscribe_failed', attempt: attempt + 1, error: msg },
                '[Sync] 重订阅失败，将重试:',
              );
              scheduleReconnect(attempt + 1);
            }
          }, delayMs);
        };
        scheduleReconnect(reconnectAttempt);
      }
    });

  setRealtimeChannel(realtimeChannel);

  logger.info(
    { event: 'sync.realtime_listener_started' },
    '[Sync] Realtime 监听已启动（监听所有 pending 远程命令 + 对话删除同步）',
  );

  // ---- 轮询兜底：Realtime 断开/丢失事件时，仍能处理手机端命令 ----
  // BE-03(a): 双层错误处理 + processingCommandIds 去重
  // BE-RL-01: 保存句柄，重连/关闭时可显式停止
  pollingHandle = startPollingFallback({
    sb,
    cfg,
    backendConfig,
    processingCommandIds,
  });
}