import type { RealtimeChannel } from '@supabase/supabase-js';
import { getClient, loadConfig, getCurrentUser } from './supabase-auth';
import { classifyError } from './supabase-errors';
import {
  getSyncStatus,
  updateSyncStatus,
  markSynced,
  trackPending,
  settlePending,
  handleChannelStatus,
  resetSyncState,
} from './sync-state';

// 对外 re-export 同步状态 API（组件从 './api/supabase' 统一导入）
export {
  getSyncState,
  getSyncStatus,
  onSyncStateChange,
  type SyncState,
  type SyncStatus,
} from './sync-state';

// ============================================================
// Supabase 业务层 — 会话/命令/消息/Realtime 订阅
//
// 认证与连接层见 supabase-auth.ts（anon key + Supabase Auth）；
// 错误分类见 supabase-errors.ts。本文件只保留移动端业务数据访问，
// 所有业务函数签名保持不变（MessageView / NewCommand / ConversationList 依赖）。
//
// P0-A06/A07/A08/A16/A17/A18/A19/A21/A22 修复（2026-09-06）：
// - A06: subscribeConversations 回调传完整 payload（含 eventType/old/new），
//        DELETE 事件可在 ConversationList 本地移除。
// - A07: channel 按 conversationId registry + 引用计数 + 延迟释放，
//        消除多页面互杀 channel / 重复订阅竞态。
// - A08: 模块级 syncStatus（'connected' | 'connecting' | 'disconnected'），
//        由各 channel 的 status 事件驱动，组件据此决定轮询降级。
// - A16: remote_commands 补 run_id/task_id（可为 null，桌面端执行后回填）。
// - A17: sendCommand 生成 client_command_id（UUID）做幂等键；
//        断网命令入 localStorage 离线队列，恢复后自动补传去重。
// - A18/A19: 轻量 SyncState（连接状态 + lastSyncAt + pendingCount）。
// - A21: 删除双向同步 — 移动端订阅 DELETE 后本地移除（配合桌面端 realtime）。
// - A22: uploadFile 私有桶 + createSignedUrl + size/MIME/extension 白名单 + UUID 文件名。
// ============================================================

// re-export 认证层与错误层（外部调用方统一从 './api/supabase' 导入）
export * from './supabase-auth';
export * from './supabase-errors';

// ============================================================
// A05 已由 supabase-auth.ts 修复：设备 ID 使用 crypto.randomUUID 持久化。
// ============================================================

// ============================================================
// A07 — Channel Registry（引用计数 + 延迟释放）
// ============================================================

type MessageCallback = (message: any) => void;
type ConversationCallback = (payload: any) => void;

interface MessageChannelEntry {
  key: string;
  conversationId: string;
  channel: RealtimeChannel;
  refCount: number;
  callbacks: Set<MessageCallback>;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

interface SingularChannelEntry {
  channel: RealtimeChannel;
  refCount: number;
  callbacks: Set<ConversationCallback>;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

// 消息 channel：按 conversationId 分别管理（不同会话互不干扰）
const messagesChannelRegistry = new Map<string, MessageChannelEntry>();
// 会话列表 channel（全局单例，多个订阅方共享）
let conversationsChannelEntry: SingularChannelEntry | null = null;
// 远程命令状态 channel（全局单例，供 SyncState.pendingCount 追踪）
let commandsChannelEntry: SingularChannelEntry | null = null;

/** 延迟释放窗口：卸载后 1s 内重新订阅可复用同一 channel，避免 removeChannel 竞态 */
const CHANNEL_RELEASE_DELAY_MS = 1000;

// 同步状态（SyncStatus/SyncState/getSyncState/getSyncStatus/onSyncStateChange/
// updateSyncStatus/markSynced/trackPending/settlePending/handleChannelStatus）
// 已迁移至 ./sync-state.ts（见文件头部 import 与 re-export）。

// ============================================================
// A17 — 幂等键 + 离线队列
// ============================================================

const OFFLINE_QUEUE_KEY = 'aether_offline_commands';

interface QueuedCommand {
  id: string;
  content: string;
  conversation_id: string | null;
  created_at: string;
}

/** 生成 UUID（crypto.randomUUID，兼容旧 WebView 回退） */
function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function loadQueue(): QueuedCommand[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedCommand[]): void {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch { /* 存储满时忽略，命令本会话内仍会重试 */ }
}

function enqueueCommand(cmd: QueuedCommand): void {
  const queue = loadQueue();
  if (queue.some((c) => c.id === cmd.id)) return;
  queue.push(cmd);
  saveQueue(queue);
}

let flushingQueue = false;

/**
 * 上传离线队列中的命令（按 client_command_id 幂等去重）。
 * 成功提交的从队列移除；仍失败的保留，下次网络恢复再试。
 * 返回本次成功上传的命令数。
 */
export async function flushPendingQueue(): Promise<number> {
  if (flushingQueue) return 0;
  flushingQueue = true;
  try {
    const queue = loadQueue();
    if (queue.length === 0) return 0;
    const remaining: QueuedCommand[] = [];
    let flushed = 0;
    for (const cmd of queue) {
      const ok = await sendCommand(cmd.content, cmd.conversation_id ?? undefined, cmd.id, false);
      if (ok) {
        flushed++;
        // 清除该命令入队时的 pending 占位标记（-queued），避免超时清理前计数滞留
        settlePending(cmd.id + '-queued');
      } else {
        remaining.push(cmd);
      }
    }
    saveQueue(remaining);
    return flushed;
  } finally {
    flushingQueue = false;
  }
}

/** 网络恢复信号：任意一次成功的数据读写后自动补传离线队列（含重入保护） */
function autoFlushQueue(): void {
  void flushPendingQueue();
}

// ============================================================
// 业务函数（签名保持不变）
// ============================================================

/** 获取对话列表 */
export async function getConversations(): Promise<any[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('conversations_sync')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    // 网络恢复信号：成功读到数据则补传离线队列
    autoFlushQueue();
    const result = data || [];
    if (result.length > 0) markSynced();
    return result;
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 获取对话列表失败 (${err.kind}):`, err.message);
    return [];
  }
}

/** 获取对话消息 */
export async function getMessages(conversationId: string): Promise<any[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('messages_sync')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    autoFlushQueue();
    const result = data || [];
    if (result.length > 0) markSynced();
    return result;
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 获取消息失败 (${err.kind}):`, err.message);
    return [];
  }
}

/**
 * 发送远程命令。
 * @param conversationId 目标对话 id（可为空）
 * @param clientCommandId 幂等键；传入时复用（离线队列补传/UI 重试），缺省自动生成
 * @param allowQueue 网络失败时是否入离线队列（自动补传时传 false 防止重复入队）
 */
export async function sendCommand(
  content: string,
  conversationId?: string,
  clientCommandId?: string,
  allowQueue: boolean = true,
): Promise<boolean> {
  const sb = getClient();
  const cfg = loadConfig();
  const user = getCurrentUser();
  if (!sb || !cfg) return false;
  if (!user) {
    console.warn('[supabase] 发送命令失败：未登录');
    return false;
  }
  // A17：客户端生成幂等键（同一逻辑命令重试复用同一 UUID）
  const commandKey = clientCommandId ?? generateUuid();
  try {
    // 幂等检查：同一 client_command_id 已存在且未失败 → 视为已入队/已处理，不重复下发
    const { data: existing } = await sb
      .from('remote_commands')
      .select('id, status')
      .eq('client_command_id', commandKey)
      .eq('user_id', user.id)
      .neq('status', 'failed')
      .limit(1);
    if (existing && existing.length > 0) {
      console.log(`[supabase] 幂等跳过：命令已存在 (${existing[0].id}, ${existing[0].status})`);
      return true;
    }

    const { data: inserted, error } = await sb
      .from('remote_commands')
      .insert({
        device_id: cfg.deviceId,
        user_id: user.id,
        conversation_id: conversationId || null,
        content,
        status: 'pending',
        client_command_id: commandKey, // A17 幂等键
        // A16：run_id/task_id 由桌面端处理后回填，此处保持 null
      })
      .select('id')
      .single();
    if (error) throw error;

    if (inserted?.id) {
      trackPending(inserted.id);
      // 惰性建立 remote_commands 状态订阅（追踪 pending 直至完成）
      ensureCommandsChannel(sb);
    }
    // 网络恢复信号：命令成功下发说明连接可用，顺带补传队列中遗留的命令
    autoFlushQueue();
    markSynced();
    return true;
  } catch (e) {
    const err = classifyError(e);
    if (err.kind === 'network' && allowQueue) {
      // A17 §40：断网时命令入本地队列，恢复后自动补传去重
      console.warn('[supabase] 网络不可用，命令已入离线队列待补传');
      enqueueCommand({
        id: commandKey,
        content,
        conversation_id: conversationId || null,
        created_at: new Date().toISOString(),
      });
      // 保持 pending 计数（补传成功后由 sendCommand/realtime 接管）
      trackPending(commandKey + '-queued');
      return false;
    }
    console.error(`[supabase] 发送命令失败 (${err.kind}):`, err.message);
    return false;
  }
}

// ============================================================
// A22 — Storage 上传（安全化：私有桶 + signed URL + 白名单校验）
// ============================================================

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

/** 允许上传的 MIME -> 允许的扩展名 白名单（含代码文本类） */
const ALLOWED_UPLOAD_TYPES: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'text/plain': ['.txt', '.md', '.log', '.csv', '.env', '.yml', '.yaml', '.json', '.xml', '.sql', '.sh', '.bat', '.ps1', '.ini', '.conf'],
  'application/pdf': ['.pdf'],
  'application/json': ['.json'],
  'application/zip': ['.zip'],
  'application/x-zip-compressed': ['.zip'],
  'application/octet-stream': ['.zip', '.pdf', '.gz', '.tar'],
  // 常见代码文件：很多 WebView/桌面端以空 MIME 或 text/* 上报
  'text/javascript': ['.js', '.mjs', '.cjs'],
  'text/typescript': ['.ts', '.tsx', '.mts', '.cts'],
  'text/html': ['.html', '.htm'],
  'text/css': ['.css'],
  'text/x-python': ['.py', '.pyi'],
  'text/x-java-source': ['.java'],
  'text/x-c': ['.c', '.h'],
  'text/x-c++': ['.cpp', '.hpp', '.cc'],
  'text/x-rust': ['.rs'],
  'text/x-go': ['.go'],
  'text/x-ruby': ['.rb'],
  'text/x-shellscript': ['.sh'],
  'text/markdown': ['.md'],
  'application/x-httpd-php': ['.php'],
  'text/x-php': ['.php'],
  'application/gzip': ['.gz'],
};

/**
 * 上传文件到 Supabase Storage（私有 bucket）。
 * 返回 1 小时有效的 signed URL；文件过大/类型不符/上传失败返回 null。
 * 安全设计：文件名 UUID 化 + 对象路径指向上传时刻，避免路径穿越与覆盖。
 */
export async function uploadFile(file: File, bucket: string = 'chat-files'): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    // 1) 大小限制
    if (file.size > MAX_UPLOAD_BYTES) {
      console.warn(`[supabase] 上传被拒：文件超过 10MB (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
      return null;
    }

    // 2) MIME + 扩展名白名单（双检，防 Content-Type spoof）
    const mime = (file.type || '').toLowerCase();
    const dotIdx = file.name.lastIndexOf('.');
    const ext = (dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : '');
    const allowedExts = ALLOWED_UPLOAD_TYPES[mime];
    if (!allowedExts || !ext || !allowedExts.includes(ext)) {
      console.warn(`[supabase] 上传被拒：不允许的类型 (mime=${mime || '空'}, ext=${ext || '空'})`);
      return null;
    }

    // 3) 文件名 UUID 化（保留白名单扩展名），路径加随机目录防止同名覆盖
    const fileName = `${generateUuid()}/${generateUuid()}${ext}`;
    const { error } = await sb.storage.from(bucket).upload(fileName, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: mime,
    });
    if (error) throw error;

    // 4) 私有桶：生成 1 小时有效 signed URL，而非永久公开 URL
    const { data, error: signError } = await sb.storage.from(bucket).createSignedUrl(fileName, 3600);
    if (signError || !data?.signedUrl) throw signError ?? new Error('createSignedUrl 未返回 URL');
    return data.signedUrl;
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 上传文件失败 (${err.kind}):`, err.message);
    return null;
  }
}

/** 删除对话（从 Supabase 级联删除，手机端+电脑端双向同步） */
export async function deleteConversation(convId: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { error } = await sb.from('conversations_sync').delete().eq('id', convId);
    if (error) throw error;
    return true;
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 删除对话失败 (${err.kind}):`, err.message);
    return false;
  }
}

// ============================================================
// Realtime 订阅（A06 / A07 / A08）
// ============================================================

/**
 * 订阅消息更新（Realtime — 支持流式 INSERT 和 UPDATE）。
 * 回调收到 payload.new（消息行）。按 conversationId registry 管理，
 * 同一对话的多个订阅方共享 channel，引用计数归零后延迟释放。
 */
export function subscribeMessages(
  conversationId: string,
  callback: MessageCallback,
): () => void {
  const sb = getClient();
  if (!sb || !conversationId) return () => {};

  const key = `messages-${conversationId}`;
  const existing = messagesChannelRegistry.get(key);

  // 复用已有 channel（取消延迟释放）
  if (existing) {
    if (existing.releaseTimer) {
      clearTimeout(existing.releaseTimer);
      existing.releaseTimer = null;
    }
    existing.refCount++;
    existing.callbacks.add(callback);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      existing.callbacks.delete(callback);
      existing.refCount--;
      scheduleMessageChannelRelease(key, existing);
    };
  }

  const channelTrigger = (payload: any) => {
    // A08：收到真实数据事件即视为同步成功
    markSynced();
    const newMsg = payload?.new;
    if (!newMsg) return;
    // 仅转发到仍持有该 channel 的活跃 entry（释放后 registry 已删除 → 静默忽略）
    const active = messagesChannelRegistry.get(key);
    if (!active || active.channel !== channel) return;
    active.callbacks.forEach((cb) => {
      try { cb(newMsg); } catch { /* ignore */ }
    });
  };

  const channel: RealtimeChannel = sb.channel(key)
    .on('postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages_sync',
        filter: `conversation_id=eq.${conversationId}`,
      },
      channelTrigger,
    )
    .on('postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages_sync',
        filter: `conversation_id=eq.${conversationId}`,
      },
      channelTrigger,
    );

  const entry: MessageChannelEntry = {
    key,
    conversationId,
    channel,
    refCount: 1,
    callbacks: new Set([callback]),
    releaseTimer: null,
  };
  messagesChannelRegistry.set(key, entry);

  // 初始状态：channel 建立中
  if (getSyncStatus() === 'disconnected') {
    updateSyncStatus('connecting');
  }
  channel.subscribe((status: string) => { handleChannelStatus(status); });

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    entry.callbacks.delete(callback);
    entry.refCount--;
    scheduleMessageChannelRelease(key, entry);
  };
}

function scheduleMessageChannelRelease(key: string, entry: MessageChannelEntry): void {
  if (entry.refCount > 0) return;
  if (entry.releaseTimer) return;
  const sb = getClient();
  if (!sb) return;
  entry.releaseTimer = setTimeout(() => {
    if (entry.refCount > 0) return;
    messagesChannelRegistry.delete(key);
    entry.releaseTimer = null;
    sb.removeChannel(entry.channel).then(
      () => { /* 已释放 */ },
      (e: unknown) => console.warn('[supabase] 消息 channel 释放失败:', e instanceof Error ? e.message : e),
    );
  }, CHANNEL_RELEASE_DELAY_MS);
}

/**
 * 订阅对话更新（Realtime）。
 * A06 修复：回调接收完整 payload（{ eventType, new, old }）；
 * 调用方判断 payload.eventType === 'DELETE' 时用 payload.old.id 移除本地数据。
 * 全局单例 channel，多订阅方共享，引用计数归零后延迟释放。
 */
export function subscribeConversations(callback: ConversationCallback): () => void {
  const sb = getClient();
  if (!sb) return () => {};

  // 复用已有 conversations channel
  if (conversationsChannelEntry) {
    const entry = conversationsChannelEntry;
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    entry.refCount++;
    entry.callbacks.add(callback);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.callbacks.delete(callback);
      entry.refCount--;
      scheduleConversationsChannelRelease(entry);
    };
  }

  const channel: RealtimeChannel = sb.channel('conversations-updates')
    .on('postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'conversations_sync',
      },
      (payload: any) => {
        // A06：完整 payload 转发（含 eventType/new/old），DELETE 时 payload.new 为 null。
        // 仅当本 channel 仍是活跃订阅时转发，避免释放后的遗留事件污染新订阅。
        if (conversationsChannelEntry === entry) {
          markSynced();
          conversationsChannelEntry.callbacks.forEach((cb) => {
            try { cb(payload); } catch { /* ignore */ }
          });
        }
      },
    );

  const entry: SingularChannelEntry = {
    channel,
    refCount: 1,
    callbacks: new Set([callback]),
    releaseTimer: null,
  };
  conversationsChannelEntry = entry;

  if (getSyncStatus() === 'disconnected') {
    updateSyncStatus('connecting');
  }
  channel.subscribe((status: string) => { handleChannelStatus(status); });

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    entry.callbacks.delete(callback);
    entry.refCount--;
    scheduleConversationsChannelRelease(entry);
  };
}

function scheduleConversationsChannelRelease(entry: SingularChannelEntry): void {
  if (entry.refCount > 0) return;
  if (entry.releaseTimer) return;
  const sb = getClient();
  if (!sb) return;
  entry.releaseTimer = setTimeout(() => {
    if (entry.refCount > 0) return;
    if (conversationsChannelEntry === entry) conversationsChannelEntry = null;
    entry.releaseTimer = null;
    sb.removeChannel(entry.channel).then(
      () => { /* 已释放 */ },
      (e: unknown) => console.warn('[supabase] 会话 channel 释放失败:', e instanceof Error ? e.message : e),
    );
  }, CHANNEL_RELEASE_DELAY_MS);
}

/**
 * 惰性建立 remote_commands 状态订阅（单例）。
 * 用于 A18/A19 pendingCount 追踪：INSERT pending → 计数 +1；
 * UPDATE 状态离开 pending → 计数 -1。
 */
function ensureCommandsChannel(sb: ReturnType<typeof getClient> & object): void {
  if (!sb || commandsChannelEntry) return;
  const channel = sb.channel('remote-commands-updates')
    .on('postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'remote_commands',
      },
      (payload: any) => {
        // 仅当本 channel 仍是活跃订阅时更新计数
        if (commandsChannelEntry === entry) {
          markSynced();
          const row = payload?.new ?? payload?.old;
          if (!row?.id) return;
          const status: string | undefined = row.status;
          if (payload.eventType === 'DELETE') {
            settlePending(row.id);
          } else if (payload.eventType === 'INSERT' || status === 'pending') {
            trackPending(row.id);
          } else if (status && status !== 'pending') {
            // processing / completed / failed → 命令已进入结算路径
            settlePending(row.id);
          }
        }
      },
    );

  const entry: SingularChannelEntry = {
    channel,
    refCount: 1,
    callbacks: new Set(),
    releaseTimer: null,
  };
  commandsChannelEntry = entry;

  if (getSyncStatus() === 'disconnected') {
    updateSyncStatus('connecting');
  }
  channel.subscribe((status: string) => { handleChannelStatus(status); });
}

/** 清理所有订阅（登出时调用） */
export function cleanup(): void {
  const sb = getClient();
  if (!sb) return;

  // 立即取消消息 channel 的延迟释放定时器并释放
  for (const [key, entry] of messagesChannelRegistry) {
    if (entry.releaseTimer) { clearTimeout(entry.releaseTimer); entry.releaseTimer = null; }
    messagesChannelRegistry.delete(key);
    void sb.removeChannel(entry.channel).catch(() => {});
  }
  if (conversationsChannelEntry) {
    const entry = conversationsChannelEntry;
    if (entry.releaseTimer) { clearTimeout(entry.releaseTimer); entry.releaseTimer = null; }
    conversationsChannelEntry = null;
    void sb.removeChannel(entry.channel).catch(() => {});
  }
  if (commandsChannelEntry) {
    const entry = commandsChannelEntry;
    if (entry.releaseTimer) { clearTimeout(entry.releaseTimer); entry.releaseTimer = null; }
    commandsChannelEntry = null;
    void sb.removeChannel(entry.channel).catch(() => {});
  }

  // 重置同步状态（登出后回到初始，避免旧状态残留）
  resetSyncState();
}