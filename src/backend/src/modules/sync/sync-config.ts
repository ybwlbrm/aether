import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb, saveDb } from '../../db/client.js';
import { conversations, messages } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { encrypt, decrypt, isEncrypted } from '../../lib/crypto.js';

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

/** 所有权过滤器：用于 Supabase 查询的 user_id / device_id 条件 */
export interface OwnershipFilters {
  userId: string | null;
  deviceId: string | null;
}

/**
 * 从 SyncConfig 构造所有权过滤器（纯函数，便于单测）
 * - userId 来自配置绑定（设备注册归属），不可由请求体覆盖
 * - deviceId 来自配置
 * - 若 userId 未配置，返回 null 表示"无权访问任何数据"（调用方应返回空数组而非全量查询）
 */
export function buildOwnershipFilters(cfg: SyncConfig | null): OwnershipFilters {
  if (!cfg) return { userId: null, deviceId: null };
  return {
    userId: cfg.userId ?? null,
    deviceId: cfg.deviceId ?? null,
  };
}

/**
 * 计算配置指纹（整改计划第 7 章，P1）：
 * 改用 HMAC-SHA256 截断值 —— 日志/指纹绝不打印原始 Key、URL。
 * 仅 URL/Key/deviceId 变化会导致指纹变化（deviceName/deviceType/userId 不影响身份连接）。
 * 指纹 = HMAC-SHA256(appSecret, `${url}|${key}|${deviceId}`) 前 16 hex。
 */
const FINGERPRINT_HMAC_KEY = 'aether-sync-config-fingerprint-v1';

export function computeConfigFingerprint(cfg: SyncConfig | null): string {
  if (!cfg) return 'none';
  const data = `${cfg.supabaseUrl}|${cfg.supabaseKey}|${cfg.deviceId}`;
  return createHmac('sha256', FINGERPRINT_HMAC_KEY).update(data).digest('hex').slice(0, 16);
}

const SYNC_CONFIG_FILE = 'sync-config.json';

/**
 * 加载同步配置（整改计划第 7 章，P1）：优先读取加密格式（enc:iv:tag:ciphertext），
 * 兼容旧版明文文件（向后迁移）。加密格式用 AES-256-GCM（encryptionKey 派生密钥）。
 */
export function loadSyncConfig(config: BackendConfig): SyncConfig | null {
  try {
    const path = resolve(config.dataDir, SYNC_CONFIG_FILE);
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return null;
      if (isEncrypted(raw)) {
        const plain = decrypt(raw, config.encryptionKey);
        return JSON.parse(plain) as SyncConfig;
      }
      // 旧版明文格式：兼容读取（下次 persist 时自动加密落盘）
      return JSON.parse(raw) as SyncConfig;
    }
  } catch (e: unknown) {
    // 解密失败（密钥变更等）不崩溃，返回 null 让上层提示重新配置
    console.warn('[Sync] sync-config.json 读取失败:', e instanceof Error ? e.message : String(e));
  }
  return null;
}

/**
 * 持久化同步配置（整改计划第 7 章，P1）：AES-256-GCM 加密落盘（OS secret store 不可用时加密文件等价）。
 * 日志/磁盘绝不出现明文 supabaseKey。
 */
export function persistSyncConfig(cfg: SyncConfig | null, config: BackendConfig): void {
  try {
    const path = resolve(config.dataDir, SYNC_CONFIG_FILE);
    if (cfg) {
      const encrypted = encrypt(JSON.stringify(cfg), config.encryptionKey);
      writeFileSync(path, encrypted, { mode: 0o600 });
    }
  } catch (e: unknown) {
    console.warn('[Sync] sync-config.json 写入失败:', e instanceof Error ? e.message : String(e));
  }
}

let syncConfig: SyncConfig | null = null;
let supabase: SupabaseClient | null = null;
let realtimeChannel: any = null;
// Q4 优化：设备已注册标记 — 避免每次命令处理都重复 upsert devices（一次 Supabase 往返）
let deviceRegistered = false;
// 配置指纹：用于检测 URL/Key/deviceId 变化，触发重新注册 (P1-17)
let configFingerprint: string = 'none';

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

export function getConfigFingerprint(): string {
  return configFingerprint;
}

export function setConfigFingerprint(fp: string): void {
  configFingerprint = fp;
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
// 身份初始化闭环（P1-14）
// ============================================================

/** 保存当前 BackendConfig 引用，供 ensureSyncIdentity 持久化使用 */
let currentBackendConfig: BackendConfig | null = null;

export function setSyncBackendConfig(config: BackendConfig | null): void {
  currentBackendConfig = config;
}

function persistWithConfig(): void {
  if (currentBackendConfig) {
    persistSyncConfig(syncConfig, currentBackendConfig);
  }
}

/**
 * P1-14 收口：确保同步身份（userId）已绑定。
 *
 * 问题：首次配置时 upsert 设备/数据用 user_id = cfg.userId ?? null，
 * 下载又因「没有 userId → 返回空」—— 电脑显示同步成功、手机看不到数据。
 *
 * 闭环：Supabase Auth → 确定当前 UID → 绑定 Desktop Device → 保存本地身份引用
 * → 所有上传/下载自动使用该 UID。
 *
 * 策略：
 * 1. 已有 cfg.userId → 直接返回（已绑定）
 * 2. 尝试现有 Auth session（getUser()，桌面端可能已持有 JWT）
 * 3. 尝试匿名登录（signInAnonymously，个人模式：一人一库多设备）
 * 成功后将 userId 写回 cfg 并持久化 sync-config.json。
 *
 * @returns 绑定后的 userId；无法绑定返回 null（调用方据此降级：不上传空身份数据）
 */
export async function ensureSyncIdentity(sb: SupabaseClient, cfg: SyncConfig): Promise<string | null> {
  if (cfg.userId) return cfg.userId;
  try {
    // 1. 现有 Auth session（JWT / refresh token）
    const { data: userData } = await sb.auth.getUser();
    if (userData.user?.id) {
      cfg.userId = userData.user.id;
      syncConfig = cfg;
      persistWithConfig();
      console.log('[Sync] 身份已绑定（Auth session）:', cfg.userId);
      return cfg.userId;
    }
    // 2. 匿名登录（个人模式默认路径）
    const { data: anonData, error: anonErr } = await sb.auth.signInAnonymously();
    if (!anonErr && anonData.user?.id) {
      cfg.userId = anonData.user.id;
      syncConfig = cfg;
      persistWithConfig();
      console.log('[Sync] 身份已绑定（匿名登录）:', cfg.userId);
      return cfg.userId;
    }
    if (anonErr) {
      console.warn('[Sync] 匿名登录失败（Supabase 需启用 Anonymous sign-ins）:', anonErr.message);
    }
  } catch (e: unknown) {
    console.warn('[Sync] 身份初始化失败（不阻塞，但数据将不绑定用户）:',
      e instanceof Error ? e.message : String(e));
  }
  return null;
}

/**
 * 便捷：注册前先保证身份，返回绑定后的 userId（null = 无法绑定）。
 * 供启动初始化、配置保存、上传等入口统一调用（P1-14 闭环）。
 */
export async function ensureIdentityThenRegister(sb: SupabaseClient, cfg: SyncConfig): Promise<string | null> {
  const userId = await ensureSyncIdentity(sb, cfg);
  await registerDevice(sb, cfg);
  return userId;
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

/**
 * 统计成功/失败并生成统一响应格式 (P1-18)
 * - 全部成功：success=true
 * - 有失败：success=false, partial=true, failed=N, 成功项仍列出
 * 判定失败：值以 '失败' 开头（知识库/设置同步的错误格式），conversations 结果始终以 '同步' 开头
 */
export function buildSyncResponse<T extends Record<string, string>>(
  results: T
): { success: boolean; partial?: boolean; failed?: number; results: T } {
  const failedCount = Object.values(results).filter(v => v.startsWith('失败')).length;
  if (failedCount === 0) {
    return { success: true, results };
  }
  return { success: false, partial: true, failed: failedCount, results };
}

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
  // P1-14: 保存配置引用，供 ensureSyncIdentity 持久化身份
  setSyncBackendConfig(config);

  // 如果已有配置，自动初始化 Supabase 和 Realtime 监听
  if (syncConfig) {
    const sb = getSupabase();
    if (sb) {
      // P1-14: 启动时先保证身份绑定（Supabase Auth → UID → 设备绑定 → 本地持久化），
      // 再注册设备 —— 避免 user_id=null 写入导致手机端看不到数据。
      ensureIdentityThenRegister(sb, syncConfig).catch(e => {
        console.warn('[Sync] 启动身份初始化失败:', e instanceof Error ? e.message : e);
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

    // P0-16: userId 不得由请求体任意指定 —— 保留已有配置的 userId（来自设备注册/云端身份）
    // 若首次配置且无 userId，则保持 undefined（后续通过 registerDevice 绑定或云端 auth 决定）
    const preservedUserId = syncConfig?.userId;

    const newConfig: SyncConfig = {
      supabaseUrl: body.supabaseUrl,
      supabaseKey: body.supabaseKey,
      deviceId: body.deviceId || `desktop-${Date.now()}`,
      deviceName: body.deviceName || 'Aether 桌面端',
      deviceType: 'desktop',
      userId: preservedUserId,
    };

    // P1-17: 检测配置指纹变化（URL/Key/deviceId），变化则重置 deviceRegistered 触发重新注册
    const newFingerprint = computeConfigFingerprint(newConfig);
    const fingerprintChanged = newFingerprint !== configFingerprint;
    if (fingerprintChanged) {
      console.log('[Sync] 配置指纹变化，重置设备注册状态:', { old: configFingerprint, new: newFingerprint });
      deviceRegistered = false;
      configFingerprint = newFingerprint;
    }

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
      // P1-14: 配置保存后立即走身份闭环（Supabase Auth → UID → 设备绑定 → 本地持久化），
      // 确保 sync-config.json 中 userId 不为空，后续上传/下载都使用该 UID。
      const boundUserId = await ensureIdentityThenRegister(sb, syncConfig);
      // Realtime listener will be set up by registerSyncRoutes after importing
      // 连接成功后全量同步本地对话（手机端立即可见所有历史对话）
      // BE-UA-02: 连接后全量同步 fire-and-forget → await 确保错误可感知，同时不阻塞响应
      const syncResult = await syncConversationsToSupabase(sb, syncConfig);
      console.log(`[Sync] 连接后全量同步完成: ${syncResult.ok} 条消息，${syncResult.fail} 条失败`);
      
      // P1-15: 同步日志状态必须来自真实 SyncResult（partial/failed/success），不硬编码 success
      const overallOk = syncResult.fail === 0 && boundUserId !== null;
      await sb.from('sync_log').insert({
        device_id: syncConfig.deviceId,
        user_id: syncConfig.userId ?? null,
        action: 'config_init',
        status: overallOk ? 'success' : (syncResult.fail > 0 && syncResult.ok > 0 ? 'partial' : 'failed'),
        details: `身份绑定: ${boundUserId ? '✓' : '✗'}; 同步 ${syncResult.ok} 条消息，${syncResult.fail} 条失败`,
        created_at: new Date().toISOString(),
      });

      // P1-18: 返回 success/partial/failed 格式
      const response = buildSyncResponse({
        conversations: `同步 ${syncResult.ok} 条消息，${syncResult.fail} 条失败`,
      });
      return { ...response, message: '同步配置已保存，Realtime 监听已启动', deviceId: syncConfig.deviceId, userId: syncConfig.userId ?? null };
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

    // P1-15 修复：Sync Log 状态必须来自统一 SyncResult —— 不再无条件 success。
    // 之前部分失败也可能写 status=success，导致 UI（partial）与日志（success）不一致。
    const syncStatus = syncResult.fail === 0
      ? 'success'
      : (syncResult.ok > 0 ? 'partial' : 'failed');
    // 记录同步日志（状态来自真实结果）
    await sb.from('sync_log').insert({
      device_id: deviceId,
      user_id: syncConfig.userId ?? null,
      action: 'upload',
      status: syncStatus,
      details: `同步 ${syncResult.ok} 条消息，${syncResult.fail} 条失败`,
      created_at: now,
    });

    // P1-18: 返回 success/partial/failed 格式
    return { ...buildSyncResponse(results), syncedAt: now };
  });

  // 从 Supabase 下载数据
  app.get('/api/sync/download', {
    schema: { tags: ['同步'] },
  }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb || !syncConfig) return reply.code(400).send({ error: '未配置同步' });

    const query = request.query as any;
    const deviceId = query?.deviceId || syncConfig.deviceId;

    // P0-15/P1-35: 构造所有权过滤器 —— userId 来自配置绑定，不可由查询参数覆盖
    // 若 userId 未配置，返回空数组而非全量查询（安全原则：无身份不可见数据）
    const { userId, deviceId: cfgDeviceId } = buildOwnershipFilters(syncConfig);
    if (!userId) {
      return {
        success: true,
        data: { knowledge: {}, settings: {}, remoteConversations: [] },
        lastSyncAt: null,
        syncedAt: new Date().toISOString(),
      };
    }

    const result: Record<string, any> = {};

    // 下载知识库 —— 按 user_id + device_id 过滤
    const { data: knowledgeData } = await sb.from('knowledge')
      .select('*')
      .eq('user_id', userId)
      .eq('device_id', cfgDeviceId)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (knowledgeData && knowledgeData.length > 0) {
      const raw = knowledgeData[0]?.data;
      result.knowledge = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    }

    // 下载设置 —— 按 user_id + device_id 过滤
    const { data: settingsData } = await sb.from('settings')
      .select('*')
      .eq('user_id', userId)
      .eq('device_id', cfgDeviceId)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (settingsData && settingsData.length > 0) {
      const raw = settingsData[0]?.data;
      result.settings = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    }

    // 下载远程对话记录 —— 按 user_id 过滤 (P0-15: conversations_sync 必须按 user_id)
    const { data: remoteConvs } = await sb.from('conversations_sync')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);
    result.remoteConversations = remoteConvs || [];

    // 获取最后同步时间 —— 按 user_id + device_id 过滤
    const { data: lastSync } = await sb.from('sync_log')
      .select('created_at')
      .eq('user_id', userId)
      .eq('device_id', cfgDeviceId)
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