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

// ESM 环境手动声明 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SyncConfig {
  supabaseUrl: string;
  supabaseKey: string;
  deviceId: string;
  deviceName?: string;
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
  } catch { /* ignore */ }
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
      name: cfg.deviceName || 'Aether 桌面端',
      type: 'desktop',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch { /* ignore */ }
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
        role: m.role,
        content: m.content,
        tool_calls: m.toolCalls,
        tool_results: m.toolResults,
        created_at: m.createdAt,
      }, { onConflict: 'id' });
    }
  } catch { /* 同步失败不阻塞主流程 */ }
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
  } catch { /* 同步失败不阻塞 */ }
}