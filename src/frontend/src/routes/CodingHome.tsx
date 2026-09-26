import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Mic, MessageSquare, Plus, Send, Sparkles, X, XCircle } from 'lucide-react';
import { api, authHeaders } from '../api/client';
import { fetchEvents } from '../api/streamClient';
import { EmptyState, PageHeader, PageShell, Panel } from '../components/ui';
// Phase 5：会话视图收敛到共享实现（与 Chat 同一气泡/活动流/失败态）
import {
  ConversationActivityStream,
  ConversationMessageBubble,
  StreamFailureState,
} from '../components/conversation';
import { useMessagePolling } from '../hooks/useMessagePolling';
// 发送/流式/stop/loop/reasoning 全部走共享实现，页面不再持有内联流循环
import {
  createStreamFailure,
  useStreamSend,
  type Attachment,
  type StreamFailure,
} from '../hooks/useStreamSend';
import { useActivityStore } from '../store/activityStore';

// ============================================================
// 边界类型（后端 payload 经 api/client 返回 any，此处只做结构化收窄）
// ============================================================

/** AI Provider 选项（模型/模式选择器用） */
export interface ProviderOption {
  readonly id: string;
  readonly name?: string;
  readonly models?: string[];
  readonly defaultModel?: string;
  readonly capabilities?: string[];
}

/** 会话消息（与 useMessagePolling 的 Message 结构对齐） */
export interface CodingHomeMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly reasoning?: string | null;
  readonly createdAt: string;
  readonly toolCalls?: string | null;
}

interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

/** api.getConversation 返回的消息负载（只声明本页面用到的字段） */
interface ConversationMessagePayload {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly createdAt: string;
  readonly toolResults?: string;
}

export interface RemoteCommandPayload {
  readonly content?: string
  readonly conversationId?: string
  readonly commandId?: string
  readonly id?: string
  readonly receivedAt?: number
}

export interface RemoteCommandStatus {
  readonly command?: {
    readonly conversationId?: string
    readonly status?: string
    readonly error?: string
  }
}

// ── AEX-P0-013：远程命令的系统失败语义 ──────────────────────────────
/** 超过该年龄的指令视为过期，直接忽略（避免处理历史指令） */
export const REMOTE_COMMAND_MAX_AGE_MS = 60_000;
/** 回执轮询间隔 */
export const REMOTE_COMMAND_POLL_INTERVAL_MS = 2_000;
/** 兜底超时：桌面端未在窗口内给出回执 */
export const REMOTE_COMMAND_TIMEOUT_MS = 60_000;
export const REMOTE_COMMAND_TIMEOUT_MESSAGE =
  '桌面端响应超时：60 秒内未收到桌面端 Aether 的回执。请确认桌面端 Aether 正在运行且已配置 AI Provider。';

export interface RemoteCommandHostOptions {
  /** 乐观回显远程指令（用户消息）—— 唯一允许写入消息数组的通道 */
  readonly onUserCommand: (content: string) => void;
  readonly onOpenConversation: (conversationId: string) => Promise<void>;
  /** 系统传输失败 → 独立失败态（错误卡片），绝不伪装成 AI 回答 */
  readonly onFailure: (failure: StreamFailure) => void;
  readonly fetchCommandStatus: (commandId: string) => Promise<RemoteCommandStatus>;
}

export interface RemoteCommandHost {
  /** 处理 window 'remote-command' 事件（新旧载荷形状都接受） */
  readonly handleEvent: (event: Event) => Promise<void>;
  /** 卸载清理：停止轮询/超时并忽略后续事件 */
  readonly dispose: () => void;
}

/**
 * 远程命令宿主：把窗口事件收敛成 { 打开会话 | 轮询回执 | 系统失败态 } 三种结果。
 * 失败只有 onFailure 一个出口 —— 结构上不可能把传输失败写成 assistant 消息。
 */
export function createRemoteCommandHost(options: RemoteCommandHostOptions): RemoteCommandHost {
  let disposed = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
  }

  const openConversation = async (conversationId: string): Promise<void> => {
    if (disposed) return
    try { await options.onOpenConversation(conversationId) } catch { /* 对话可能尚未同步完成，等待下一次事件 */ }
  }

  const handleEvent = async (event: Event): Promise<void> => {
    if (disposed) return
    // 防御性解析：Layout 发送 { detail: { command: {...} } } 或直接 { detail: {...} }
    const detail = (event as CustomEvent<{ command?: RemoteCommandPayload } & RemoteCommandPayload>).detail ?? {}
    const cmd: RemoteCommandPayload | undefined = detail.command ?? detail
    if (!cmd?.content) return
    // 新鲜度校验：过期命令直接忽略
    if (typeof cmd.receivedAt === 'number' && Date.now() - cmd.receivedAt > REMOTE_COMMAND_MAX_AGE_MS) return
    // 字段归一：Layout 发送 id，旧协议发送 commandId
    const commandId: string | undefined = cmd.commandId ?? cmd.id

    options.onUserCommand(cmd.content)
    // 新指令先清掉上一条命令残留的轮询/超时
    clearTimers()

    // 已有 conversationId 则直接打开
    if (cmd.conversationId) { await openConversation(cmd.conversationId); return }
    if (!commandId) return

    const pollCommandStatus = async (): Promise<void> => {
      if (disposed) return
      let status: RemoteCommandStatus
      try { status = await options.fetchCommandStatus(commandId) } catch { return } // 网络错误：下一轮重试
      if (disposed) return
      const command = status.command
      if (command?.conversationId) {
        clearTimers()
        await openConversation(command.conversationId)
        return
      }
      if (command?.status === 'failed') {
        clearTimers()
        options.onFailure({
          message: `桌面端处理远程指令失败：${command.error ?? '桌面端未提供错误信息'}`,
          retryable: true,
        })
      }
    }

    pollTimer = setInterval(() => { void pollCommandStatus() }, REMOTE_COMMAND_POLL_INTERVAL_MS)
    timeoutTimer = setTimeout(() => {
      if (disposed) return
      clearTimers()
      options.onFailure({ message: REMOTE_COMMAND_TIMEOUT_MESSAGE, retryable: true })
    }, REMOTE_COMMAND_TIMEOUT_MS)
  }

  return {
    handleEvent,
    dispose: () => { disposed = true; clearTimers() },
  }
}

// Web Speech API —— 结构化类型，避免 any
interface SpeechAlternativeLike {
  readonly transcript: string
}

interface SpeechResultLike {
  readonly isFinal: boolean
  readonly 0: SpeechAlternativeLike
}

interface SpeechEventLike {
  readonly resultIndex: number
  readonly results: ArrayLike<SpeechResultLike>
}

interface SpeechErrorEventLike {
  readonly error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: SpeechErrorEventLike) => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionCtor
  webkitSpeechRecognition?: SpeechRecognitionCtor
}

function isProviderOption(value: unknown): value is ProviderOption {  return typeof value === 'object' && value !== null && typeof (value as ProviderOption).id === 'string'
}

/** Provider 列表边界解析：只接受带字符串 id 的对象 */
function toProviderOptions(raw: unknown): ProviderOption[] {
  return Array.isArray(raw) ? raw.filter(isProviderOption) : []
}

function firstTextProvider(providers: readonly ProviderOption[]): ProviderOption | undefined {
  return providers.find(p => p.capabilities?.includes('text')) ?? providers[0]
}

function resolveModel(provider: ProviderOption, preferred: string): string {
  if (preferred) return preferred
  const [firstModel] = provider.models ?? []
  return firstModel ?? provider.defaultModel ?? 'gpt-4o'
}

/** 从 toolResults JSON 中提取 reasoning（失败即视为无 reasoning） */
function readReasoning(toolResults: string | undefined): string | undefined {
  if (!toolResults) return undefined
  try {
    const parsed: unknown = JSON.parse(toolResults)
    if (typeof parsed === 'object' && parsed !== null) {
      const reasoning = (parsed as { reasoning?: unknown }).reasoning
      if (typeof reasoning === 'string' && reasoning) return reasoning
    }
  } catch { /* toolResults 非 JSON 时忽略 */ }
  return undefined
}

function isComposing(event: React.KeyboardEvent<HTMLInputElement>): boolean {
  return (event.nativeEvent as unknown as { isComposing: boolean }).isComposing
}

export function CodingHome() {
  const location = useLocation(); // 监听 remote 参数变化，触发远程命令重新检查
  // 对话列表由 Layout 侧栏持有：本页只写缓存（conversations-changed 事件驱动侧栏刷新）
  const [, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CodingHomeMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [recording, setRecording] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 附件 ref — 同步存储，确保 submitMessage 发送时一定能拿到最新附件
  const attachmentsRef = useRef<Attachment[]>([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [streamTokens, setStreamTokens] = useState<{ prompt_tokens: number; completion_tokens: number; total_tokens: number } | null>(null);
  const [currentConvTokenTotal, setCurrentConvTokenTotal] = useState(0);
  // 审计修复：加载错误状态（替代静默吞错）
  const [loadError, setLoadError] = useState<string | null>(null);
  // 流式失败独立状态（与 Chat 一致，不追加进助手正文）
  const [directFailure, setDirectFailure] = useState<StreamFailure | null>(null);
  // 权限等级 + 模式切换 + 重试状态 + 工作目录
  const [permissionLevel, setPermissionLevel] = useState<number>(2);
  const [mode, setMode] = useState<'normal' | 'super'>('normal');
  const [deepThinking, setDeepThinking] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [loopMode, setLoopMode] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxRetries: number; status: number; delay: number } | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  // 整改计划第 5 章（P1）：循环模式指标 —— 从 activityStore 终态事件读取
  const [loopMetrics, setLoopMetrics] = useState<{ turnsUsed: number; elapsedMs: number; toolCalls: number; budgetExceeded: string | null } | null>(null);
  // 模型选择器：当前选中的 provider 与 model
  const [selectedProvider, setSelectedProvider] = useState<ProviderOption | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  // 标记是否已初始化过 selectedProvider（防止 load() 覆盖用户手动选择）
  const providerInitialized = useRef(false);
  const currentConvRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 首条消息竞态修复：标记"刚由用户发送产生的会话切换"——挂载检查 effect
  // 借此跳过对刚发起 run 的 /agents/cancel（否则新 run 被 mount effect 取消，
  // 导致 AI 生成中断 "This operation was aborted"、首条消息不回复）。
  const justSentRef = useRef(false);

  // 整改计划第 3 章（P0）：setActiveConversation — 同步 state + ref（+ 中断旧请求）。
  // 原实现仅 setState，currentConvRef 由 useEffect 延迟同步；新建对话后立即发送时
  // ref 尚未更新 → 共享 hook 内 currentConvRef.current !== convId 守卫丢弃首条消息 SSE 事件。
  const setActiveConversation = useCallback((id: string | null) => {
    currentConvRef.current = id;
    // 中断旧会话的 in-flight 请求（切换/新建/删除时取消旧轮询与流）
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* ignore */ }
      abortRef.current = null;
    }
    // 递增轮询请求代次，丢弃过期响应
    msgPollReqIdRef.current += 1;
    activityPollReqIdRef.current += 1;
    setCurrentConvId(id);
  }, []);
  // Oracle 修复：rAF 卸载清理 — 防止组件卸载后 setMessages 警告
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // FE-06: once-guard for initial load (StrictMode-safe)
  const initializedRef = useRef(false);
  // FE-08: request-sequence guard for message polling (discard stale responses)
  const msgPollReqIdRef = useRef(0);
  // FE-RACE-01: 活动轮询独立请求 ID，避免与消息轮询互相干扰
  const activityPollReqIdRef = useRef(0);
  // FE-RACE-02: 会话切换加载请求序列守卫，防止快速切换时旧响应覆盖新数据
  const loadReqIdRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const plusRef = useRef<HTMLDivElement>(null);

  // 加载会话：消息 + token 统计 + Activity 事件回放（切换会话时的唯一加载入口）
  const loadMessages = useCallback(async (id: string) => {
    // FE-RACE-02: 请求序列守卫 — 切换会话时递增，丢弃过期响应
    const reqId = ++loadReqIdRef.current;
    try {
      const conv = await api.getConversation(id);
      // 守卫：若已发起新的加载请求，丢弃当前响应
      if (reqId !== loadReqIdRef.current) return;
      setActiveConversation(id);
      setMessages(((conv.messages ?? []) as ConversationMessagePayload[]).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        reasoning: readReasoning(m.toolResults),
      })));
      setCurrentConvTokenTotal(typeof conv.tokenTotal === 'number' ? conv.tokenTotal : 0);
      setStreamTokens(null);
      setLoadError(null);
      setDirectFailure(null);
      // Event Log 回放：刷新/切对话后从 activity_events 重建 Activity Stream
      // 同样应用序列守卫，防止 fetchEvents 过期响应污染
      try {
        const events = await fetchEvents(id);
        if (reqId !== loadReqIdRef.current) return;
        useActivityStore.getState().replaceEvents(id, events);
      } catch { /* 无事件表数据时静默，降级为纯消息视图 */ }
    } catch (e: unknown) {
      // 守卫：若已发起新的加载请求，丢弃当前错误处理
      if (reqId !== loadReqIdRef.current) return;
      // 审计修复：消息加载失败不再静默，记录错误供 UI 显示
      setLoadError(e instanceof Error ? e.message : '加载消息失败');
    }
  }, [setActiveConversation]);

  const load = useCallback(async () => {
    let providerOptions: ProviderOption[] = []
    try {
      const [convs, loadedProvs] = await Promise.all([
        api.getConversations(),
        api.getProviders(),
      ]);
      providerOptions = toProviderOptions(loadedProvs);
      setConversations((convs ?? []) as ConversationSummary[]);
      setProviders(providerOptions);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : '加载数据失败');
    }
    // 加载权限等级 + 工作目录
    api.getPermissions().then(res => setPermissionLevel(res?.level ?? 2)).catch(() => {});
    api.getWorkspace().then(res => setWorkspacePath(typeof res?.defaultDir === 'string' ? res.defaultDir : '')).catch(() => {});
    // 加载默认 text provider 并设为选中（仅首次加载时，不覆盖用户手动切换）
    api.getDefaultProviders().then(res => {
      const preferredId = res?.text
      if (!preferredId || providerInitialized.current) return
      const preferred = providerOptions.find(p => p.id === preferredId)
      if (!preferred) return
      setSelectedProvider(preferred)
      setSelectedModel(resolveModel(preferred, ''))
      providerInitialized.current = true
    }).catch(() => {});
    // 兜底：如果未初始化且未设置默认，用第一个可用 text provider
    if (!providerInitialized.current && providerOptions.length > 0) {
      const fallback = firstTextProvider(providerOptions)
      if (fallback) {
        setSelectedProvider(fallback);
        setSelectedModel(resolveModel(fallback, ''));
        providerInitialized.current = true;
      }
    }
  }, []);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      load();
    }
  }, [load]);
  // P0 通知幂等化：权限请求统一由 App Shell/Layout 发起（单一入口），业务页不再散调
  useEffect(() => { currentConvRef.current = currentConvId; }, [currentConvId]);

  // Q1 彻底修复：检测 URL ?new=true 参数，强制进入新对话空白页。
  // 必须在所有其他 useEffect 之前执行，确保先清空状态再处理远程命令/自动创建。
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('new') === 'true') {
      window.history.replaceState({}, '', '/command-center');
      sessionStorage.removeItem('aether_pending_remote');
      setActiveConversation(null);
      setMessages([]);
      setCurrentConvTokenTotal(0);
      setStreamTokens(null);
      setDirectFailure(null);
      // 不再重复调用 load()，初始化已由 mount effect 完成
    }
    // 检测 ?selectConv=xxx 参数：从对话记录面板选择对话后，加载该对话
    const selectConv = params.get('selectConv');
    if (selectConv) {
      window.history.replaceState({}, '', '/command-center');
      // 延迟执行，确保组件已就绪
      setTimeout(() => { void loadMessages(selectConv); }, 100);
    }
  }, [location.search, loadMessages, setActiveConversation]);

  // P1 修复：组件卸载时停止语音识别/录音，释放麦克风流与浏览器资源（防内存/设备占用泄漏）
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      } catch { /* ignore */ }
      recognitionRef.current = null;
      mediaRecorderRef.current = null;
    };
  }, []);

  // ============================================================
  // 远程命令处理：监听 Layout 分发的 'remote-command' 窗口事件
  // Layout 现在是唯一的轮询者，通过 window.dispatchEvent(new CustomEvent('remote-command', { detail }))
  // 将命令载荷交给 createRemoteCommandHost。失败（超时/桌面端报错）只经 onFailure
  // 进入 directFailure → StreamFailureState 错误卡片，绝不写入助手正文。
  // ============================================================
  useEffect(() => {
    const host = createRemoteCommandHost({
      onUserCommand: (content) => {
        setMessages([{
          id: `remote-u-${Date.now()}`,
          role: 'user',
          content,
          createdAt: new Date().toISOString(),
        }]);
      },
      onOpenConversation: loadMessages,
      onFailure: setDirectFailure,
      fetchCommandStatus: async (commandId) => {
        const res = await fetch(`/api/sync/command-status?commandId=${encodeURIComponent(commandId)}`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok) throw new Error(`command-status ${res.status}`);
        return (await res.json()) as RemoteCommandStatus;
      },
    });
    const listener = (e: Event) => { void host.handleEvent(e); };
    window.addEventListener('remote-command', listener);
    return () => {
      window.removeEventListener('remote-command', listener);
      host.dispose();
    };
  }, [loadMessages]);

  // 监听 select-conversation 事件：从 Layout 的对话记录面板选择对话后加载
  useEffect(() => {
    const handler = (e: Event) => {
      const convId = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (convId) void loadMessages(convId);
    };
    window.addEventListener('select-conversation', handler);
    return () => window.removeEventListener('select-conversation', handler);
  }, [loadMessages]);

  // ============================================================
  // 智能滚动：用户手动滚动查看历史时停止自动滚动
  // ============================================================
  const messageListRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // 检测用户是否在底部附近（阈值 40px —— 用户小幅上滑仍应判定"在底部"）
  const isNearBottom = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const handleScroll = useCallback(() => {
    setUserScrolledUp(!isNearBottom());
  }, [isNearBottom]);

  const scrollToBottom = useCallback(() => {
    setUserScrolledUp(false);
    const el = messagesEndRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // 用户发送时强制回到底部（发送是主动行为，不受上滑锁定影响）
  useEffect(() => {
    if (sending) scrollToBottom();
  }, [sending, scrollToBottom]);

  // 新消息到达时，只在用户未手动滚动时自动跳到底部
  useEffect(() => {
    if (userScrolledUp) return;
    const el = messagesEndRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, userScrolledUp]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [plusMenuOpen]);

  // 整改计划第 3 章（P0）：显式状态机 {idle,polling,error,retrying} + AbortController + retry
  // P0 通知幂等化：CodingHome 不持有自己的 notifiedRef / 不由 polling 发通知 ——
  // 通知唯一来源是 Run terminal event → NotificationCenter（共享 hook 的 envelope 分支）
  const { pollStatus: msgPollStatus, pollErrorInfo: msgPollErrorInfo, retry: retryPolling } = useMessagePolling({
    conversationId: currentConvId,
    enabled: !!currentConvId,
    intervalMs: 1000,
    onMessagesUpdate: (updater) => setMessages(updater),
    onTokenTotalUpdate: (total) => setCurrentConvTokenTotal((prev) => Math.max(prev, total)),
    onSendingUpdate: setSending,
    currentConvRef,
    msgPollReqIdRef,
    activityPollReqIdRef,
    mountedRef,
    // FE-ERR-06: 轮询错误回调，设置 loadError 状态供 UI 显示
    onPollError: (error) => setLoadError(`轮询失败: ${error.message}`),
  });

  // ============================================================
  // 共享发送实现（与 Chat 同一 hook）—— 页面只提供配置与差异化 UI
  // ============================================================
  const {
    handleSend: sendThroughSharedHook,
    stopGeneration,
    failure,
  } = useStreamSend({
    conversationId: currentConvId,
    mode,
    messages,
    deepThinking,
    webSearch,
    loopMode,
    selectedProvider,
    selectedModel,
    attachments,
    onSendStart: () => {
      setSending(true);
      setRetryInfo(null);
      setStreamTokens(null);
      setLoopMetrics(null);
      setLoadError(null);
      setDirectFailure(null);
    },
    onSendEnd: (success) => {
      setSending(false);
      setRetryInfo(null);
      if (!success) return;
      // 侧栏对话列表刷新（Layout 唯一轮询者）
      window.dispatchEvent(new CustomEvent('conversations-changed'));
    },
    onTokens: setStreamTokens,
    onRetry: setRetryInfo,
    onMessagesUpdate: (updater) => setMessages(updater),
    onLoadMessages: loadMessages,
    onLoadConversations: load,
    currentConvRef,
    abortRef,
    mountedRef,
  });
  const visibleFailure = failure ?? directFailure

  /** 失败重试：重新发送最后一条用户指令（远程指令同样以用户消息进入该列表） */
  const retryLastSend = useCallback(() => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const content = lastUser?.content.trim() ?? '';
    if (!content) return;
    void sendThroughSharedHook(content);
  }, [messages, sendThroughSharedHook]);

  // 整改计划第 5 章（P1）：循环模式指标 —— 从 activityStore 终态事件读取（与 Chat 同一来源）
  // Run 作用域回溯：每个 Run 的 seq 独立，跨 Run 合并排序不可靠，必须逐 Run 逆序找终态。
  useEffect(() => {
    if (!currentConvId) { setLoopMetrics(null); return; }
    const store = useActivityStore.getState();
    const runIds = store.getRunsForConversation(currentConvId);
    for (let i = runIds.length - 1; i >= 0; i--) {
      const events = store.getEventsByRun(runIds[i]);
      for (let j = events.length - 1; j >= 0; j--) {
        const ev = events[j];
        const meta = ev.metadata;
        if ((ev.eventType === 'task.completed' || ev.eventType === 'task.failed') && meta && typeof meta.turnsUsed === 'number') {
          setLoopMetrics({
            turnsUsed: Number(meta.turnsUsed),
            elapsedMs: Number(meta.elapsedMs || 0),
            toolCalls: Number(meta.toolCalls || 0),
            budgetExceeded: meta.budgetExceeded ? String(meta.budgetExceeded) : null,
          });
          return;
        }
      }
    }
  }, [currentConvId, sending]);

  // 处理"新对话"：只清空当前对话状态，不在数据库创建空对话。
  // 空对话会在用户首次发送消息时由 submitMessage 自动创建。
  const handleNew = useCallback(() => {
    setPlusMenuOpen(false);
    setActiveConversation(null);
    setMessages([]);
    setCurrentConvTokenTotal(0);
    setStreamTokens(null);
    setRetryInfo(null);
    setDirectFailure(null);
    setLoadError(null);
  }, [setActiveConversation]);

  /**
   * 发送入口 —— 唯一职责是"确保会话存在"，流式/停止/失败/Activity 全部交给共享 hook。
   * 附件在同一次事件处理内随 setAttachments([]) 一起清空，因此这里调用的是
   * 清空前那次渲染的 handleSend 闭包（仍持有本轮附件），与旧实现语义一致。
   */
  const submitMessage = useCallback(async () => {
    const content = input.trim();
    const currentAttachments = [...attachmentsRef.current];
    // 允许纯发图片（无文字时），content 为空但有附件时仍可发送
    if ((!content && currentAttachments.length === 0) || sending) return;
    setInput('');
    setAttachments([]);
    attachmentsRef.current = [];

    if (currentConvId) {
      // 已有会话发送：标记 justSent，避免 mount effect 误 cancel 刚注册的 run
      justSentRef.current = true;
      await sendThroughSharedHook(content);
      return;
    }

    // 首条消息：先创建会话（provider 缺失时给出独立失败态，不弹窗）
    const provider = selectedProvider ?? providers[0];
    if (!provider) {
      setDirectFailure(createStreamFailure('请先在「设置 → AI Provider」中配置 API Key 后再发送。'));
      return;
    }
    const conv = await api.createConversation({
      // 纯图片发送时用默认标题
      title: (content || '图片消息').slice(0, 30),
      providerId: provider.id,
      model: resolveModel(provider, selectedModel),
    });
    justSentRef.current = true;
    // 立即同步 currentConvRef（共享 hook 的守卫依赖 ref，非 state）
    setActiveConversation(conv.id);
    // 修复：创建新对话后立即刷新对话列表，否则新对话不会出现在侧栏中
    void load();
    window.dispatchEvent(new CustomEvent('conversations-changed'));
    await sendThroughSharedHook(content);
  }, [
    input,
    sending,
    currentConvId,
    selectedProvider,
    selectedModel,
    providers,
    load,
    sendThroughSharedHook,
    setActiveConversation,
  ]);

  // 挂载时检查对话是否正在生成中（切换页面后恢复动画用）
  useEffect(() => {
    if (!currentConvId) return;
    let cancelled = false;
    fetch(`/api/conversations/${currentConvId}/status`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).then(r => r.json()).then(data => {
      if (!cancelled && data.generating) {
        setSending(true);
      }
    }).catch(() => {});
    // 同时检查 agents 端 —— 修复：若这是"刚发送消息触发的会话切换"（justSentRef），
    // 跳过 /agents/cancel，避免取消刚注册的新 run（导致首条消息被中断）。
    if (justSentRef.current) {
      justSentRef.current = false;
      return;
    }
    fetch('/api/agents/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...authHeaders() },
      body: JSON.stringify({ conversationId: currentConvId }),
    }).then(r => r.json()).then(data => {
      if (!cancelled && data.success === false && data.message === '没有正在进行的生成') {
        // 没有进行中的生成，不操作
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentConvId]);

  // Voice input: Web Speech API with real-time transcription (like Codex dictation)
  const toggleVoice = useCallback(() => {
    if (recording) {
      if (recognitionRef.current) recognitionRef.current.stop();
      else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop();
      setRecording(false);
      return;
    }

    const speechWindow = window as unknown as SpeechRecognitionWindow
    const SpeechRecognitionCtorImpl = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (SpeechRecognitionCtorImpl) {
      const recognition = new SpeechRecognitionCtorImpl();
      // 修复：中文语音识别 + 连续模式 + 实时中间结果
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      let finalTranscript = '';
      recognition.onresult = (event: SpeechEventLike) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) finalTranscript += result[0].transcript;
          else interim += result[0].transcript;
        }
        // 实时更新输入框：已确认文本 + 中间识别文本
        const display = (finalTranscript + interim).trim();
        if (display) setInput(display);
      };
      recognition.onend = () => {
        setRecording(false);
        // 最终确认的文本保留在 input 中
      };
      recognition.onerror = (event: SpeechErrorEventLike) => {
        setRecording(false);
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          console.warn('语音识别错误:', event.error);
        }
      };
      recognitionRef.current = recognition;
      try {
        recognition.start();
        setRecording(true);
      } catch { setRecording(false); }
      return;
    }

    // Fallback: MediaRecorder → backend STT (works in Electron)
    if (!navigator.mediaDevices?.getUserMedia) {
      setDirectFailure(createStreamFailure('语音输入不可用，需要麦克风权限。'));
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecording(false);
        if (audioChunksRef.current.length === 0) return;
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = typeof reader.result === 'string' ? reader.result : '';
          try {
            const res = await fetch('/api/conversations/stt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...authHeaders() },
              body: JSON.stringify({ audio: base64 }),
            });
            if (res.ok) {
              const { text } = (await res.json()) as { text?: string };
              if (text) setInput(prev => (prev ? `${prev} ${text}` : text));
            }
          } catch { /* ignore */ }
        };
        reader.readAsDataURL(audioBlob);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    }).catch(() => {
      setRecording(false);
      setDirectFailure(createStreamFailure('麦克风访问被拒绝。'));
    });
  }, [recording]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        if (typeof dataUrl !== 'string') return;
        const attachment: Attachment = { name: file.name, dataUrl };
        setAttachments(prev => {
          const next = [...prev, attachment];
          attachmentsRef.current = next;
          return next;
        });
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
    setPlusMenuOpen(false);
  }, []);

  const hasMessages = messages.length > 0
  const contextTokens = Math.round(messages
    .filter(m => m.role !== 'tool')
    .reduce((sum, m) => sum + m.content.length, 0) / 4)
  const textProviders = useMemo(
    () => providers.filter(p => p.capabilities?.includes('text')),
    [providers],
  )

  // CodingHome 差异化 Composer（附件上传 / 语音 / 模型·模式·权限选择）——
  // 发送语义全部由共享 hook 提供，这里只负责输入与开关
  const renderComposer = () => (
    <div style={{ width: '100%', position: 'relative' }}>
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />

      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {attachments.map((attachment, index) => (
            <div key={`${attachment.name}-${index}`} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
              {attachment.dataUrl.startsWith('data:image/') ? (
                <img src={attachment.dataUrl} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 32, height: 32, borderRadius: 4, background: 'var(--sidebar-item-active)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {attachment.name.split('.').pop()?.toUpperCase() || '?'}
                </div>
              )}
              <span style={{ fontSize: 12, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{attachment.name}</span>
              <button
                type="button"
                aria-label={`移除附件 ${attachment.name}`}
                onClick={() => setAttachments(prev => {
                  const next = prev.filter((_, idx) => idx !== index);
                  attachmentsRef.current = next;
                  return next;
                })}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', borderRadius: 14, padding: '0 4px',
        background: 'var(--bg-surface)',
        backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
        WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
        border: '1px solid var(--border-primary)',
        overflow: 'visible',
      }}>
        {/* Plus button (left) */}
        <div ref={plusRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            aria-label="更多操作"
            aria-expanded={plusMenuOpen}
            onClick={(e) => { e.stopPropagation(); setPlusMenuOpen(!plusMenuOpen); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: plusMenuOpen ? 'var(--color-accent)' : 'var(--text-tertiary)', padding: '0 12px', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Plus size={20} />
          </button>
          {plusMenuOpen && (
            <div className="glass-menu" style={{
              position: 'absolute', bottom: 52, left: 0, minWidth: 180, zIndex: 9999,
              borderRadius: 12, padding: 4,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              WebkitClipPath: 'none', clipPath: 'none',
            }}>
              <button type="button" onClick={handleNew} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', borderRadius: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 13 }}>
                <MessageSquare size={16} /> 新建对话
              </button>
              <button type="button" onClick={() => { setPlusMenuOpen(false); fileInputRef.current?.click(); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', borderRadius: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 13 }}>
                <Plus size={16} /> 上传文件
              </button>
            </div>
          )}
        </div>

        {/* Input field (center) — 单行输入，横向延长，不限字数 */}
        <input
          type="text"
          style={{ flex: 1, height: 44, outline: 'none', boxShadow: 'none', border: 'none', background: 'transparent', fontSize: 14, lineHeight: 1, padding: '0 8px', color: 'var(--text-primary)', fontFamily: 'inherit', minWidth: 0 }}
          placeholder="Message Aether..."
          aria-label="消息输入框"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
              e.preventDefault();
              void submitMessage();
            }
          }}
        />

        {/* Mic (right) */}
        <button type="button" onClick={toggleVoice} title="Voice input" aria-label="语音输入"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: recording ? 'var(--color-danger)' : 'var(--text-tertiary)', padding: '0 8px', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Mic size={18} />
        </button>

        {/* Stop/Send (right) —— 停止生成走共享 hook */}
        {sending ? (
          <button type="button" onClick={stopGeneration}
            title="停止生成" aria-label="停止生成"
            style={{ flexShrink: 0, height: 44, borderRadius: 8, padding: '0 16px', border: 'none', margin: '0 4px 0 0', background: 'none', cursor: 'pointer', color: 'var(--color-danger)' }}>
            <XCircle size={18} />
          </button>
        ) : (
          <button type="button" onClick={() => { void submitMessage(); }} disabled={sending || !input.trim()}
            className="btn btn-primary" aria-label="发送"
            style={{ flexShrink: 0, height: 44, borderRadius: 8, padding: '0 16px', border: 'none', margin: '0 4px 0 0' }}>
            <Send size={18} />
          </button>
        )}
      </div>

      {/* 重试状态提示 */}
      {retryInfo && (
        <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--color-warning)' }}>
          请求失败 ({retryInfo.status})，{retryInfo.attempt}/{retryInfo.maxRetries} 次重试中...
        </div>
      )}

      {/* Token stats bar + 模式切换 + 权限等级 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 8px 4px', fontSize: 11, color: 'var(--text-tertiary)', flexWrap: 'wrap', borderTop: '1px solid var(--border-primary)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {hasMessages && <span>📖 上下文: {contextTokens > 0 ? `${contextTokens.toLocaleString()} tokens` : `${messages.length} 条消息`}</span>}
          {hasMessages && currentConvTokenTotal > 0 && <span>⚡ 对话累计: {currentConvTokenTotal.toLocaleString()} tokens</span>}
          {hasMessages && currentConvTokenTotal === 0 && !sending && <span>⚡ 对话累计: 暂无数据</span>}
          {streamTokens && <span>· 本次: {streamTokens.total_tokens.toLocaleString()} tokens</span>}
          {/* 整改计划第 5 章（P1）：循环模式指标 —— 已用轮数/时长/工具调用 */}
          {loopMode && loopMetrics && !sending && (
            <span style={{ color: 'var(--color-warning)' }} title={loopMetrics.budgetExceeded ? `预算耗尽: ${loopMetrics.budgetExceeded}` : undefined}>
              ♾️ {loopMetrics.turnsUsed} 轮 · {(loopMetrics.elapsedMs / 1000).toFixed(1)}s · {loopMetrics.toolCalls} 次工具{loopMetrics.budgetExceeded ? ' · ⚠️ 预算耗尽' : ''}
            </span>
          )}
          {workspacePath && <span>📁 <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{workspacePath}</span></span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 模型选择器 */}
          {selectedProvider && (
            <select
              aria-label="选择 AI 模型"
              value={selectedProvider.id}
              onChange={(e) => {
                const picked = providers.find(p => p.id === e.target.value);
                if (picked) {
                  setSelectedProvider(picked);
                  setSelectedModel(resolveModel(picked, ''));
                }
              }}
              style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer', maxWidth: 140 }}
              title="选择 AI 模型（支持多模态的模型可分析图片）"
            >
              {textProviders.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name ?? provider.id}{provider.capabilities?.includes('image') ? ' 📷' : ''}
                </option>
              ))}
            </select>
          )}
          {/* 模式切换 */}
          <button type="button" onClick={() => setMode('normal')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'normal' ? 'rgba(94,158,255,0.3)' : 'transparent'}`, background: mode === 'normal' ? 'rgba(94,158,255,0.12)' : 'var(--bg-surface)', color: mode === 'normal' ? 'var(--color-accent)' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            ⊥ 普通
          </button>
          <button type="button" onClick={() => setMode('super')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'super' ? 'rgba(167,139,250,0.3)' : 'transparent'}`, background: mode === 'super' ? 'rgba(167,139,250,0.12)' : 'var(--bg-surface)', color: mode === 'super' ? '#a78bfa' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            ⊥ 超级
          </button>
          <span style={{ color: 'var(--border-primary)' }}>|</span>
          {/* 深度思考开关（DeepSeek R1 风格 thinking 模式） */}
          <button type="button" onClick={() => setDeepThinking(d => !d)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${deepThinking ? 'rgba(94,158,255,0.3)' : 'transparent'}`, background: deepThinking ? 'rgba(94,158,255,0.12)' : 'var(--bg-surface)', color: deepThinking ? 'var(--color-accent)' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            🧠 深度思考
          </button>
          {/* 联网搜索开关 */}
          <button type="button" onClick={() => setWebSearch(w => !w)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${webSearch ? 'rgba(52,211,153,0.3)' : 'transparent'}`, background: webSearch ? 'rgba(52,211,153,0.12)' : 'var(--bg-surface)', color: webSearch ? 'var(--color-success)' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            🌐 联网搜索
          </button>
          {/* 循环模式开关 — 勾选后 AI 持续执行直到任务完整完成 */}
          <button type="button" onClick={() => setLoopMode(l => !l)}
            title="循环模式：AI 持续执行直到完整完成任务"
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${loopMode ? 'rgba(245,158,11,0.3)' : 'transparent'}`, background: loopMode ? 'rgba(245,158,11,0.12)' : 'var(--bg-surface)', color: loopMode ? '#f59e0b' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            ♾️ 循环
          </button>
          <span style={{ color: 'var(--border-primary)' }}>|</span>
          {/* 权限等级（Level 1:只读 → Level 2:完全 → Level 3:超级） */}
          <button type="button" onClick={() => { const nextLevel = permissionLevel >= 3 ? 1 : permissionLevel + 1; api.setPermissions(nextLevel).then(() => setPermissionLevel(nextLevel)).catch(() => {}); }}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${permissionLevel === 3 ? 'rgba(239,68,68,0.3)' : permissionLevel === 2 ? 'rgba(52,211,153,0.3)' : 'rgba(245,158,11,0.3)'}`, background: permissionLevel === 3 ? 'rgba(239,68,68,0.12)' : permissionLevel === 2 ? 'rgba(52,211,153,0.12)' : 'rgba(245,158,11,0.12)', color: permissionLevel === 3 ? '#ef4444' : permissionLevel === 2 ? 'var(--color-success)' : '#f59e0b', cursor: 'pointer' }}>
            {permissionLevel === 3 ? '🔴 Level 3' : permissionLevel === 2 ? '🔓 Level 2' : '🔒 Level 1'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <PageShell
      className="h-screen max-w-[1280px] px-4!"
      contentClassName="flex flex-col overflow-hidden! p-0!"
      style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}
      header={(
        <PageHeader
          title="Aether"
          description="Describe your idea — vibe code it into reality."
          icon={<Sparkles size={22} />}
          actions={(
            <button type="button" className="btn btn-primary" onClick={handleNew} title="新建对话">
              <Plus size={18} /> 新建对话
            </button>
          )}
        />
      )}
    >
      {/* 审计修复：加载错误提示 banner — 替代静默吞错 */}
      {loadError && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 24px 8px' }}>
          <ErrorBanner message={loadError} onRetry={() => { setLoadError(null); void load(); }} />
        </div>
      )}
      {/* 整改计划第 3 章（P0）：轮询失败显式状态机 —— 重试按钮调用 poll()（而非 load()） */}
      {(msgPollStatus === 'error' || msgPollStatus === 'retrying') && msgPollErrorInfo && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 24px 8px' }}>
          <div style={{ width: '100%', maxWidth: 720, padding: '8px 16px', borderRadius: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--color-warning)', fontSize: 13, textAlign: 'center' }}>
            {msgPollStatus === 'error' ? '⚠️ 消息轮询失败' : '🔄 消息轮询重试中'}：{msgPollErrorInfo.message}
            {msgPollErrorInfo.lastSuccessAt && <span style={{ opacity: 0.7 }}>（最后成功 {new Date(msgPollErrorInfo.lastSuccessAt).toLocaleTimeString()}）</span>}
            {msgPollStatus === 'error' && (
              <button type="button" onClick={() => { setLoadError(null); retryPolling(); }} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>
                立即重试
              </button>
            )}
          </div>
        </div>
      )}

      {!hasMessages ? (
        <Panel tone="subtle" className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8!">
          <div style={{ width: '100%', maxWidth: 840 }}>
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
                {visibleFailure ? (
                  <StreamFailureState failure={visibleFailure} onRetry={retryLastSend} />
                ) : (
                <EmptyState
                  icon={<Sparkles size={48} />}
                  title="What can I build for you?"
                  description="Describe your idea — vibe code it into reality."
                  className="border-0 bg-transparent shadow-none"
                />
              )}
            </motion.div>
            <div style={{ marginTop: 24 }}>{renderComposer()}</div>
          </div>
        </Panel>
      ) : (
        <Panel className="flex min-h-0 flex-1 flex-col p-4!">
          <div
            ref={messageListRef}
            onScroll={handleScroll}
            aria-live="polite"
            className="flex-1 overflow-y-auto min-h-0"
            style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 8px 16px', overflowAnchor: 'none', position: 'relative' }}
          >
            {/* 整改计划第 4 章（P1）：用户上滑阅读时提供"回到底部"按钮（仅用户离开底部时显示） */}
            {userScrolledUp && (
              <button
                type="button"
                onClick={scrollToBottom}
                style={{
                  position: 'sticky', top: 8, zIndex: 5, display: 'block', margin: '0 auto 8px',
                  fontSize: 12, padding: '4px 14px', borderRadius: 99, cursor: 'pointer',
                  background: 'var(--bg-surface)', color: 'var(--color-accent)',
                  border: '1px solid var(--border-primary)', boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
                }}
                title="回到最新消息"
                aria-label="回到底部"
              >
                ⬇ 回到底部
              </button>
            )}
            {messages.map((message, index) => (
              <ConversationMessageBubble key={message.id} message={message} index={index} />
            ))}

            {/* Activity：会话定位活动 Run，时间线由 Run 自己拥有（AEX-P0-012） */}
            <ConversationActivityStream conversationId={currentConvId} />

            {sending && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 4, padding: '12px 16px' }}>
                  {[0, 1, 2].map(i => (
                    <motion.div key={i}
                      style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)' }}
                      animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
                      transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 失败态独立渲染（不追加进助手正文） */}
            {visibleFailure && <StreamFailureState failure={visibleFailure} onRetry={retryLastSend} />}

            <div ref={messagesEndRef} />
          </div>
          {renderComposer()}
        </Panel>
      )}
    </PageShell>
  );
}

/** 加载失败 banner（可重试） */
function ErrorBanner({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <div style={{ width: '100%', maxWidth: 720, padding: '8px 16px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--color-danger)', fontSize: 13, textAlign: 'center' }}>
      ⚠️ {message}
      <button type="button" onClick={onRetry} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>重试</button>
    </div>
  );
}
