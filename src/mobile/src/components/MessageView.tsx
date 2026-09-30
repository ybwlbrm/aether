import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getMessages,
  sendCommand,
  cancelCommand,
  subscribeMessages,
  subscribeRemoteCommandStatus,
  createClientCommandId,
  getSyncState,
  onSyncStateChange,
  type SendResult,
  type LocalMessageState,
} from '../api/supabase';
import { mergeMessages, replaceOptimistic, resolveChatCompletion, type ChatMessage } from '../lib/message-store'
import { getRemainingCommandTimeoutMs, matchesRemoteCommandReference, type RemoteCommandSnapshot } from '../lib/remote-command'
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Plus,
  ArrowUp,
  Square,
  RefreshCw,
  Upload,
} from 'lucide-react';
import AetherMark from './AetherMark';

// ============================================================
// CodeBlock — 弱化边框/行号/背景，代码即内容
// ============================================================
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  const lines = code.split('\n');
  const lineNumWidth = String(lines.length).length;
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{language}</span>
        <span className="md-codeblock-lines-count">{lines.length} 行</span>
        <button className="md-codeblock-copy" onClick={handleCopy}>{copied ? '已复制' : '复制'}</button>
      </div>
      <div className="md-codeblock-lines">
        {lines.map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 10 }}>
            <span className="md-codeblock-lineno" style={{ minWidth: `${lineNumWidth}ch` }}>{i + 1}</span>
            <span>{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Markdown 渲染（react-markdown + remark-gfm，统一 renderer）
function MarkdownContent({ content }: { content: string }) {
  if (!content) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const codeText = String(children).replace(/\n$/, '');
          if (match && codeText.includes('\n')) {
            return <CodeBlock language={match[1]} code={codeText} />;
          }
          return <code className="md-inline-code" {...props}>{children}</code>;
        },
        pre({ children }) { return <>{children}</>; },
        table({ children }) {
          return <div className="md-table-wrap"><table>{children}</table></div>;
        },
        th({ children }) { return <th>{children}</th>; },
        td({ children }) { return <td>{children}</td>; },
        a({ href, children }) { return <a className="md-link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>; },
        img({ src, alt }) {
          if (src?.startsWith('data:') || src?.startsWith('http')) {
            return <img className="md-img" src={src} alt={alt} />;
          }
          return <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>[图片]</span>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// Reasoning — 极轻执行状态（processing 计时 / completed 静态）
function ReasoningBlock({ reasoning, active }: { reasoning: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
  }, []);

  useEffect(() => {
    if (!active) return;
    setElapsed(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
    const t = setInterval(() => {
      setElapsed(Math.round((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [active]);

  const lines = reasoning.split('\n').filter(Boolean);
  return (
    <div className={`msg-reasoning ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}>
      <div className="msg-reasoning-head">
        <span className={`msg-reasoning-dot ${active ? 'active' : 'done'}`} />
        {active ? (
          <span className="msg-reasoning-label">正在处理</span>
        ) : (
          <span className="msg-reasoning-label">已完成</span>
        )}
        {active && <span className="msg-reasoning-time">· {elapsed}s</span>}
        {!active && <span className="msg-reasoning-time">· 查看过程</span>}
        <ChevronRight size={14} className="msg-reasoning-chevron" />
      </div>
      {open && (
        <div className="msg-reasoning-body">
          {lines.map((l, i) => <p key={i} style={{ marginBottom: 4 }}>{l}</p>)}
        </div>
      )}
    </div>
  );
}

interface ParsedToolResult {
  tool_name?: string;
  status?: string;
  reasoning?: string;
  total_tokens?: number;
  [key: string]: unknown;
}

function safeParse(json?: string | null): ParsedToolResult | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as ParsedToolResult) : null;
  } catch { return null; }
}

// 本地发送状态附加在乐观消息上（不落库，仅 UI 展示）
interface LocalMeta {
  localState?: LocalMessageState
  localError?: string
  localClientCommandId?: string
  localCommandPayload?: string
}

type ViewMessage = ChatMessage & LocalMeta;

interface Props {
  conversationId: string;
  conversationTitle: string;
  onBack: () => void;
}

// 状态机（§15）
type ExecutionPhase =
  | 'idle'
  | 'sending'
  | 'queued'
  | 'waiting'
  | 'processing'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelling'
  | 'cancel_timeout'
  | 'cancelled';

const CANCEL_CONFIRM_TIMEOUT_MS = 15_000

export default function MessageView({ conversationId, conversationTitle, onBack }: Props) {
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<ExecutionPhase>('idle');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [mode, setMode] = useState<'normal' | 'super'>('normal');
  const [permissionLevel, setPermissionLevel] = useState(2);
  const [deepThinking, setDeepThinking] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [loopMode, setLoopMode] = useState(false);
  const [convTokenTotal, setConvTokenTotal] = useState(0);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [templates, setTemplates] = useState<{ name: string; content: string }[]>([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveReasoning, setLiveReasoning] = useState<string>('');
  // 附件（§ 从 NewCommand 迁移：图片/文本/文件）
  const [imageAttachments, setImageAttachments] = useState<string[]>([]);
  const [fileAttachments, setFileAttachments] = useState<{ name: string; dataUrl: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // P0-A08：Realtime 连接状态（connected 不轮询，断开降级轮询）
  const [syncStatus, setSyncStatus] = useState(() => getSyncState().status);
  const reasoningBarRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 当前请求绑定（timeout 与终态结算均绑定当前 command，旧事件不影响新命令）
  const activeCommandIdRef = useRef<string | null>(null)
  const activeClientCommandIdRef = useRef<string | null>(null)
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null)
  const [activeClientCommandId, setActiveClientCommandId] = useState<string | null>(null)
  const operationIdRef = useRef(0)
  const mountedRef = useRef(true)
  const sendInFlightRef = useRef(false)
  const stopRequestedRef = useRef(false)
  const commandDeadlineRef = useRef<number | null>(null)
  const phaseRef = useRef<ExecutionPhase>('idle')
  const latestUserMsgAtRef = useRef<string | null>(null)
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [newWhileAway, setNewWhileAway] = useState(false);
  // 发送中用户消息 id（§8：离线入队不删除，用于重发定位）
  const sendingUserMsgRef = useRef<string | null>(null);

  const phaseIsActive = ['sending', 'queued', 'waiting', 'processing', 'streaming', 'timeout', 'cancelling', 'cancel_timeout'].includes(phase)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const appendSystemMessage = useCallback((content: string) => {
    setMessages((previous) => [...previous, {
      id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'system',
      content,
      created_at: new Date().toISOString(),
    }]);
  }, []);

  const clearCommandTimers = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (cancelTimeoutRef.current) clearTimeout(cancelTimeoutRef.current);
    timeoutRef.current = null;
    cancelTimeoutRef.current = null;
  }, []);

  const updatePhase = useCallback((next: ExecutionPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const resetCommandBinding = useCallback(() => {
    activeCommandIdRef.current = null
    activeClientCommandIdRef.current = null
    setActiveCommandId(null)
    setActiveClientCommandId(null)
    commandDeadlineRef.current = null
    stopRequestedRef.current = false
  }, [])

  const armCommandTimeout = useCallback((operationId: number) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    const deadline = commandDeadlineRef.current
    if (deadline === null) return
    const delay = getRemainingCommandTimeoutMs(deadline, Date.now())
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      if (!mountedRef.current || operationIdRef.current !== operationId) return
      const current = phaseRef.current
      if (['cancelling', 'cancel_timeout', 'completed', 'failed', 'cancelled'].includes(current)) return
      const hasCommand = activeCommandIdRef.current ?? activeClientCommandIdRef.current
      if (!hasCommand) return
      updatePhase('timeout')
      appendSystemMessage('等待桌面端响应超时，请检查 Aether 桌面端是否运行')
    }, delay)
  }, [appendSystemMessage, updatePhase])

  const requestCancellation = useCallback(async (clientCommandId: string, operationId: number) => {
    if (!mountedRef.current || operationIdRef.current !== operationId) return
    if (activeClientCommandIdRef.current !== clientCommandId) return
    if (cancelTimeoutRef.current) return

    clearCommandTimers()
    updatePhase('cancelling')
    setLiveReasoning('')
    cancelTimeoutRef.current = setTimeout(() => {
      cancelTimeoutRef.current = null
      if (!mountedRef.current || operationIdRef.current !== operationId) return
      updatePhase('cancel_timeout')
      appendSystemMessage('停止请求已发送，但等待桌面端确认超时')
    }, CANCEL_CONFIRM_TIMEOUT_MS)

    const result = await cancelCommand(conversationId, clientCommandId)
    if (!mountedRef.current || operationIdRef.current !== operationId) return
    if (activeClientCommandIdRef.current !== clientCommandId) return

    if (result.status === 'cancelled_locally') {
      clearCommandTimers()
      operationIdRef.current += 1
      sendInFlightRef.current = false
      resetCommandBinding()
      updatePhase('cancelled')
      appendSystemMessage('已取消尚未发送的本地命令')
      return
    }
    if (result.status === 'failed') {
      clearCommandTimers()
      if (sendInFlightRef.current) {
        appendSystemMessage('停止请求等待发送完成，提交后将继续停止')
        return
      }
      updatePhase(activeCommandIdRef.current ? 'waiting' : 'queued')
      armCommandTimeout(operationId)
      appendSystemMessage(`停止失败：${result.message}，原命令仍保持等待终态`)
    }
  }, [appendSystemMessage, armCommandTimeout, clearCommandTimers, conversationId, resetCommandBinding, updatePhase])

  const mergeServerMessages = useCallback((existing: ViewMessage[], incoming: ViewMessage[]) => {
    const optimisticId = sendingUserMsgRef.current;
    const latestUserAt = latestUserMsgAtRef.current;
    if (!optimisticId || !latestUserAt) return mergeMessages(existing, incoming);

    const serverUserMessage = incoming.find((message) =>
      message.role === 'user'
      && !message.id.startsWith('temp-')
      && new Date(message.created_at).getTime() >= new Date(latestUserAt).getTime()
    );
    if (!serverUserMessage) return mergeMessages(existing, incoming);

    sendingUserMsgRef.current = null;
    const remaining = incoming.filter((message) => message.id !== serverUserMessage.id);
    return mergeMessages(replaceOptimistic(existing, serverUserMessage), remaining);
  }, []);

  const settleRemoteCommand = useCallback((snapshot: RemoteCommandSnapshot) => {
    const currentClientId = activeClientCommandIdRef.current
    const currentReference = currentClientId && activeCommandIdRef.current === currentClientId
      ? { serverId: null, clientCommandId: currentClientId }
      : { serverId: activeCommandIdRef.current, clientCommandId: currentClientId }
    if (!matchesRemoteCommandReference(snapshot, currentReference)) return

    if (activeCommandIdRef.current !== snapshot.id) {
      activeCommandIdRef.current = snapshot.id
      setActiveCommandId(snapshot.id)
    }
    const completion = resolveChatCompletion({
      kind: 'remote_command_status',
      status: snapshot.status,
    })
    if (completion.kind === 'busy') {
      if (phaseRef.current === 'queued') {
        phaseRef.current = 'waiting'
        setPhase('waiting')
      }
      return
    }

    clearCommandTimers()
    setLiveReasoning('')
    operationIdRef.current += 1
    sendInFlightRef.current = false
    stopRequestedRef.current = false
    commandDeadlineRef.current = null
    activeCommandIdRef.current = null
    activeClientCommandIdRef.current = null
    setActiveCommandId(null)
    setActiveClientCommandId(null)

    switch (completion.kind) {
      case 'completed':
        phaseRef.current = 'completed'
        setPhase('completed')
        return
      case 'cancelled':
        phaseRef.current = 'cancelled'
        setPhase('cancelled')
        appendSystemMessage('桌面端已确认停止当前任务')
        return
      case 'failed':
        phaseRef.current = 'failed'
        setPhase('failed')
        appendSystemMessage(snapshot.error ?? '桌面端命令执行失败')
        return
      default: {
        const unreachable: never = completion
        return unreachable
      }
    }
  }, [appendSystemMessage, clearCommandTimers])

  // ========== 历史加载（§25 分页：最近 N 条 + 向上加载更早） ==========
  const loadMessages = useCallback(async () => {
    try {
      const res = await getMessages(conversationId, { limit: 100 });
      if (res.error) {
        setLoadError(res.error.message);
        setLoading(false);
        return;
      }
      const data = (res.data ?? []) as ViewMessage[];
      setMessages((prev) => mergeServerMessages(prev, data));
      setHasMoreOlder(data.length >= 100);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [conversationId, mergeServerMessages]);

  // 向上滚动加载更早消息（§25）
  const loadOlder = useCallback(async () => {
    if (messages.length === 0) return;
    const oldestAt = messages[0]?.created_at;
    const res = await getMessages(conversationId, { limit: 50, olderThan: oldestAt });
    if (res.error) return;
    const older = (res.data ?? []) as ViewMessage[];
    setMessages((prev) => mergeMessages(older, prev));
    setHasMoreOlder(older.length >= 50);
  }, [conversationId, messages]);

  useEffect(() => {
    loadMessages();
    // §11 Realtime + Fetch 竞态：先建立 Realtime 再获取历史，merge 由 mergeMessages 统一处理
    const unsub = subscribeMessages(conversationId, (newMsg: ChatMessage) => {
      setMessages((prev) => mergeServerMessages(prev, [newMsg as ViewMessage]));
      // 从 tool_results 提取 reasoning 更新思考横条
      if (newMsg.tool_results) {
        try {
          const tr = JSON.parse(newMsg.tool_results);
          if (tr.reasoning) {
            setLiveReasoning(tr.reasoning);
            if (reasoningBarRef.current) {
              reasoningBarRef.current.scrollTop = reasoningBarRef.current.scrollHeight;
            }
          }
        } catch { /* ignore */ }
      }
    });
    return unsub;
  }, [conversationId, loadMessages, mergeServerMessages]);

  // 消息轮询兜底（P0-A08，仅同步流式内容）
  useEffect(() => {
    return onSyncStateChange((s) => setSyncStatus(s.status));
  }, []);

  useEffect(() => {
    if (!activeCommandId || !activeClientCommandId) return
    const reference = activeCommandId === activeClientCommandId
      ? { serverId: null, clientCommandId: activeClientCommandId }
      : { serverId: activeCommandId, clientCommandId: activeClientCommandId }
    return subscribeRemoteCommandStatus(reference, settleRemoteCommand)
  }, [activeClientCommandId, activeCommandId, settleRemoteCommand])

  useEffect(() => {
    if (!conversationId) return
    if (syncStatus === 'connected') return
    let cancelled = false
    let requestInFlight = false
    const pollMessages = async () => {
      if (cancelled || requestInFlight) return
      requestInFlight = true
      try {
        const res = await getMessages(conversationId, { limit: 100 })
        if (cancelled || res.error) return
        const data = (res.data ?? []) as ViewMessage[]
        setMessages((prev) => mergeServerMessages(prev, data))
      } catch { /* 忽略网络错误 */ } finally {
        requestInFlight = false
      }
    }
    const interval = setInterval(() => { void pollMessages() }, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [conversationId, mergeServerMessages, syncStatus])

  // §8.4 条件跟随滚动
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const wasNear = nearBottomRef.current;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    setShowJump(!nearBottomRef.current);
    if (!wasNear && nearBottomRef.current) {
      setNewWhileAway(false); // 用户回到底部，清除"新消息"提示
    }
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (phaseIsActive) {
      setNewWhileAway(true);
    }
  }, [messages, phaseIsActive]);

  // 卸载时使异步发送/取消结果失效并清理定时器
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationIdRef.current += 1
      sendInFlightRef.current = false
      clearCommandTimers()
    }
  }, [clearCommandTimers])

  // 加载提示词模板
  useEffect(() => {
    try {
      const saved = localStorage.getItem('aether_mobile_templates');
      if (saved) setTemplates(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  // 计算 token 总量
  useEffect(() => {
    let total = 0;
    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_results) {
        try {
          const tr = JSON.parse(m.tool_results);
          if (tr.total_tokens && typeof tr.total_tokens === 'number') total += tr.total_tokens;
        } catch { /* ignore */ }
      }
    }
    if (total !== convTokenTotal) setConvTokenTotal(total);
  }, [messages]);

  // 附件处理（从 NewCommand 迁移）
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => setImageAttachments((prev) => [...prev, reader.result as string]);
        reader.readAsDataURL(file);
      } else if (file.type.startsWith('text/') || file.name.match(/\.(py|js|ts|tsx|jsx|html|css|json|md|txt|xml|yaml|yml|sh|bat|ps1|env|gitignore|sql|rb|go|rs|c|cpp|h|hpp|java|kt|swift|php|pl|pm|r|m|mm|vue|svelte|astro)$/i)) {
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result as string;
          const fileBlock = `\n\n---\n**文件: ${file.name}**\n\`\`\`${file.name.split('.').pop() || ''}\n${text}\n\`\`\`\n`;
          setInput((prev) => (prev ? prev + fileBlock : fileBlock));
        };
        reader.readAsText(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          setFileAttachments((prev) => [...prev, { name: file.name, dataUrl: reader.result as string }]);
        };
        reader.readAsDataURL(file);
      }
    }
    e.target.value = '';
  };

  // ========== 发送（§7/§8/§9/§15/§18） ==========
  const handleSend = async () => {
    const text = input.trim()
    if (!text || phaseIsActive || sendInFlightRef.current) return

    const operationId = operationIdRef.current + 1
    operationIdRef.current = operationId
    sendInFlightRef.current = true
    stopRequestedRef.current = false
    clearCommandTimers()
    resetCommandBinding()
    commandDeadlineRef.current = Date.now() + 300_000
    updatePhase('sending')
    setInput('')
    latestUserMsgAtRef.current = null

    const clientCommandId = createClientCommandId()
    activeClientCommandIdRef.current = clientCommandId
    setActiveClientCommandId(clientCommandId)

    // 构建消息内容：文字 + 图片 + 文件（§ 附件管道）
    let content = text
    if (imageAttachments.length > 0) {
      content += '\n\n' + imageAttachments.map((url) => `![image](${url})`).join('\n')
      setImageAttachments([])
    }
    if (fileAttachments.length > 0) {
      content += '\n\n' + fileAttachments.map((f) => `[上传文件: ${f.name}](${f.dataUrl})`).join('\n')
      setFileAttachments([])
    }

    // 乐观添加用户消息（§8：无论结果如何都不删除，只更新状态）
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const optimisticMsg: ViewMessage = {
      id: tempId,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
      localState: 'sending',
      localClientCommandId: clientCommandId,
      localCommandPayload: content,
    }
    setMessages((prev) => [...prev, optimisticMsg])
    sendingUserMsgRef.current = tempId
    latestUserMsgAtRef.current = optimisticMsg.created_at

    const contentWithMeta = `[mode=${mode}][level=${permissionLevel}][deep=${deepThinking}][web=${webSearch}][loop=${loopMode}] ${content}`.trim()
    try {
      const result: SendResult = await sendCommand(contentWithMeta, conversationId, clientCommandId)
      if (!mountedRef.current || operationIdRef.current !== operationId) return

      if (result.status === 'sent') {
        activeCommandIdRef.current = result.commandId
        setActiveCommandId(result.commandId)
        setMessages((prev) => prev.map((message) => message.id === tempId ? {
          ...message,
          localState: 'sent' as const,
          localClientCommandId: result.clientCommandId,
        } : message))
        if (stopRequestedRef.current) {
          sendInFlightRef.current = false
          if (!cancelTimeoutRef.current) void requestCancellation(result.clientCommandId, operationId)
          return
        }
        updatePhase('waiting')
        armCommandTimeout(operationId)
      } else if (result.status === 'queued') {
        activeCommandIdRef.current = result.commandId
        setActiveCommandId(result.commandId)
        setMessages((prev) => prev.map((message) => message.id === tempId ? {
          ...message,
          localState: 'queued' as const,
          localClientCommandId: result.clientCommandId,
        } : message))
        if (stopRequestedRef.current) {
          sendInFlightRef.current = false
          if (!cancelTimeoutRef.current) void requestCancellation(result.clientCommandId, operationId)
          return
        }
        updatePhase('queued')
        armCommandTimeout(operationId)
      } else {
        resetCommandBinding()
        updatePhase('failed')
        setMessages((prev) => prev.map((message) => message.id === tempId ? {
          ...message,
          localState: 'failed' as const,
          localError: result.message,
          localClientCommandId: result.clientCommandId ?? clientCommandId,
          localCommandPayload: content,
        } : message))
      }
    } catch (error: unknown) {
      if (!mountedRef.current || operationIdRef.current !== operationId) return
      resetCommandBinding()
      updatePhase('failed')
      setMessages((prev) => prev.map((message) => message.id === tempId ? {
        ...message,
        localState: 'failed' as const,
        localError: error instanceof Error ? error.message : '发送失败',
        localClientCommandId: clientCommandId,
        localCommandPayload: content,
      } : message))
    } finally {
      if (operationIdRef.current === operationId) sendInFlightRef.current = false
    }
  }

  // 重发失败消息（§9）
  const handleResend = async (msg: ViewMessage) => {
    if (phaseIsActive || sendInFlightRef.current) return

    const operationId = operationIdRef.current + 1
    operationIdRef.current = operationId
    sendInFlightRef.current = true
    stopRequestedRef.current = false
    clearCommandTimers()
    resetCommandBinding()
    commandDeadlineRef.current = Date.now() + 300_000
    updatePhase('sending')
    const clientCommandId = createClientCommandId()
    const text = msg.localCommandPayload ?? msg.content
    activeClientCommandIdRef.current = clientCommandId
    setActiveClientCommandId(clientCommandId)
    setMessages((prev) => prev.map((message) => message.id === msg.id ? {
      ...message,
      localState: 'sending' as const,
      localError: undefined,
      localClientCommandId: clientCommandId,
      localCommandPayload: text,
    } : message))
    latestUserMsgAtRef.current = msg.created_at
    const contentWithMeta = `[mode=${mode}][level=${permissionLevel}][deep=${deepThinking}][web=${webSearch}][loop=${loopMode}] ${text}`.trim()
    try {
      const result = await sendCommand(contentWithMeta, conversationId, clientCommandId)
      if (!mountedRef.current || operationIdRef.current !== operationId) return

      if (result.status === 'sent') {
        activeCommandIdRef.current = result.commandId
        setActiveCommandId(result.commandId)
        setMessages((prev) => prev.map((message) => message.id === msg.id ? {
          ...message,
          localState: 'sent' as const,
          localClientCommandId: result.clientCommandId,
        } : message))
        if (stopRequestedRef.current) {
          sendInFlightRef.current = false
          if (!cancelTimeoutRef.current) void requestCancellation(result.clientCommandId, operationId)
          return
        }
        updatePhase('waiting')
        armCommandTimeout(operationId)
      } else if (result.status === 'queued') {
        activeCommandIdRef.current = result.commandId
        setActiveCommandId(result.commandId)
        setMessages((prev) => prev.map((message) => message.id === msg.id ? {
          ...message,
          localState: 'queued' as const,
          localClientCommandId: result.clientCommandId,
        } : message))
        if (stopRequestedRef.current) {
          sendInFlightRef.current = false
          if (!cancelTimeoutRef.current) void requestCancellation(result.clientCommandId, operationId)
          return
        }
        updatePhase('queued')
        armCommandTimeout(operationId)
      } else {
        resetCommandBinding()
        updatePhase('failed')
        setMessages((prev) => prev.map((message) => message.id === msg.id ? {
          ...message,
          localState: 'failed' as const,
          localError: result.message,
          localClientCommandId: result.clientCommandId ?? clientCommandId,
          localCommandPayload: text,
        } : message))
      }
    } catch (error: unknown) {
      if (!mountedRef.current || operationIdRef.current !== operationId) return
      resetCommandBinding()
      updatePhase('failed')
      setMessages((prev) => prev.map((message) => message.id === msg.id ? {
        ...message,
        localState: 'failed' as const,
        localError: error instanceof Error ? error.message : '发送失败',
        localClientCommandId: clientCommandId,
        localCommandPayload: text,
      } : message))
    } finally {
      if (operationIdRef.current === operationId) sendInFlightRef.current = false
    }
  }

  // §18/§15.1 收口：停止执行 —— 不只改本地 UI 状态，必须真正取消后端 Run。
  // Mobile Stop → cancel API（remote_commands /cancel 命令）→ 桌面端 RunCancellationRegistry
  // → AbortSignal → runExecutionLoop state='cancelled' → run.cancelled 终态事件 → Mobile terminal state。
  const handleStop = async () => {
    if (!['sending', 'queued', 'waiting', 'processing', 'streaming', 'timeout', 'cancel_timeout'].includes(phase)) return
    const clientCommandId = activeClientCommandIdRef.current
    if (!clientCommandId) {
      updatePhase(activeCommandIdRef.current ? 'waiting' : 'queued')
      appendSystemMessage('停止请求尚未绑定，当前命令继续等待终态')
      return
    }

    stopRequestedRef.current = true
    await requestCancellation(clientCommandId, operationIdRef.current)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const toggleToolExpand = (msgId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  };

  const renderMessage = (msg: ViewMessage, index: number) => {
    const isUser = msg.role === 'user';
    const isTool = msg.role === 'tool';
    const isSystem = msg.role === 'system';
    const isExpanded = expandedTools.has(msg.id);
    const isLastMessage = index === messages.length - 1;

    // Tool — 轻量 pill（§19 统一 Tool 状态）
    if (isTool) {
      const tr = safeParse(msg.tool_results);
      const toolName = tr?.tool_name ?? (msg.content.slice(0, 12) + '…');
      const status = tr?.status ?? 'done';
      return (
        <div key={msg.id}>
          <div className={`msg-tool ${isExpanded ? 'open' : ''}`} onClick={() => toggleToolExpand(msg.id)} role="button" tabIndex={0}>
            <span className={`msg-tool-dot ${status === 'running' ? 'running' : ''}`} />
            <span className="msg-tool-name">{toolName}</span>
            <span className="msg-tool-action">{msg.content.slice(0, 24)}</span>
            {status === 'running' && <span className="msg-tool-status">执行中</span>}
            <ChevronRight size={14} className="msg-tool-chevron" />
          </div>
          {isExpanded && <div className="msg-tool-detail">{msg.content}</div>}
        </div>
      );
    }

    // System — 极轻居中
    if (isSystem) {
      return (
        <div className="msg msg-system" key={msg.id}>
          {msg.content}
        </div>
      );
    }

    const content = msg.content;
    let reasoning = '';
    if (msg.tool_results) {
      try {
        const tr = JSON.parse(msg.tool_results);
        if (tr.reasoning) reasoning = tr.reasoning;
      } catch { /* ignore */ }
    }

    const activeReasoning = isUser ? false : (phaseIsActive && isLastMessage);

    // 用户消息本地状态角标（§9）
    let localBadge: React.ReactNode = null;
    if (isUser && msg.localState) {
      if (msg.localState === 'queued') {
        localBadge = <span className="msg-local-badge queued">等待连接</span>;
      } else if (msg.localState === 'failed') {
        localBadge = (
          <span className="msg-local-badge failed">
            发送失败
            <button className="msg-resend-btn" onClick={() => handleResend(msg)} disabled={phaseIsActive} aria-label="重新发送">
              <RefreshCw size={12} />
            </button>
          </span>
        );
      } else if (msg.localState === 'sending') {
        localBadge = <span className="msg-local-badge">发送中</span>;
      }
    }

    return (
      <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`} key={msg.id}>
        {isUser ? (
          <>
            <div className="msg-content">{content}</div>
            <div className="msg-local-row">{localBadge}<span className="msg-time">{formatTime(msg.created_at)}</span></div>
          </>
        ) : (
          <>
            <div className="msg-asst-meta">
              <AetherMark size={14} className="msg-asst-mark" />
              <span className="msg-asst-name">Aether</span>
            </div>
            {reasoning && <ReasoningBlock reasoning={reasoning} active={activeReasoning} />}
            <div className="msg-content">
              <MarkdownContent content={content} />
            </div>
            <span className="msg-time">{formatTime(msg.created_at)}</span>
          </>
        )}
      </div>
    );
  };

  const online = syncStatus === 'connected';

  if (loading) {
    return (
      <div className="chat-page">
        <div className="chat-header">
          <button className="chat-back" onClick={onBack} aria-label="返回">
            <ChevronLeft size={22} />
          </button>
          <div className="chat-titles">
            <h2 className="chat-title">{conversationTitle}</h2>
          </div>
        </div>
        <div className="loading">
          <div className="spinner" />
          加载中...
        </div>
      </div>
    );
  }

  const subtitle = phase === 'sending' ? 'Aether 工作站 · 正在发送'
    : phase === 'queued' ? 'Aether 工作站 · 等待连接'
    : phase === 'timeout' ? 'Aether 工作站 · 等待终态超时'
    : phase === 'cancelling' ? 'Aether 工作站 · 正在停止'
    : phase === 'cancel_timeout' ? 'Aether 工作站 · 停止确认超时'
    : phase === 'processing' || phase === 'streaming' || phase === 'waiting' ? 'Aether 工作站 · 正在工作'
    : phase === 'failed' ? 'Aether 工作站 · 发送失败'
    : online ? 'Aether 工作站 · 已同步' : 'Aether 工作站 · 连接中断';

  const canSend = !phaseIsActive && (!!input.trim() || imageAttachments.length > 0 || fileAttachments.length > 0);

  return (
    <div className="chat-page">
      {/* 顶栏（§34：会话名 + Aether 工作站状态） */}
      <div className="chat-header">
        <button className="chat-back" onClick={onBack} aria-label="返回">
          <ChevronLeft size={22} />
        </button>
        <div className="chat-titles">
          <h2 className="chat-title">{conversationTitle}</h2>
          <p className="chat-subtitle">
            <span className={`sync-dot ${online ? 'online' : ''}`} />
            {subtitle}
          </p>
        </div>
        <button className="chat-actions" onClick={() => setSettingsOpen(true)} aria-label="执行设置">
          <MoreHorizontal size={20} />
        </button>
      </div>

      {/* 消息列表 */}
      <div className="message-list" ref={listRef}>
        {hasMoreOlder && (
          <button className="load-older-btn" onClick={loadOlder}>
            加载更早消息
          </button>
        )}
        {loadError && messages.length === 0 ? (
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <h3 className="empty-state-title">加载失败</h3>
            <p className="empty-state-desc">{loadError}</p>
            <button className="btn-ghost" onClick={loadMessages} style={{ marginTop: 16 }}>点击重试</button>
          </div>
        ) : messages.length === 0 ? (
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <h3 className="empty-state-title">暂无消息</h3>
            <p className="empty-state-desc">向桌面端 Aether 发送一条指令</p>
          </div>
        ) : (
          messages.map((m, i) => renderMessage(m, i))
        )}
        {phaseIsActive && (
          <div className="msg msg-assistant">
            <div className="msg-asst-meta">
              <AetherMark size={14} className="msg-asst-mark" />
              <span className="msg-asst-name">Aether</span>
            </div>
            <div className="msg-content">
              <span>{phase === 'queued' ? '等待连接…' : phase === 'cancelling' ? '正在停止…' : phase === 'cancel_timeout' ? '等待停止确认…' : '正在处理…'}</span>
              <span className="stream-indicator" />
            </div>
          </div>
        )}
      </div>

      {/* 回到底部（§58：仅不在底部时出现，显示"新消息"） */}
      {showJump && (
        <button
          className="jump-bottom"
          onClick={() => {
            const el = listRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ChevronDown size={16} />
          {newWhileAway ? '新消息' : '到底部'}
        </button>
      )}

      {/* 思考横条 */}
      {liveReasoning ? (
        <div className="reasoning-bar">
          <span className="reasoning-bar-dot" />
          <div ref={reasoningBarRef} className="reasoning-bar-text">{liveReasoning}</div>
        </div>
      ) : null}

      {/* Command Bar（§35：无内容=disabled / 有内容=active / 处理中=stop） */}
      <div className="command-bar-wrap">
        <div className="command-bar">
          {/* 附件预览 */}
          {(imageAttachments.length > 0 || fileAttachments.length > 0) && (
            <div className="attachment-preview-row">
              {imageAttachments.map((url, i) => (
                <div key={i} className="attachment-chip" style={{ position: 'relative' }}>
                  <img src={url} alt="" className="attachment-chip-img" />
                  <button className="attachment-chip-remove" onClick={() => setImageAttachments((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
              {fileAttachments.map((f, i) => (
                <div key={i} className="attachment-chip file">
                  <span className="attachment-chip-name">{f.name}</span>
                  <button className="attachment-chip-remove" onClick={() => setFileAttachments((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="command-bar-inner">
            <button className="command-bar-btn" onClick={() => setTemplateOpen(!templateOpen)} title="提示词模板">
              <Plus size={20} />
            </button>
            <button className="command-bar-btn" onClick={() => fileInputRef.current?.click()} title="上传文件">
              <Upload size={18} />
            </button>
            <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
            <textarea
              className="command-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入指令…"
              rows={1}
              disabled={phaseIsActive}
            />
            {phaseIsActive ? (
              <button className="send-btn stop" onClick={() => void handleStop()} aria-label="停止" title="停止">
                <Square size={16} />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!canSend}
                aria-label="发送"
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 模板弹层 */}
      {templateOpen && (
        <div className="template-popup">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>提示词模板</span>
            <button
              className="command-bar-btn"
              style={{ width: 28, height: 28 }}
              onClick={() => setTemplateOpen(false)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          {templates.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: 8 }}>暂无模板</p>
          ) : (
            templates.map((t, i) => (
              <button
                key={i}
                className="template-popup-item"
                onClick={() => { setInput(t.content); setTemplateOpen(false); }}
              >
                <span className="template-popup-item-name">{t.name}</span>
                <span className="template-popup-item-preview">{t.content.slice(0, 40)}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* 执行设置 Bottom Sheet（§64：状态明确影响下一次发送） */}
      {settingsOpen && (
        <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="sheet settings-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <h3 className="sheet-title">执行设置</h3>
            <p className="sheet-hint" style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>
              这些设置将应用于下一次发送
            </p>

            <div className="sheet-group">
              <p className="sheet-group-label">执行模式</p>
              <div className="sheet-segment">
                <button className={mode === 'normal' ? 'active' : ''} onClick={() => setMode('normal')}>普通</button>
                <button className={mode === 'super' ? 'active primary' : 'primary'} onClick={() => setMode('super')}>Super Agent</button>
              </div>
            </div>

            <div className="sheet-group">
              <p className="sheet-group-label">能力</p>
              <div className="sheet-row">
                <span>深度思考</span>
                <button className={`switch ${deepThinking ? 'on' : ''}`} onClick={() => setDeepThinking((d) => !d)} aria-label="深度思考" />
              </div>
              <div className="sheet-row">
                <span>联网搜索</span>
                <button className={`switch ${webSearch ? 'on' : ''}`} onClick={() => setWebSearch((w) => !w)} aria-label="联网搜索" />
              </div>
              <div className="sheet-row">
                <span>循环执行</span>
                <button className={`switch ${loopMode ? 'on' : ''}`} onClick={() => setLoopMode((l) => !l)} aria-label="循环执行" />
              </div>
            </div>

            <div className="sheet-group">
              <p className="sheet-group-label">权限</p>
              <div className="sheet-segment sheet-levels">
                {[1, 2, 3].map((l) => (
                  <button
                    key={l}
                    className={permissionLevel === l ? 'active' : ''}
                    onClick={() => setPermissionLevel(l)}
                  >
                    Level {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="sheet-group">
              <p className="sheet-group-label">会话</p>
              <div className="sheet-row">
                <span>累计 Token</span>
                <span className="sheet-value">{convTokenTotal.toLocaleString()}</span>
              </div>
            </div>

            <button className="btn-primary sheet-done" onClick={() => setSettingsOpen(false)}>完成</button>
          </div>
        </div>
      )}
    </div>
  );
}
