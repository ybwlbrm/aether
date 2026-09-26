/**
 * Supabase 同步共享工具 — 供 conversations 模块和 sync 模块复用
 * 从 sync-config.json 读取配置，将本地对话/消息同步到 Supabase
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/client.js';
import { conversations, messages } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { logger } from './logger.js';

// ESM 环境手动声明 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SyncConfig {
  supabaseUrl: string;
  supabaseKey: string;
  deviceId: string;
  deviceName?: string;
  /** 关联的 Supabase Auth 用户 id（可选）。填写后桌面端主动同步的数据对手机端登录用户可见（RLS 行级隔离）。 */
  userId?: string;
}

let cachedSb: SupabaseClient | null = null;
let cachedConfig: SyncConfig | null = null;

/** 按 DATA_DIR 读取同步配置 */
function loadConfigFromDisk(): SyncConfig | null {
  const dataDir = process.env.DATA_DIR || resolve(__dirname, '..', '..', '..', '..', 'data');
  const path = resolve(dataDir, 'sync-config.json');
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e: unknown) {
    // AEX-P2-004 分类：intentional fallback —— sync-config.json 损坏时视为「未配置云同步」，
    // 返回 null 让功能整体保持关闭，而不是让后端启动失败。
    logger.warn({ event: 'sync.config_load_failed', err: e, path }, '云同步配置文件损坏，视为未配置');
  }
  return null;
}

/** 获取 Supabase 客户端（懒加载） */
export function getSyncClient(sbOverride?: SupabaseClient): { sb: SupabaseClient | null; cfg: SyncConfig | null } {
  if (sbOverride) {
    const cfg = loadConfigFromDisk();
    return { sb: sbOverride, cfg };
  }
  if (cachedSb && cachedConfig) return { sb: cachedSb, cfg: cachedConfig };
  const cfg = loadConfigFromDisk();
  if (!cfg?.supabaseUrl || !cfg?.supabaseKey) return { sb: null, cfg: null };
  const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey);
  cachedSb = sb;
  cachedConfig = cfg;
  return { sb, cfg };
}

/** 确保设备已注册（外键依赖） */
export async function ensureDeviceRegistered(sb: SupabaseClient, cfg: SyncConfig): Promise<void> {
  try {
    await sb.from('devices').upsert({
      id: cfg.deviceId,
      user_id: cfg.userId ?? null,
      name: cfg.deviceName || 'Aether 桌面端',
      type: 'desktop',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e: unknown) {
    // AEX-P2-004 分类：recoverable —— 设备注册是同步的前置外键步骤，
    // 网络/RLS 异常时记录并继续，后续 upsert 会自行暴露问题，不阻断调用方。
    logger.warn({ event: 'sync.device_register_failed', err: e, deviceId: cfg.deviceId }, '云端设备注册失败');
  }
}

/** 同步一条对话 + 全部消息到 Supabase */
export async function syncConversationToSupabase(convId: string, sbOverride?: SupabaseClient): Promise<void> {
  const { sb, cfg } = getSyncClient(sbOverride);
  if (!sb || !cfg) return;
  const db = getDb();

  try {
    const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get();
    if (!conv) return;

    await ensureDeviceRegistered(sb, cfg);

    const msgs = db.select().from(messages).where(eq(messages.conversationId, convId)).all();

    await sb.from('conversations_sync').upsert({
      id: conv.id,
      device_id: cfg.deviceId,
      user_id: cfg.userId ?? null,
      title: conv.title,
      model: conv.model,
      message_count: msgs.length,
      created_at: conv.createdAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    for (const m of msgs) {
      await sb.from('messages_sync').upsert({
        id: m.id,
        conversation_id: m.conversationId,
        device_id: cfg.deviceId,
        user_id: cfg.userId ?? null,
        role: m.role,
        content: m.content,
        tool_calls: m.toolCalls,
        tool_results: m.toolResults,
        created_at: m.createdAt,
      }, { onConflict: 'id' });
    }
  } catch (e: unknown) {
    // AEX-P2-004 分类：recoverable —— 云同步是可选旁路，失败绝不阻塞本地对话主流程。
    logger.warn({ event: 'sync.conversation_sync_failed', err: e, convId }, '云同步对话失败，已忽略（本地数据为准）');
  }
}

/** 同步单条消息到 Supabase + 更新 conversations_sync */
export async function syncMessageToSupabase(
  convId: string,
  msg: { id: string; role: string; content: string; toolCalls?: string | null; toolResults?: string | null; createdAt?: string },
  sbOverride?: SupabaseClient,
): Promise<void> {
  const { sb, cfg } = getSyncClient(sbOverride);
  if (!sb || !cfg) return;

  try {
    await ensureDeviceRegistered(sb, cfg);
    await sb.from('messages_sync').upsert({
      id: msg.id,
      conversation_id: convId,
      device_id: cfg.deviceId,
      user_id: cfg.userId ?? null,
      role: msg.role,
      content: msg.content,
      tool_calls: msg.toolCalls || null,
      tool_results: msg.toolResults || null,
      created_at: msg.createdAt || new Date().toISOString(),
    }, { onConflict: 'id' });

    // 更新对话统计
    const db = getDb();
    const count = db.select().from(messages).where(eq(messages.conversationId, convId)).all().length;
    await sb.from('conversations_sync').update({
      message_count: count,
      updated_at: new Date().toISOString(),
    }).eq('id', convId);
  } catch (e: unknown) {
    // AEX-P2-004 分类：recoverable —— 同上：消息同步失败不阻塞本地流程。
    logger.warn({ event: 'sync.message_sync_failed', err: e, convId, messageId: msg.id }, '云同步消息失败，已忽略（本地数据为准）');
  }
}