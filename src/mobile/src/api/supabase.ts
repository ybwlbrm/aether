import type { RealtimeChannel } from '@supabase/supabase-js';
import { getClient, loadConfig, getCurrentUser, disposeClient } from './supabase-auth';
import { classifyError } from './supabase-errors';
import {
  getSyncStatus,
  markSynced,
  trackPending,
  settlePending,
  handleChannelStatus,
  resetSyncState,
} from './sync-state';
import { OfflineQueueManager, type QueuedCommand } from '../lib/offline-queue';
import { type ChatMessage } from '../lib/message-store';

// 对外 re-export 同步状态 API（组件从 './api/supabase' 统一导入）
export {
  getSyncState,
  getSyncStatus,
  onSyncStateChange,
  type SyncState,
  type SyncStatus,
} from './sync-state';

export { disposeClient } from './supabase-auth';

// ============================================================
// Supabase 业务层 — 会话/命令/消息/Realtime 订阅（§78 Message Store 收敛）
//
// §7 SendResult 语义：sendCommand 返回 { status: 'sent' | 'queued' | 'failed', ... }
// §10 OfflineQueueManager：统一 enqueue/flush/retry/remove/getPending
// §12 mergeMessages：所有消息来源统一合并/去重/排序
// §21 ChannelStatusRegistry：per-channel 状态聚合（见 sync-state.ts）
// §23 错误状态：getConversations/getMessages 返回 { data, error } 而非吞错返回 []
// §25 分页：getMessages 支持 limit + olderThan cursor
// ============================================================

// re-export 认证层与错误层（外部调用方统一从 './api/supabase' 导入）
export * from './supabase-auth';
export * from './supabase-errors';

// ============================================================
// 离线队列（§10 — 统一由 OfflineQueueManager 管理）
// ============================================================

const OFFLINE_QUEUE_KEY = 'aether_offline_commands';
export const offlineQueue = new OfflineQueueManager(OFFLINE_QUEUE_KEY);

/** 网络恢复信号：任意一次成功的数据读写后自动补传离线队列（含重入保护） */
function autoFlushQueue(): void {
  void flushPendingQueue();
}

/**
 * 补传离线队列（§10）。统一走 OfflineQueueManager。
 * @returns 本次成功发送的命令数
 */
export async function flushPendingQueue(): Promise<number> {
  return offlineQueue.flush(async (cmd: QueuedCommand) => {
    const result = await sendCommand(cmd.content, cmd.conversation_id ?? undefined, cmd.id, false);
    if (result.status === 'sent') {
      settlePending(cmd.id + '-queued');
      return 'sent';
    }
    if (result.status === 'queued') {
      // 仍在排队（理论上 flush 期间不会重新入队，防御处理）
      return 'retry';
    }
    return 'failed';
  });
}

// ============================================================
// 发送结果类型（§7 / §9）
// ============================================================

export type SendResult =
  | { status: 'sent'; commandId: string }
  | { status: 'queued'; commandId: string }
  | { status: 'failed'; commandId?: string; message?: string };

/** 本地乐观消息发送状态（§9） */
export type LocalMessageState = 'sending' | 'queued' | 'sent' | 'failed';

// ============================================================
// 数据读取（§23 错误状态 / §25 分页）
// ============================================================

export interface ListResult<T> {
  data: T[] | null;
  error: SupabaseApiErrorLike | null;
}

export interface SupabaseApiErrorLike {
  kind: string;
  message: string;
}

/** conversations_sync 行结构（§5 统一消息模型之外的列表行） */
export interface ConversationRow {
  id: string;
  title: string;
  model?: string | null;
  message_count?: number | null;
  user_id?: string | null;
  device_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** 获取对话列表（§26 分页：limit 默认 50，支持 offset 加载更多） */
export async function getConversations(opts?: { limit?: number; offset?: number }): Promise<ListResult<ConversationRow>> {
  const sb = getClient();
  if (!sb) return { data: null, error: { kind: 'network', message: 'Supabase 未配置' } };
  try {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const { data, error } = await sb
      .from('conversations_sync')
      .select('*')
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    // 网络恢复信号：成功读到数据则补传离线队列
    autoFlushQueue();
    const result = data || [];
    if (result.length > 0) markSynced();
    return { data: result, error: null };
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 获取对话列表失败 (${err.kind}):`, err.message);
    return { data: null, error: { kind: err.kind, message: err.message } };
  }
}

/**
 * 获取对话消息（§25 分页：limit + olderThan cursor，按 created_at 升序）。
 * @param opts.limit 默认 100
 * @param opts.olderThan 返回 created_at < olderThan 的更早消息（向上滚动加载）
 */
export async function getMessages(
  conversationId: string,
  opts?: { limit?: number; olderThan?: string },
): Promise<ListResult<ChatMessage>> {
  const sb = getClient();
  if (!sb) return { data: null, error: { kind: 'network', message: 'Supabase 未配置' } };
  try {
    const limit = opts?.limit ?? 100;
    let query = sb
      .from('messages_sync')
      .select('*')
      .eq('conversation_id', conversationId);
    if (opts?.olderThan) {
      query = query.lt('created_at', opts.olderThan);
    }
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    autoFlushQueue();
    const result = (data || []) as ChatMessage[];
    if (result.length > 0) markSynced();
    return { data: result, error: null };
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 获取消息失败 (${err.kind}):`, err.message);
    return { data: null, error: { kind: err.kind, message: err.message } };
  }
}

/**
 * 发送远程命令（§7 SendResult）。
 * @param conversationId 目标对话 id（可为空）
 * @param clientCommandId 幂等键；传入时复用（离线队列补传/UI 重试），缺省自动生成
 * @param allowQueue 网络失败时是否入离线队列（自动补传时传 false 防止重复入队）
 */
export async function sendCommand(
  content: string,
  conversationId?: string,
  clientCommandId?: string,
  allowQueue: boolean = true,
): Promise<SendResult> {
  const sb = getClient();
  const cfg = loadConfig();
  const user = getCurrentUser();
  if (!sb || !cfg) return { status: 'failed', message: 'Supabase 未配置' };
  if (!user) return { status: 'failed', message: '未登录' };

  const commandKey = clientCommandId ?? generateUuid();
  try {
    // 幂等检查：同一 client_command_id 已存在且未失败 → 视为已入队/已处理
    const { data: existing } = await sb
      .from('remote_commands')
      .select('id, status')
      .eq('client_command_id', commandKey)
      .eq('user_id', user.id)
      .neq('status', 'failed')
      .limit(1);
    if (existing && existing.length > 0) {
      console.log(`[supabase] 幂等跳过：命令已存在 (${existing[0].id}, ${existing[0].status})`);
      return { status: 'sent', commandId: existing[0].id };
    }

    const { data: inserted, error } = await sb
      .from('remote_commands')
      .insert({
        device_id: cfg.deviceId,
        user_id: user.id,
        conversation_id: conversationId || null,
        content,
        status: 'pending',
        client_command_id: commandKey,
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
    return { status: 'sent', commandId: inserted?.id ?? commandKey };
  } catch (e) {
    const err = classifyError(e);
    if (err.kind === 'network' && allowQueue) {
      // §8/§10：断网时命令入离线队列（不是失败），恢复后自动补传
      console.warn('[supabase] 网络不可用，命令已入离线队列待补传');
      offlineQueue.enqueue({
        id: commandKey,
        content,
        conversation_id: conversationId || null,
        created_at: new Date().toISOString(),
      });
      // 保持 pending 计数（补传成功后由 sendCommand/realtime 接管）
      trackPending(commandKey + '-queued');
      return { status: 'queued', commandId: commandKey };
    }
    console.error(`[supabase] 发送命令失败 (${err.kind}):`, err.message);
    return { status: 'failed', commandId: commandKey, message: err.message };
  }
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

// ============================================================
// Storage 上传（业务签名保留）
// ============================================================

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

/** 允许上传的 MIME -> 允许的扩展名 白名单 */
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
 */
export async function uploadFile(file: File, bucket: string = 'chat-files'): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    if (file.size > MAX_UPLOAD_BYTES) {
      console.warn(`[supabase] 上传被拒：文件超过 10MB (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
      return null;
    }

    const mime = (file.type || '').toLowerCase();
    const dotIdx = file.name.lastIndexOf('.');
    const ext = (dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : '');
    const allowedExts = ALLOWED_UPLOAD_TYPES[mime];
    if (!allowedExts || !ext || !allowedExts.includes(ext)) {
      console.warn(`[supabase] 上传被拒：不允许的类型 (mime=${mime || '空'}, ext=${ext || '空'})`);
      return null;
    }

    const fileName = `${generateUuid()}/${generateUuid()}${ext}`;
    const { error } = await sb.storage.from(bucket).upload(fileName, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: mime,
    });
    if (error) throw error;

    const { data, error: signError } = await sb.storage.from(bucket).createSignedUrl(fileName, 3600);
    if (signError || !data?.signedUrl) throw signError ?? new Error('createSignedUrl 未返回 URL');
    return data.signedUrl;
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 上传文件失败 (${err.kind}):`, err.message);
    return null;
  }
}

/** 删除对话（从 Supabase 级联删除） */
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

/**
 * §15.1 收口：Mobile Stop 必须真正取消 Run（不能只是 UI 改成 cancelled）。
 * 向 remote_commands 写入一条 cancel 命令（status=cancelled + cancel_requested 标记），
 * 桌面端 Realtime/Polling 检测后触发 runCancellationRegistry.cancel(runTaskId)
 * → AbortSignal → execution-loop state='cancelled' → run.cancelled 终态事件 → Mobile 显示 cancelled。
 * 幂等：同 client_command_id 已存在时不再重复插入。
 */
export async function cancelCommand(
  conversationId: string,
  clientCommandId?: string,
): Promise<{ status: 'sent' } | { status: 'failed'; message?: string }> {
  const sb = getClient();
  const cfg = loadConfig();
  const user = getCurrentUser();
  if (!sb || !cfg) return { status: 'failed', message: 'Supabase 未配置' };
  if (!user) return { status: 'failed', message: '未登录' };

  const cancelKey = clientCommandId ?? generateUuid();
  try {
    const { data: inserted, error } = await sb
      .from('remote_commands')
      .insert({
        device_id: cfg.deviceId,
        user_id: user.id,
        conversation_id: conversationId || null,
        content: '/cancel',
        status: 'cancelled', // 桌面端轮询见 status=cancelled + content=/cancel → 触发 Run 取消
        client_command_id: cancelKey,
        metadata: { cancel_requested: true },
      })
      .select('id')
      .single();
    if (error) throw error;
    return { status: 'sent' };
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 发送取消命令失败 (${err.kind}):`, err.message);
    return { status: 'failed', message: err.message };
  }
}

// ============================================================
// Realtime 订阅（A06 / A07 / §21 Channel 状态）
// ============================================================

type MessageCallback = (message: ChatMessage) => void;

/** Realtime postgres_changes payload（A06 完整事件转发） */
export interface RealtimePayload {
  eventType?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

type ConversationCallback = (payload: RealtimePayload) => void;

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

// 消息 channel：按 conversationId 分别管理
const messagesChannelRegistry = new Map<string, MessageChannelEntry>();
// 会话列表 channel（全局单例）
let conversationsChannelEntry: SingularChannelEntry | null = null;
// 远程命令状态 channel（全局单例）
let commandsChannelEntry: SingularChannelEntry | null = null;

/** 延迟释放窗口 */
const CHANNEL_RELEASE_DELAY_MS = 1000;

/**
 * 订阅消息更新（Realtime — 支持流式 INSERT 和 UPDATE）。
 * 回调收到 payload.new（消息行）。按 conversationId registry 管理。
 * §12 注：回调只透传单条消息，merge 由消费方统一走 mergeMessages。
 */
export function subscribeMessages(
  conversationId: string,
  callback: MessageCallback,
): () => void {
  const sb = getClient();
  if (!sb || !conversationId) return () => {};

  const key = `messages-${conversationId}`;
  const existing = messagesChannelRegistry.get(key);

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

  const channelTrigger = (payload: RealtimePayload) => {
    markSynced();
    const newMsg = payload?.new as ChatMessage | null | undefined;
    if (!newMsg) return;
    const active = messagesChannelRegistry.get(key);
    if (!active || active.channel !== channel) return;
    active.callbacks.forEach((cb) => {
      try { cb(newMsg as ChatMessage); } catch { /* ignore */ }
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

  if (getSyncStatus() === 'disconnected') {
    // 通过注册表标记 messages channel 进入 connecting
  }
  channel.subscribe((status: string) => { handleChannelStatus('messages', status); });

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
 * 回调接收完整 payload（{ eventType, new, old }）。
 */
export function subscribeConversations(callback: ConversationCallback): () => void {
  const sb = getClient();
  if (!sb) return () => {};

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
      (payload: RealtimePayload) => {
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

  channel.subscribe((status: string) => { handleChannelStatus('conversations', status); });

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
      (payload: RealtimePayload) => {
        if (commandsChannelEntry === entry) {
          markSynced();
          const row = payload?.new ?? payload?.old;
          if (!row?.id) return;
          const status: string | undefined = typeof row.status === 'string' ? row.status : undefined;
          if (payload.eventType === 'DELETE') {
            settlePending(String(row.id));
          } else if (payload.eventType === 'INSERT' || status === 'pending') {
            trackPending(String(row.id));
          } else if (status && status !== 'pending') {
            settlePending(String(row.id));
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

  channel.subscribe((status: string) => { handleChannelStatus('commands', status); });
}

/** 清理所有订阅（登出时调用） */
export function cleanup(): void {
  const sb = getClient();
  if (sb) {
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
  }

  // 重置同步状态 + 销毁 client（登出后回到初始，避免旧状态残留）
  resetSyncState();
  disposeClient();
}
