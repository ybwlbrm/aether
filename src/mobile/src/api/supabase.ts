import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';

// ============================================================
// Supabase 客户端管理
// URL 与设备 ID 存储在 localStorage；Key 仅保存在内存中（MOB-01 修复）。
//
// 安全设计（2026-08-29）：
// - service_role key 不再持久化到 localStorage —— 应用重启后需重新输入，
//   消除设备丢失/备份/WebView 提取静态密钥的风险。
// - 移动端以 Supabase 作为手机↔桌面端的中继（远程命令/会话同步走云端），
//   无法依赖与桌面端同网段，因此不采用「桌面后端代理」方案。
// - 后续服务端加固方向：Supabase 项目侧启用 anon key + RLS 行级安全策略
//   （需在 Supabase 控制台配置策略 SQL，超出客户端代码范围）。
// ============================================================

interface SyncConfig {
  supabaseUrl: string;
  supabaseKey: string;
  deviceId: string;
  deviceName?: string;
}

let sbClient: SupabaseClient | null = null;
let currentConfig: SyncConfig | null = null;
let messagesChannel: RealtimeChannel | null = null;
let conversationsChannel: RealtimeChannel | null = null;
/** 密钥仅存内存，不落盘（MOB-01） */
let memoryKey: string | null = null;

// 回调类型
type MessageCallback = (payload: any) => void;
type ConversationCallback = (payload: any) => void;

let onMessageCb: MessageCallback | null = null;
let onConversationCb: ConversationCallback | null = null;

/** 获取或创建设备 ID */
function getDeviceId(): string {
  let id = localStorage.getItem('aether_device_id');
  if (!id) {
    id = 'mobile-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('aether_device_id', id);
  }
  return id;
}

/** 保存配置（URL 持久化；Key 仅存内存，重启 App 需重新输入） */
export function saveConfig(url: string, key: string): void {
  localStorage.setItem('aether_supabase_url', url);
  memoryKey = key;
}

/** 加载配置（Key 取自内存；无内存密钥返回 null） */
export function loadConfig(): SyncConfig | null {
  const url = localStorage.getItem('aether_supabase_url');
  if (!url || !memoryKey) return null;
  return {
    supabaseUrl: url,
    supabaseKey: memoryKey,
    deviceId: getDeviceId(),
    deviceName: 'Aether 手机端',
  };
}

/** 检查是否已配置（URL 落盘 + Key 在内存） */
export function isConfigured(): boolean {
  return !!localStorage.getItem('aether_supabase_url') && !!memoryKey;
}

/** 读取已持久化的 URL（供重启后预填表单） */
export function getStoredUrl(): string | null {
  return localStorage.getItem('aether_supabase_url');
}

/** 获取 Supabase 客户端 */
export function getClient(): SupabaseClient | null {
  const cfg = loadConfig();
  if (!cfg) return null;
  if (!sbClient || currentConfig?.supabaseUrl !== cfg.supabaseUrl) {
    sbClient = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      realtime: { heartbeatIntervalMs: 15000 },
    });
    currentConfig = cfg;
  }
  return sbClient;
}

/** 注册设备到 Supabase */
export async function registerDevice(): Promise<boolean> {
  const sb = getClient();
  const cfg = loadConfig();
  if (!sb || !cfg) return false;
  try {
    await sb.from('devices').upsert({
      id: cfg.deviceId,
      name: cfg.deviceName || 'Aether 手机端',
      type: 'mobile',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    return true;
  } catch {
    return false;
  }
}

/** 获取对话列表 */
export async function getConversations(): Promise<any[]> {
  const sb = getClient();
  if (!sb) return [];
  const { data } = await sb
    .from('conversations_sync')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(50);
  return data || [];
}

/** 获取对话消息 */
export async function getMessages(conversationId: string): Promise<any[]> {
  const sb = getClient();
  if (!sb) return [];
  const { data } = await sb
    .from('messages_sync')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  return data || [];
}

/** 发送远程命令 */
export async function sendCommand(content: string, conversationId?: string): Promise<boolean> {
  const sb = getClient();
  const cfg = loadConfig();
  if (!sb || !cfg) return false;
  try {
    const { error } = await sb.from('remote_commands').insert({
      device_id: cfg.deviceId,
      conversation_id: conversationId || null,
      content,
      status: 'pending',
    });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('发送命令失败:', e);
    return false;
  }
}

/** 上传文件到 Supabase Storage，返回公开 URL */
export async function uploadFile(file: File, bucket: string = 'chat-files'): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const fileName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { data, error } = await sb.storage.from(bucket).upload(fileName, file, {
      cacheControl: '3600',
      upsert: false,
    });
    if (error) throw error;
    const { data: urlData } = sb.storage.from(bucket).getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (e) {
    console.error('上传文件失败:', e);
    return null;
  }
}

/** 删除对话（从 Supabase 级联删除，手机端+电脑端双向同步） */
export async function deleteConversation(convId: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    // 级联删除（messages_sync 有 ON DELETE CASCADE）
    const { error } = await sb.from('conversations_sync').delete().eq('id', convId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('删除对话失败:', e);
    return false;
  }
}

/** 订阅消息更新（Realtime — 支持流式 INSERT 和 UPDATE） */
export function subscribeMessages(
  conversationId: string,
  callback: MessageCallback,
): () => void {
  const sb = getClient();
  if (!sb) return () => {};

  onMessageCb = callback;

  if (messagesChannel) {
    sb.removeChannel(messagesChannel).catch(() => {});
  }

  messagesChannel = sb.channel(`messages-${conversationId}`)
    .on('postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages_sync',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload: any) => {
        callback(payload.new);
      },
    )
    .on('postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages_sync',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload: any) => {
        // 流式更新：后端逐块 upsert 同一消息，内容逐渐增长
        callback(payload.new);
      },
    )
    .subscribe();

  return () => {
    if (messagesChannel) {
      sb.removeChannel(messagesChannel).catch(() => {});
      messagesChannel = null;
    }
  };
}

/** 订阅对话更新（Realtime） */
export function subscribeConversations(callback: ConversationCallback): () => void {
  const sb = getClient();
  if (!sb) return () => {};

  onConversationCb = callback;

  if (conversationsChannel) {
    sb.removeChannel(conversationsChannel).catch(() => {});
  }

  conversationsChannel = sb.channel('conversations-updates')
    .on('postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'conversations_sync',
      },
      (payload: any) => {
        callback(payload.new);
      },
    )
    .subscribe();

  return () => {
    if (conversationsChannel) {
      sb.removeChannel(conversationsChannel).catch(() => {});
      conversationsChannel = null;
    }
  };
}

/** 清理所有订阅 */
export function cleanup(): void {
  const sb = getClient();
  if (!sb) return;
  if (messagesChannel) {
    sb.removeChannel(messagesChannel).catch(() => {});
    messagesChannel = null;
  }
  if (conversationsChannel) {
    sb.removeChannel(conversationsChannel).catch(() => {});
    conversationsChannel = null;
  }
}

/** 断开连接 */
export function disconnect(): void {
  cleanup();
  sbClient = null;
  currentConfig = null;
  memoryKey = null;
  localStorage.removeItem('aether_supabase_url');
  localStorage.removeItem('aether_device_id');
}