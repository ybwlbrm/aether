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
  onSyncStateChange,
} from './sync-state';
import { OfflineQueueManager, type QueuedCommand } from '../lib/offline-queue';
import {
  buildCancelCommandPayload,
  matchesRemoteCommandReference,
  parseRemoteCommandSnapshot,
  resolveCancellationAction,
  shouldPollRemoteCommandStatus,
  type RemoteCommandReference,
  type RemoteCommandSnapshot,
} from '../lib/remote-command'
import { type ChatMessage } from '../lib/message-store';
import {
  ReconnectStateRebuilder,
  type ReconnectCommandReference,
  type ReconnectRebuildReport,
} from '../lib/reconnect';

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
  | { status: 'sent'; commandId: string; clientCommandId: string }
  | { status: 'queued'; commandId: string; clientCommandId: string }
  | { status: 'failed'; commandId?: string; clientCommandId?: string; message?: string }

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
 * 按游标增量拉取消息（AEX-P1-077：重连/降级轮询不得全量 reload）。
 *
 * 用 created_at 作为游标（messages_sync 只有 created_at 索引，SDK 端无 seq 列）。
 * 边界用 gte 而非 gt：同一秒内的多条消息必须全部取回，重复的那一条由
 * mergeMessages 按 id 去重；用 gt 会静默漏掉同秒消息。
 * @param since 游标（已合并消息中最大的 created_at）
 */
export async function getMessagesSince(
  conversationId: string,
  since: string,
  opts?: { limit?: number },
): Promise<ListResult<ChatMessage>> {
  const sb = getClient();
  if (!sb) return { data: null, error: { kind: 'network', message: 'Supabase 未配置' } };
  try {
    const { data, error } = await sb
      .from('messages_sync')
      .select('*')
      .eq('conversation_id', conversationId)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(opts?.limit ?? 200);
    if (error) throw error;
    autoFlushQueue();
    const result = (data || []) as ChatMessage[];
    if (result.length > 0) markSynced();
    return { data: result, error: null };
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 增量获取消息失败 (${err.kind}):`, err.message);
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
    // 幂等检查：同一 client_command_id 的原始命令已存在 → 视为已入队/已处理
    const { data: existing } = await sb
      .from('remote_commands')
      .select('id, status')
      .eq('client_command_id', commandKey)
      .eq('user_id', user.id)
      .in('status', ['pending', 'processing', 'completed'])
      .limit(1);
    if (existing && existing.length > 0) {
      console.log(`[supabase] 幂等跳过：命令已存在 (${existing[0].id}, ${existing[0].status})`);
      return { status: 'sent', commandId: existing[0].id, clientCommandId: commandKey }
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
    return { status: 'sent', commandId: inserted?.id ?? commandKey, clientCommandId: commandKey }
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
      return { status: 'queued', commandId: commandKey, clientCommandId: commandKey }
    }
    console.error(`[supabase] 发送命令失败 (${err.kind}):`, err.message);
    return { status: 'failed', commandId: commandKey, clientCommandId: commandKey, message: err.message }
  }
}

/** 生成客户端幂等键 */
export function createClientCommandId(): string {
  return generateUuid()
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
 * 取消行复用原始命令的 client_command_id，桌面端据此定位正在执行的 Run。
 * → AbortSignal → execution-loop state='cancelled' → run.cancelled 终态事件 → Mobile 显示 cancelled。
 * 幂等：同 client_command_id 已存在时不再重复插入。
 */
function hasCancelRequestedMetadata(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const metadata = Reflect.get(value, 'metadata')
  if (typeof metadata !== 'object' || metadata === null) return false
  return Reflect.get(metadata, 'cancel_requested') === true
}

export type CancelCommandResult =
  | { status: 'sent' }
  | { status: 'cancelled_locally' }
  | { status: 'failed'; message: string }

export async function cancelCommand(
  conversationId: string,
  clientCommandId: string,
): Promise<CancelCommandResult> {
  const normalizedClientCommandId = clientCommandId.trim()
  if (!normalizedClientCommandId) return { status: 'failed', message: '未找到可取消的原始命令' }

  const hasQueuedCommand = offlineQueue.getPending().some((cmd) => cmd.id === normalizedClientCommandId)
  if (resolveCancellationAction({ hasQueuedCommand, hasRemoteCommand: false }) === 'cancel_local') {
    offlineQueue.remove(normalizedClientCommandId)
    return { status: 'cancelled_locally' }
  }

  const sb = getClient()
  const cfg = loadConfig()
  const user = getCurrentUser()
  if (!sb || !cfg) return { status: 'failed', message: 'Supabase 未配置' }
  if (!user) return { status: 'failed', message: '未登录' }

  try {
    const { data: originals, error: originalError } = await sb
      .from('remote_commands')
      .select('id, conversation_id, client_command_id')
      .eq('client_command_id', normalizedClientCommandId)
      .eq('user_id', user.id)
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (originalError) throw originalError

    const original = originals?.[0]
    if (!original || typeof original.client_command_id !== 'string') {
      return { status: 'failed', message: '未找到可取消的原始命令' }
    }
    if (original.conversation_id && original.conversation_id !== conversationId) {
      return { status: 'failed', message: '原始命令不属于当前对话' }
    }

    const { data: cancellations, error: cancellationLookupError } = await sb
      .from('remote_commands')
      .select('id, metadata')
      .eq('client_command_id', normalizedClientCommandId)
      .eq('user_id', user.id)
      .eq('status', 'cancelled')
      .limit(1)
    if (cancellationLookupError) throw cancellationLookupError
    if (cancellations?.some((row: unknown) => hasCancelRequestedMetadata(row))) {
      return { status: 'sent' }
    }

    const { error } = await sb
      .from('remote_commands')
      .insert(buildCancelCommandPayload({
        deviceId: cfg.deviceId,
        userId: user.id,
        conversationId,
        originalClientCommandId: original.client_command_id,
      }))
    if (error) throw error
    return { status: 'sent' }
  } catch (error: unknown) {
    const err = classifyError(error)
    console.error(`[supabase] 发送取消命令失败 (${err.kind}):`, err.message)
    return { status: 'failed', message: err.message }
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

type ConversationCallback = (payload: RealtimePayload) => void
export type RemoteCommandStatusCallback = (snapshot: RemoteCommandSnapshot) => void

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
let commandsChannelEntry: SingularChannelEntry | null = null
const commandStatusCallbacks = new Map<string, Set<RemoteCommandStatusCallback>>()
const commandStatusCleanupCallbacks = new Set<() => void>()

/** 延迟释放窗口 */
const CHANNEL_RELEASE_DELAY_MS = 1000
const REMOTE_COMMAND_STATUS_POLL_MS = 2000

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
  ensureSyncStatusBridge();

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
  ensureSyncStatusBridge();

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

function normalizeRemoteCommandReference(
  reference: string | RemoteCommandReference,
): RemoteCommandReference {
  if (typeof reference === 'string') {
    return { serverId: reference, clientCommandId: null }
  }
  return {
    serverId: reference.serverId,
    clientCommandId: reference.clientCommandId,
  }
}

function getCommandReferenceKey(reference: RemoteCommandReference): string | null {
  return reference.serverId ?? reference.clientCommandId
}

/**
 * 向 canonical 源（remote_commands）重新查询命令状态。
 * Realtime 只是通知不是日志 —— 断线期间的事件永久丢失，重连后必须回源取终态。
 */
export async function queryRemoteCommandTerminal(
  reference: RemoteCommandReference,
): Promise<RemoteCommandSnapshot | null> {
  const sb = getClient();
  if (!sb) return null;
  let query = sb
    .from('remote_commands')
    .select('id, client_command_id, status, result_summary, error, content, metadata')
    .limit(1);
  if (reference.serverId) {
    query = query.eq('id', reference.serverId);
  } else if (reference.clientCommandId) {
    query = query
      .eq('client_command_id', reference.clientCommandId)
      .order('created_at', { ascending: true });
  } else {
    return null;
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    console.warn('[supabase] 查询命令终态失败:', error.message);
    throw new Error(error.message);
  }
  return parseRemoteCommandSnapshot(data);
}

/**
 * 重连状态重建协调器（AEX-P1-077，单例）。
 *
 * 断线恢复的执行顺序：命令 canonical 终态结算 → 会话消息按游标增量合并。
 * 组件用 registerCommand / registerConversation 登记自己关心的恢复动作；
 * 本模块把同步状态桥接进来：非 connected → connected 时自动跑一轮。
 */
export const reconnectRebuilder = new ReconnectStateRebuilder({
  fetchTerminal: (reference: ReconnectCommandReference) => queryRemoteCommandTerminal(reference),
});

/** 同步状态 → 重连重建的桥（单例，通道建立时惰性挂载） */
let syncStatusBridge: (() => void) | null = null;

function ensureSyncStatusBridge(): void {
  if (syncStatusBridge) return;
  syncStatusBridge = onSyncStateChange((state) => reconnectRebuilder.noteSyncStatus(state.status));
}

function dispatchRemoteCommandStatus(snapshot: RemoteCommandSnapshot): void {
  if (snapshot.isCancellation === true) return
  const keys = new Set<string>()
  if (snapshot.id) keys.add(snapshot.id)
  if (snapshot.clientCommandId) keys.add(snapshot.clientCommandId)
  for (const key of keys) {
    commandStatusCallbacks.get(key)?.forEach((callback) => {
      try { callback(snapshot) } catch (error: unknown) {
        console.warn('[supabase] 命令终态订阅回调失败:', error instanceof Error ? error.message : error)
      }
    })
  }
}

/** 订阅单条远程命令的服务端终态，初始查询 + Realtime + 轮询兜底防止漏事件。 */
export function subscribeRemoteCommandStatus(
  referenceInput: string | RemoteCommandReference,
  callback: RemoteCommandStatusCallback,
): () => void {
  const sb = getClient()
  const reference = normalizeRemoteCommandReference(referenceInput)
  const commandKey = getCommandReferenceKey(reference)
  if (!sb || !commandKey) return () => {}

  ensureCommandsChannel(sb)
  let subscribed = true
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let queryInFlight = false
  let terminalReceived = false

  const clearPollTimer = () => {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  const emitSnapshot = (snapshot: RemoteCommandSnapshot) => {
    if (!subscribed || !matchesRemoteCommandReference(snapshot, reference)) return
    if (shouldPollRemoteCommandStatus(snapshot.status)) {
      trackPending(snapshot.id)
    } else {
      terminalReceived = true
      settlePending(snapshot.id)
    }
    callback(snapshot)
    if (terminalReceived) clearPollTimer()
  }

  const callbacks = commandStatusCallbacks.get(commandKey) ?? new Set<RemoteCommandStatusCallback>()
  callbacks.add(emitSnapshot)
  commandStatusCallbacks.set(commandKey, callbacks)

  const queryRemoteCommandStatus = () => {
    if (!subscribed || queryInFlight || terminalReceived) return
    queryInFlight = true
    void queryRemoteCommandTerminal(reference).then((snapshot) => {
      queryInFlight = false
      if (!subscribed || !snapshot) return
      emitSnapshot(snapshot)
    }, (error: unknown) => {
      queryInFlight = false
      console.warn('[supabase] 查询命令终态失败:', error instanceof Error ? error.message : error)
    })
  }

  queryRemoteCommandStatus()
  if (!terminalReceived) pollTimer = setInterval(queryRemoteCommandStatus, REMOTE_COMMAND_STATUS_POLL_MS)

  let released = false
  const release = () => {
    if (released) return
    released = true
    subscribed = false
    clearPollTimer()
    const current = commandStatusCallbacks.get(commandKey)
    current?.delete(emitSnapshot)
    if (current?.size === 0) commandStatusCallbacks.delete(commandKey)
    commandStatusCleanupCallbacks.delete(release)
  }
  commandStatusCleanupCallbacks.add(release)
  return release
}

/**
 * 惰性建立 remote_commands 状态订阅（单例）。
 */
function ensureCommandsChannel(sb: ReturnType<typeof getClient> & object): void {
  if (!sb || commandsChannelEntry) return;
  ensureSyncStatusBridge();
  const channel = sb.channel('remote-commands-updates')
    .on('postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'remote_commands',
      },
      (payload: RealtimePayload) => {
        if (commandsChannelEntry !== entry) return
        markSynced()
        const row = payload.new ?? payload.old
        if (!row || typeof row.id !== 'string') return
        const parsed = parseRemoteCommandSnapshot(row)
        if (payload.eventType === 'DELETE') {
          settlePending(row.id)
          return
        }
        if (!parsed || parsed.isCancellation === true) return
        if (shouldPollRemoteCommandStatus(parsed.status)) {
          trackPending(parsed.id)
        } else {
          settlePending(parsed.id)
        }
        dispatchRemoteCommandStatus(parsed)
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
  for (const release of commandStatusCleanupCallbacks) release()
  commandStatusCleanupCallbacks.clear()

  if (syncStatusBridge) {
    syncStatusBridge()
    syncStatusBridge = null
  }
  reconnectRebuilder.reset()

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

  commandStatusCallbacks.clear()

  // 重置同步状态 + 销毁 client（登出后回到初始，避免旧状态残留）
  resetSyncState();
  disposeClient();
}
