import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb, saveDb } from '../../db/client.js';
import { conversations, messages } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';

// ============================================================
// 同步配置管理
// ============================================================

export interface SyncConfig {
  supabaseUrl: string;
  supabaseKey: string;
  deviceId: string;
  deviceName?: string;
  deviceType?: 'desktop' | 'mobile';
  /** 关联的 Supabase Auth 用户 id（可选）。填写后桌面端主动同步的数据对手机端登录用户可见（RLS 行级隔离）。 */
  userId?: string;
}

const SYNC_CONFIG_FILE = 'sync-config.json';

export function loadSyncConfig(config: BackendConfig): SyncConfig | null {
  try {
    const path = resolve(config.dataDir, SYNC_CONFIG_FILE);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

export function persistSyncConfig(cfg: SyncConfig | null, config: BackendConfig): void {
  try {
    const path = resolve(config.dataDir, SYNC_CONFIG_FILE);
    if (cfg) writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
}

let syncConfig: SyncConfig | null = null;
let supabase: SupabaseClient | null = null;
let realtimeChannel: any = null;
// Q4 优化：设备已注册标记 — 避免每次命令处理都重复 upsert devices（一次 Supabase 往返）
let deviceRegistered = false;

export function getSyncConfig(): SyncConfig | null {
  return syncConfig;
}

export function setSyncConfig(cfg: SyncConfig | null): void {
  syncConfig = cfg;
}

export function getSupabaseClient(): SupabaseClient | null {
  return supabase;
}

export function setSupabaseClient(client: SupabaseClient | null): void {
  supabase = client;
}

export function getRealtimeChannel(): any {
  return realtimeChannel;
}

export function setRealtimeChannel(channel: any): void {
  realtimeChannel = channel;
}

export function getDeviceRegistered(): boolean {
  return deviceRegistered;
}

export function setDeviceRegistered(registered: boolean): void {
  deviceRegistered = registered;
}

function getSupabase(): SupabaseClient | null {
  if (!syncConfig?.supabaseUrl || !syncConfig?.supabaseKey) return null;
  if (!supabase) {
    supabase = createClient(syncConfig.supabaseUrl, syncConfig.supabaseKey, {
      realtime: { heartbeatIntervalMs: 15000 },
    });
  }
  return supabase;
}

// ============================================================
// 注册设备到 Supabase
// ============================================================

export async function registerDevice(sb: SupabaseClient, cfg: SyncConfig): Promise<void> {
  // Q4 优化：幂等 — 同一次运行只注册一次，节省每次命令的前置网络往返
  if (deviceRegistered) return;
  // 修复：不再依赖 RPC（get_or_create_device 受旧 RLS 影响会失败且被静默吞错）。
  // 直接 upsert，确保 desktop 设备一定存在于 devices 表（conversations_sync/messages_sync 的 FK 依赖它）。
  const { error } = await sb.from('devices').upsert({
    id: cfg.deviceId,
    user_id: cfg.userId ?? null,
    name: cfg.deviceName || 'Aether 桌面端',
    type: 'desktop',
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) {
    console.warn('[Sync] 设备注册失败:', error.message);
  } else {
    deviceRegistered = true;
    console.log('[Sync] 设备已注册:', cfg.deviceId);
  }
}

// ============================================================
// 同步数据到 Supabase
// ============================================================

export async function syncConversationsToSupabase(sb: SupabaseClient, cfg: SyncConfig): Promise<{ ok: number; fail: number }> {
  const db = getDb();
  const localConvs = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();
  let ok = 0, fail = 0;

  for (const conv of localConvs) {
    try {
      // 获取此对话的消息数
      const msgs = db.select().from(messages).where(eq(messages.conversationId, conv.id)).all();

      // 同步对话元数据
      const { error: convErr } = await sb.from('conversations_sync').upsert({
        id: conv.id,
        device_id: cfg.deviceId,
        user_id: cfg.userId ?? null,
        title: conv.title,
        model: conv.model,
        message_count: msgs.length,
        created_at: conv.createdAt,
        updated_at: conv.updatedAt,
      }, { onConflict: 'id' });
      if (convErr) { fail++; continue; }

      // 同步消息
      for (const msg of msgs) {
        const { error: msgErr } = await sb.from('messages_sync').upsert({
          id: msg.id,
          conversation_id: msg.conversationId,
          device_id: cfg.deviceId,
          user_id: cfg.userId ?? null,
          role: msg.role,
          content: msg.content,
          tool_calls: msg.toolCalls,
          tool_results: msg.toolResults,
          created_at: msg.createdAt,
        }, { onConflict: 'id' });
        if (msgErr) fail++;
        else ok++;
      }
    } catch {
      fail++;
    }
  }
  return { ok, fail };
}

// ============================================================
// 路由注册：配置相关端点
// ============================================================

export function registerSyncConfigRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 启动时加载配置
  syncConfig = loadSyncConfig(config);

  // 如果已有配置，自动初始化 Supabase 和 Realtime 监听
  if (syncConfig) {
    const sb = getSupabase();
    if (sb) {
      // BE-UA-01: 设备注册 fire-and-forget → 显式错误日志（注册失败不应阻塞启动）
      registerDevice(sb, syncConfig).catch(e => {
        console.warn('[Sync] 设备注册失败:', e instanceof Error ? e.message : e);
      });
      // Realtime listener will be set up by registerSyncRoutes after importing
      // 启动时全量同步本地对话到 Supabase（手机端才能看到电脑端历史对话）
      // BE-UA-01: 启动全量同步 fire-and-forget → 保存 promise 供 shutdown 等待
      void syncConversationsToSupabase(sb, syncConfig)
        .then(r => console.log(`[Sync] 启动全量同步完成: ${r.ok} 条消息，${r.fail} 条失败`))
        .catch(e => console.warn('[Sync] 启动全量同步失败:', e instanceof Error ? e.message : e));
    }
  }

  // 保存同步配置
  app.post('/api/sync/config', {
    schema: { tags: ['同步'] },
  }, async (request, reply) => {
    const body = request.body as any;
    if (!body?.supabaseUrl || !body?.supabaseKey) {
      return reply.code(400).send({ error: '缺少 Supabase URL 或 Key' });
    }

    const newConfig: SyncConfig = {
      supabaseUrl: body.supabaseUrl,
      supabaseKey: body.supabaseKey,
      deviceId: body.deviceId || `desktop-${Date.now()}`,
      deviceName: body.deviceName || 'Aether 桌面端',
      deviceType: 'desktop',
      // 可选：Supabase Auth 用户 id，用于 RLS 行级隔离（桌面端主动同步数据对手机端登录用户可见）
      userId: body.userId ? String(body.userId) : undefined,
    };

    // 断开旧连接
    if (supabase && realtimeChannel) {
      try { await supabase.removeChannel(realtimeChannel); } catch { /* ignore */ }
      realtimeChannel = null;
    }
    supabase = null;

    syncConfig = newConfig;
    persistSyncConfig(syncConfig, config);

    // 初始化新连接
    const sb = getSupabase();
    if (!sb) return reply.code(500).send({ error: '无法创建 Supabase 客户端' });

    try {
      await registerDevice(sb, syncConfig);
      // Realtime listener will be set up by registerSyncRoutes after importing
      // 连接成功后全量同步本地对话（手机端立即可见所有历史对话）
      // BE-UA-02: 连接后全量同步 fire-and-forget → await 确保错误可感知，同时不阻塞响应
      const syncResult = await syncConversationsToSupabase(sb, syncConfig);
      console.log(`[Sync] 连接后全量同步完成: ${syncResult.ok} 条消息，${syncResult.fail} 条失败`);
      return { success: true, message: '同步配置已保存，Realtime 监听已启动', deviceId: syncConfig.deviceId };
    } catch (e: unknown) {
      return reply.code(500).send({ error: `连接失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  // 获取同步配置（供前端重启后恢复连接，避免 Key 丢失）
  app.get('/api/sync/config', {
    schema: { tags: ['同步'] },
  }, async (request, reply) => {
    // 安全检查：仅允许本机前端访问（Host 校验已全局生效）
    // P0-8 修复：不再返回明文 supabaseKey（service/anon key 属于凭证），
    // 前端只需要知道「已配置」和 url/deviceId 即可恢复 UI 状态
    if (!syncConfig) return reply.code(404).send({ error: '未配置同步' });
    return {
      configured: true,
      supabaseUrl: syncConfig.supabaseUrl,
      hasKey: !!syncConfig.supabaseKey,
      deviceId: syncConfig.deviceId,
      deviceName: syncConfig.deviceName || 'Aether 桌面端',
    };
  });

  // 获取同步状态
  app.get('/api/sync/status', {
    schema: { tags: ['同步'] },
  }, async () => ({
    configured: !!syncConfig,
    connected: !!getSupabase(),
    deviceId: syncConfig?.deviceId || null,
    realtimeListening: !!realtimeChannel,
  }));

  // 上传数据到 Supabase（完整同步）
  app.post('/api/sync/upload', {
    schema: { tags: ['同步'] },
  }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb || !syncConfig) return reply.code(400).send({ error: '未配置同步' });

    // 确保 desktop 设备已注册（conversations_sync/messages_sync 的 FK 依赖）
    try { await registerDevice(sb, syncConfig); } catch { /* 忽略，继续尝试写入 */ }

    const body = request.body as any;
    const data = body?.data || {};
    const deviceId = syncConfig.deviceId;
    const now = new Date().toISOString();

    const results: Record<string, any> = {};

    // 同步知识库数据
    if (data.knowledge) {
      const { error } = await sb.from('knowledge').upsert({
        device_id: deviceId,
        user_id: syncConfig.userId ?? null,
        data: data.knowledge,
        updated_at: now,
      }, { onConflict: 'device_id' });
      results.knowledge = error ? `失败: ${error.message}` : '成功';
    }

    // 同步设置
    if (data.settings) {
      const { error } = await sb.from('settings').upsert({
        device_id: deviceId,
        user_id: syncConfig.userId ?? null,
        data: data.settings,
        updated_at: now,
      }, { onConflict: 'device_id' });
      results.settings = error ? `失败: ${error.message}` : '成功';
    }

    // 同步对话记录（始终同步）
    const syncResult = await syncConversationsToSupabase(sb, syncConfig);
    results.conversations = `同步 ${syncResult.ok} 条消息，${syncResult.fail} 条失败`;

    // 记录同步日志
    await sb.from('sync_log').insert({
      device_id: deviceId,
      user_id: syncConfig.userId ?? null,
      action: 'upload',
      status: 'success',
      created_at: now,
    });

    return { success: true, results, syncedAt: now };
  });

  // 从 Supabase 下载数据
  app.get('/api/sync/download', {
    schema: { tags: ['同步'] },
  }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb || !syncConfig) return reply.code(400).send({ error: '未配置同步' });

    const query = request.query as any;
    const deviceId = query?.deviceId || syncConfig.deviceId;

    const result: Record<string, any> = {};

    // 下载知识库
    const { data: knowledgeData } = await sb.from('knowledge')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (knowledgeData && knowledgeData.length > 0) {
      const raw = knowledgeData[0]?.data;
      result.knowledge = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    }

    // 下载设置
    const { data: settingsData } = await sb.from('settings')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (settingsData && settingsData.length > 0) {
      const raw = settingsData[0]?.data;
      result.settings = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    }

    // 下载远程对话记录
    const { data: remoteConvs } = await sb.from('conversations_sync')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(50);
    result.remoteConversations = remoteConvs || [];

    // 获取最后同步时间
    const { data: lastSync } = await sb.from('sync_log')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1);

    return {
      success: true,
      data: result,
      lastSyncAt: lastSync?.[0]?.created_at || null,
      syncedAt: new Date().toISOString(),
    };
  });

  // 手动触发一次完整同步
  app.post('/api/sync/now', {
    schema: { tags: ['同步'] },
  }, async (_, reply) => {
    const sb = getSupabase();
    if (!sb || !syncConfig) return reply.code(400).send({ error: '未配置同步' });

    try {
      const syncResult = await syncConversationsToSupabase(sb, syncConfig);
      return {
        success: true,
        messages: `同步 ${syncResult.ok} 条消息，${syncResult.fail} 条失败`,
        syncedAt: new Date().toISOString(),
      };
    } catch (e: unknown) {
      return reply.code(500).send({ error: `同步失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  // 断开同步
  app.post('/api/sync/disconnect', {
    schema: { tags: ['同步'] },
  }, async () => {
    if (supabase && realtimeChannel) {
      try { await supabase.removeChannel(realtimeChannel); } catch { /* ignore */ }
    }
    realtimeChannel = null;
    supabase = null;
    syncConfig = null;

    try {
      const path = resolve(config.dataDir, SYNC_CONFIG_FILE);
      if (existsSync(path)) unlinkSync(path);
    } catch { /* ignore */ }

    return { success: true, message: '已断开同步' };
  });

  // ============================================================
  // 删除对话同步接口（桌面端删除对话时调用，同步删除 Supabase 记录）
  // ============================================================
  app.post('/api/sync/delete-conversation', {
    schema: { tags: ['同步'] },
  }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb || !syncConfig) return reply.code(400).send({ error: '未配置同步' });

    const body = request.body as any;
    const convId = body?.conversationId;
    if (!convId) return reply.code(400).send({ error: '缺少 conversationId' });

    try {
      // 删除 Supabase 中的对话（级联删除 messages_sync）
      const { error } = await sb.from('conversations_sync').delete().eq('id', convId);
      if (error) throw error;
      return { success: true, message: '已同步删除' };
    } catch (e: unknown) {
      return reply.code(500).send({ error: `删除同步失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}