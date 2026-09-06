import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { registerSyncConfigRoutes } from './sync-config.js';
import { setupRealtimeListener } from './realtime.js';
import { getSyncConfig, getSupabaseClient, setSupabaseClient, getRealtimeChannel, setRealtimeChannel } from './sync-config.js';

// ============================================================
// 统一路由注册入口（保持原有导出签名，供 app.ts 导入）
// ============================================================

export function registerSyncRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 先注册配置相关路由（会初始化 syncConfig）
  registerSyncConfigRoutes(app, config);

  // 如果已有配置，启动 Realtime 监听
  const syncConfig = getSyncConfig();
  if (syncConfig) {
    const sb = getSupabaseClient();
    if (sb) {
      setupRealtimeListener(sb, syncConfig, config).catch(() => {});
    }
  }

  // ============================================================
  // 前端轮询接口：按 commandId 查询命令状态（供 CodingHome 自动打开对话）
  // ============================================================
  app.get('/api/sync/command-status', {
    schema: { tags: ['同步'] },
  }, async (request, reply) => {
    const sb = getSupabaseClient();
    const syncConfig = getSyncConfig();
    if (!sb || !syncConfig) return reply.code(400).send({ error: '未配置同步' });

    const query = request.query as any;
    const commandId = query?.commandId;
    if (!commandId) return reply.code(400).send({ error: '缺少 commandId' });

    try {
      const { data } = await sb.from('remote_commands')
        .select('id, content, status, conversation_id, result_summary, error')
        .eq('id', commandId)
        .limit(1);

      if (data && data.length > 0) {
        const cmd = data[0];
        return {
          success: true,
          command: {
            id: cmd.id,
            content: cmd.content,
            status: cmd.status,
            conversationId: cmd.conversation_id,
            summary: cmd.result_summary,
            error: cmd.error,
          },
        };
      }
      return { success: true, command: null };
    } catch (e: unknown) {
      return reply.code(500).send({ error: `查询失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  // ============================================================
  // 前端轮询接口：获取最新的远程命令（供前端自动跳转聊天页）
  // 查 pending/processing 命令，也查最近 30 秒内 completed 的命令（防止 Realtime 处理太快 Layout 错过）
  // ============================================================
  let latestCommandId: string | null = null;

  app.get('/api/sync/latest-command', {
    schema: { tags: ['同步'] },
  }, async () => {
    const sb = getSupabaseClient();
    const syncConfig = getSyncConfig();
    if (!sb || !syncConfig) return { hasNew: false };

    try {
      // Q1 彻底修复：只轮询「未处理」的远程命令，且限制最近 5 分钟内创建的。
      // 防止 EXE 重启后，数小时前卡在 processing 的旧命令被误判为"新命令"，
      // 导致 Layout 端每次启动都跳回上次的远程对话而非新对话页。
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const thirtySecAgo = new Date(Date.now() - 30 * 1000).toISOString();
      const { data } = await sb.from('remote_commands')
        .select('id, content, status, conversation_id, created_at')
        .or(`status.in.(pending,processing),and(status.eq.completed,created_at.gte.${thirtySecAgo})`)
        .gte('created_at', fiveMinAgo)
        .order('created_at', { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        const cmd = data[0];
        // 仅当命令有 conversation_id 时才返回（确保对话已在本地 DB 存在，防止前端导航后找不到对话）
        if (cmd.id !== latestCommandId && cmd.conversation_id) {
          latestCommandId = cmd.id;
          return {
            hasNew: true,
            command: {
              id: cmd.id,
              content: cmd.content,
              status: cmd.status,
              conversationId: cmd.conversation_id,
              createdAt: cmd.created_at,
            },
          };
        }
      }
      return { hasNew: false };
    } catch {
      return { hasNew: false };
    }
  });
}

// Re-export all types and functions for external consumers
export type { SyncConfig, OwnershipFilters } from './sync-config.js';
export {
  loadSyncConfig,
  persistSyncConfig,
  getSyncConfig,
  setSyncConfig,
  getSupabaseClient,
  setSupabaseClient,
  getRealtimeChannel,
  setRealtimeChannel,
  getDeviceRegistered,
  setDeviceRegistered,
  getConfigFingerprint,
  setConfigFingerprint,
  registerDevice,
  syncConversationsToSupabase,
  registerSyncConfigRoutes,
  buildOwnershipFilters,
  computeConfigFingerprint,
  buildSyncResponse,
} from './sync-config.js';

export { setupRealtimeListener } from './realtime.js';

export { startPollingFallback, type PollingFallbackOptions, type PollingFallbackHandle } from './polling-fallback.js';

export { processRemoteCommand, syncAssistantError } from './command-processor.js';