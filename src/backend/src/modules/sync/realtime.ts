import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { conversations, messages } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { getSyncConfig, getSupabaseClient, getRealtimeChannel, setRealtimeChannel, getDeviceRegistered, setDeviceRegistered } from './sync-config.js';
import { processRemoteCommand } from './command-processor.js';
import { startPollingFallback, type PollingFallbackHandle } from './polling-fallback.js';
import type { SyncConfig } from './sync-config.js';

// ============================================================
// 设置 Realtime 监听（远程命令）
// ============================================================

// BE-RC-02: 去重集合提升为模块级单例 — 重连重建监听时复用，
// 避免旧 Set 引用丢失导致重放命令被重复处理
const processingCommandIds = new Set<string>();

// BE-RL-01/02: 模块级句柄 — 重连前显式清理旧轮询与重连定时器，防泄漏
let pollingHandle: PollingFallbackHandle | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

export async function setupRealtimeListener(
  sb: SupabaseClient,
  cfg: SyncConfig,
  backendConfig: BackendConfig
): Promise<void> {
  // BE-RL-01/02: 清理旧资源（重连进入本函数时先停掉旧轮询与定时器）
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pollingHandle) { pollingHandle.stop(); pollingHandle = null; }

  // 清理旧监听
  const existingChannel = getRealtimeChannel();
  if (existingChannel) {
    try { await sb.removeChannel(existingChannel); } catch { /* ignore */ }
  }

  const realtimeChannel = sb.channel('remote-commands-listener')
    .on('postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'remote_commands',
        filter: `status=eq.pending`,
      },
      async (payload: any) => {
        const cmd = payload.new;
        // 去重检查：防止 Supabase Realtime 重复推送同一 INSERT 事件
        if (cmd && cmd.status === 'pending' && !processingCommandIds.has(cmd.id)) {
          processingCommandIds.add(cmd.id);
          console.log('[Sync] 收到远程命令:', cmd.content?.slice(0, 100));
          // 二次确认：从数据库查当前状态，防止重放已处理完的命令
          try {
            const { data: current } = await sb.from('remote_commands').select('status').eq('id', cmd.id).single();
            if (current?.status !== 'pending') {
              console.log('[Sync] 命令已处理，跳过重放:', cmd.id);
              processingCommandIds.delete(cmd.id);
              return;
            }
          } catch { /* 查询失败则继续处理，容错 */ }
          try {
            await processRemoteCommand(sb, cfg, cmd, backendConfig);
          } finally {
            processingCommandIds.delete(cmd.id);
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
      async (payload: any) => {
        const deletedId = payload.old?.id;
        if (deletedId) {
          const db = getDb();
          try {
            const existing = db.select().from(conversations).where(eq(conversations.id, deletedId)).get();
            if (existing) {
              db.delete(messages).where(eq(messages.conversationId, deletedId)).run();
              db.delete(conversations).where(eq(conversations.id, deletedId)).run();
              saveDb(backendConfig);
              console.log('[Sync] 已同步删除本地对话:', deletedId);
            }
          } catch (e: unknown) {
            console.warn('[Sync] 同步删除本地对话失败:', e instanceof Error ? e.message : e);
          }
        }
      },
    )
    .subscribe((status: string, err: any) => {
      console.log('[Sync] Realtime 订阅状态:', status);
      // 断线重连：SUBSCRIBED 但之后 CLOSED/CHANNEL_ERROR/TIMED_OUT → 重新订阅
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[Sync] Realtime 连接异常 (${status})，3s 后重新订阅:`, err?.message || '');
        // 使用闭包捕获重试次数，实现指数退避 + 最大重试次数，防止无限重试风暴
        let reconnectAttempt = 0;
        const MAX_RECONNECT_ATTEMPTS = 10;
        const scheduleReconnect = (attempt: number) => {
          if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            console.error('[Sync] Realtime 重连次数超限，放弃重连。请检查网络或 Supabase 状态。');
            return;
          }
          const delayMs = Math.min(3000 * Math.pow(2, attempt), 60_000); // 指数退避，上限 60s
          console.log(`[Sync] 安排第 ${attempt + 1} 次重连，延迟 ${delayMs}ms`);
          // BE-RL-02: 保存重连定时器引用，重连前 clearTimeout 防堆积
          if (reconnectTimer) { clearTimeout(reconnectTimer); }
          reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
              await setupRealtimeListener(sb, cfg, backendConfig);
              console.log('[Sync] Realtime 重连成功');
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn('[Sync] 重订阅失败，将重试:', msg);
              scheduleReconnect(attempt + 1);
            }
          }, delayMs);
        };
        scheduleReconnect(reconnectAttempt);
      }
    });

  setRealtimeChannel(realtimeChannel);

  console.log('[Sync] Realtime 监听已启动（监听所有 pending 远程命令 + 对话删除同步）');

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