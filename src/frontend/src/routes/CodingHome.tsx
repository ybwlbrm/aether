import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api/client';
import { Send, Plus, Trash2, Mic, X, MessageSquare, XCircle } from 'lucide-react';
import { useAppStore } from '../store/app';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { requestNotificationPermission, sendNotification } from '../lib/notifications';
import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { OpenCodeStyleCodeBlock } from '../components/OpenCodeBlock';
import { useActivityStore } from '../store/activityStore';
import { streamConversation, streamOrchestrate, fetchEvents } from '../api/streamClient';
import { ActivityStream } from '../components/activity/ActivityStream';
import { useMessagePolling } from '../hooks/useMessagePolling';
import type { AgentEventEnvelope } from '@pacc/shared';

// S1 修复：消息 markdown 渲染（代码围栏 → shiki 高亮卡片，OpenCode 风格）
const streamdownPlugins = { cjk };

// 消息气泡组件（React.memo：流式更新时仅重渲染正在变化的 AI 消息，
// 避免其他已固定的消息中的 Streamdown 每帧重解析，显著减少卡顿）
const MemoBubble = memo(({ msg, index }: { msg: Message; index: number }) => {
  const [toolExpanded, setToolExpanded] = useState(false);
  // 过滤空内容消息：助手消息无内容时不渲染
  if (msg.role === 'assistant' && !msg.content?.trim()) return null;
  // tool 消息由 ActivityStream 统一展示，不渲染空玻璃气泡
  if (msg.role === 'tool') return null;
  return (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: Math.min(index * 0.02, 0.3) }}
    style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 16 }}
  >
    <div style={{ maxWidth: '78%' }}>
      {msg.role === 'user' ? (
        // 用户消息：右对齐气泡（参考 DeepSeek UserStyleBubble）
        <div style={{
          padding: '10px 16px',
          borderRadius: 22,
          background: 'var(--color-accent)',
          color: 'var(--on-accent)',
          fontSize: 16,
          lineHeight: 1.5,
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
        }}>
          {(() => {
            const imgMatch = msg.content?.match(/!\[image\]\(((?:data:image\/[^;]+;base64[^)]+|\/data\/chat-images\/[^)]+))\)/g);
            if (imgMatch) {
              return imgMatch.map((m, i) => {
                const urlMatch = m.match(/!\[image\]\(((?:data:image\/[^;]+;base64[^)]+|\/data\/chat-images\/[^)]+))\)/);
                const url = urlMatch?.[1];
                return url ? (<img key={i} src={url} alt="" style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 8, marginBottom: 8, display: 'block' }} />) : null;
              });
            }
            return null;
          })()}
          <div className="prose-md-body" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            <Streamdown plugins={streamdownPlugins} components={{ pre: OpenCodeStyleCodeBlock }}>{msg.content?.replace(/!\[image\]\((?:data:image\/[^;]+;base64[^)]+|\/data\/chat-images\/[^)]+)\)/g, '').trim() || ''}</Streamdown>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4, textAlign: 'right' }}>
            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      ) : (
        // 助手消息：纯文字，无气泡（参考 DeepSeek AssistantMarkdown）
        <div>
          <div className="prose-md-body" style={{ overflowWrap: 'anywhere' }}>
            <Streamdown plugins={streamdownPlugins} components={{ pre: OpenCodeStyleCodeBlock }}>{msg.content || ''}</Streamdown>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}
    </div>
    </motion.div>
  );
});
MemoBubble.displayName = 'MemoBubble';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string | null;
  createdAt: string;
}

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

/** 当前会话的 Activity Stream（事件驱动实时展示：工具活动 + 任务进度 + 流式思考） */
function ActivityStreamLive({ convId }: { convId: string | null }) {
  // 从 Zustand 订阅当前会话事件（事件变化触发 re-render）；任务卡通过 useMemo 投影（防无限重渲染）
  const events = useActivityStore(s => (convId ? s.getEvents(convId) : undefined));
  const taskCard = useMemo(() => (convId && events ? useActivityStore.getState().projectTaskCard(convId) : null), [convId, events]);
  if (!convId || !events || events.length === 0) return null;
  return <ActivityStream events={events} taskCard={taskCard} />;
}

export function CodingHome() {
  const { uiMode } = useAppStore();
  const location = useLocation(); // 监听 remote 参数变化，触发远程命令重新检查
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [recording, setRecording] = useState(false);
  interface Attachment { name: string; dataUrl: string; }
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 附件 ref — 同步存储，确保 handleSend 发送时一定能拿到最新附件
  const attachmentsRef = useRef<Attachment[]>([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [streamTokens, setStreamTokens] = useState<{ total_tokens: number } | null>(null);
  const [currentConvTokenTotal, setCurrentConvTokenTotal] = useState(0);
  // 审计修复：加载错误状态（替代静默吞错）
  const [loadError, setLoadError] = useState<string | null>(null);
// 新增：权限等级 + 模式切换 + 重试状态 + 工作目录（对照 Chat.tsx 普通模式）
  const [permissionLevel, setPermissionLevel] = useState<number>(2);
  const [mode, setMode] = useState<'normal' | 'super'>('normal');
  // DeepSeek 风格开关：深度思考（thinking 模式） + 联网搜索
  const [deepThinking, setDeepThinking] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [loopMode, setLoopMode] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxRetries: number; status: number; delay: number } | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  // S2 修复：输入框上方思考横条实时内容（流式推理），无内容时隐藏
  const [liveReasoning, setLiveReasoning] = useState<string>('');
  // 模型选择器：当前选中的 provider 与 model（默认使用 defaultProviders.text）
  const [selectedProvider, setSelectedProvider] = useState<any>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  // 标记是否已初始化过 selectedProvider（防止 load() 覆盖用户手动选择）
  const providerInitialized = useRef(false);
const currentConvRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
const plusRef = useRef<HTMLDivElement>(null);

  // FE-DUP-01: 使用共享 useMessagePolling hook 替代内联轮询
  // 统一消息轮询逻辑：合并消息、token 统计、生成状态、reasoning 提取
  const notifiedRef = useRef(false);
  useMessagePolling({
    conversationId: currentConvId,
    enabled: !!currentConvId,
    intervalMs: 1000,
    onMessagesUpdate: (updater) => setMessages(updater),
    onTokenTotalUpdate: (total) => setCurrentConvTokenTotal((prev) => Math.max(prev, total)),
    onSendingUpdate: (generating) => {
      if (!generating && !notifiedRef.current && document.hidden) {
        notifiedRef.current = true;
        setSending(false);
        sendNotification('AI 回复完成', { body: '对话已生成完成，点击查看' });
      } else if (!generating) {
        setSending(false);
        notifiedRef.current = false; // 重置，下次生成完成时再通知
      } else if (generating) {
        setSending(true);
      }
    },
    onLiveReasoningUpdate: (reasoning) => setLiveReasoning(reasoning),
    currentConvRef,
    msgPollReqIdRef,
    activityPollReqIdRef,
    mountedRef,
    // FE-ERR-06: 轮询错误回调，设置 loadError 状态供 UI 显示
    onPollError: (error) => setLoadError(`轮询失败: ${error.message}`),
  });

  const load = useCallback(async () => {
    let provs: any[] = [];
    try {
      const [convs, loadedProvs] = await Promise.all([
        api.getConversations(),
        api.getProviders(),
      ]);
      provs = Array.isArray(loadedProvs) ? loadedProvs : [];
      setConversations(convs || []);
      setProviders(provs);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : '加载数据失败');
    }
    // 加载权限等级 + 工作目录（对照 Chat.tsx）
    api.getPermissions().then((res: any) => setPermissionLevel(res?.level ?? 2)).catch(() => {});
    api.getWorkspace().then((res: any) => setWorkspacePath(res?.defaultDir || '')).catch(() => {});
    // 加载默认 text provider 并设为选中（仅首次加载时，不覆盖用户手动切换）
    api.getDefaultProviders().then((res: any) => {
      if (!providerInitialized.current && res?.text) {
        const p = provs.find((pp: any) => pp.id === res.text);
        if (p) {
          setSelectedProvider(p);
          setSelectedModel((p.models && p.models[0]) || p.defaultModel || 'gpt-4o');
          providerInitialized.current = true;
        }
      }
    }).catch(() => {});
    // 兜底：如果未初始化且未设置默认，用第一个可用 text provider
    if (!providerInitialized.current && provs.length > 0) {
      const textProv = provs.find((p: any) => p.capabilities?.includes?.('text')) || provs[0];
      setSelectedProvider(textProv);
      setSelectedModel((textProv.models && textProv.models[0]) || textProv.defaultModel || 'gpt-4o');
      providerInitialized.current = true;
    }
  }, []);

useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      load();
    }
  }, [load]);
  useEffect(() => { requestNotificationPermission(); }, []);
  useEffect(() => { currentConvRef.current = currentConvId; }, [currentConvId]);

  // Q1 彻底修复：检测 URL ?new=true 参数，强制进入新对话空白页。
  // 必须在所有其他 useEffect 之前执行，确保先清空状态再处理远程命令/自动创建。
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('new') === 'true') {
      window.history.replaceState({}, '', '/command-center');
      sessionStorage.removeItem('aether_pending_remote');
      setCurrentConvId(null);
      setMessages([]);
      setCurrentConvTokenTotal(0);
      setStreamTokens(null);
      // 不再重复调用 load()，初始化已由 mount effect 完成
    }
    // 检测 ?selectConv=xxx 参数：从对话记录面板选择对话后，加载该对话
    const selectConv = params.get('selectConv');
    if (selectConv) {
      window.history.replaceState({}, '', '/command-center');
      // 延迟执行，确保组件已就绪
      setTimeout(() => handleSelectConv(selectConv), 100);
    }
}, [location.search]);

  // P1 修复：组件卸载时停止语音识别/录音，释放麦克风流与浏览器资源（防内存/设备占用泄漏）
  useEffect(() => {
    return () => {
      try { if (recognitionRef.current) recognitionRef.current.stop(); } catch { /* ignore */ }
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
  // 将命令载荷传递给 CodingHome。我们防御性地接受 event.detail.command 和旧形状。
  // ============================================================
  useEffect(() => {
    let cancelled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const handleRemoteCommand = async (e: Event) => {
      if (cancelled) return;
      const ce = e as CustomEvent;
      // 防御性解析：Layout 发送 { detail: { command: {...} } } 或直接 { detail: {...} }
      const detail = ce.detail || {};
      const cmd = detail.command ?? detail; // 兼容新旧形状
      if (!cmd?.content) return;
      // 字段归一：Layout 发送 id，旧协议发送 commandId
      const commandId: string | undefined = cmd.commandId ?? cmd.id;

      // Q1 修复：新鲜度校验 — 避免处理过期命令（超过 60 秒）
      if (typeof cmd.receivedAt === 'number' && Date.now() - cmd.receivedAt > 60000) {
        return;
      }

      console.log('[CodingHome] 收到远程命令事件，自动打开对话:', cmd.content.slice(0, 50));

      // 乐观显示用户消息
      const userMsg: Message = {
        id: `remote-u-${Date.now()}`, role: 'user', content: cmd.content,
        createdAt: new Date().toISOString(),
      };
      setMessages([userMsg]);

      // 打开指定对话并加载消息
      const openConversation = async (convId: string) => {
        if (cancelled) return;
        try {
          const conv = await api.getConversation(convId);
          if (cancelled) return;
          setCurrentConvId(convId);
          setMessages((conv.messages || []).map((m: any) => ({
            id: m.id, role: m.role, content: m.content, createdAt: m.createdAt,
          })));
          setCurrentConvTokenTotal(typeof conv.tokenTotal === 'number' ? conv.tokenTotal : 0);
          setStreamTokens(null);
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
        } catch {
          // 对话可能尚未同步完成，等待下一次事件或轮询
        }
      };

      // 已有 conversationId 则直接打开
      if (cmd.conversationId) {
        await openConversation(cmd.conversationId);
      } else if (commandId) {
        // 无 conversationId：轮询命令状态直到获得 conversationId 或失败/超时
        let attempt = 0;
        const pollCommandStatus = async () => {
          if (cancelled) return;
          attempt++;
          try {
            const res = await fetch(`/api/sync/command-status?commandId=${encodeURIComponent(commandId)}`, {
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!res.ok) return;
            const data = await res.json();
            if (cancelled) return;
            if (data.command?.conversationId) {
              await openConversation(data.command.conversationId);
            } else if (data.command?.status === 'failed') {
              if (!cancelled) {
                setMessages(prev => [...prev, {
                  id: `remote-err-${Date.now()}`, role: 'assistant',
                  content: '❌ 远程命令处理失败: ' + (data.command.error || '未知错误'),
                  createdAt: new Date().toISOString(),
                }]);
              }
              if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            }
          } catch { /* 网络错误忽略，下轮重试 */ }
        };

        const pollTimer = setInterval(pollCommandStatus, 2000);
        // 60 秒兜底超时
        timeoutTimer = setTimeout(() => {
          if (cancelled) return;
          clearInterval(pollTimer);
          setMessages(prev => [...prev, {
            id: `remote-timeout-${Date.now()}`, role: 'assistant',
            content: '⚠️ 等待桌面端响应超时，请确认桌面端 Aether 正在运行且已配置 AI Provider',
            createdAt: new Date().toISOString(),
          }]);
        }, 60000);

        // 保存定时器引用以便清理
        (handleRemoteCommand as any).pollTimer = pollTimer;
      }
    };

    window.addEventListener('remote-command', handleRemoteCommand);
    return () => {
      cancelled = true;
      window.removeEventListener('remote-command', handleRemoteCommand);
      if (timeoutTimer) { clearTimeout(timeoutTimer); }
      const pollTimer = (handleRemoteCommand as any).pollTimer;
      if (pollTimer) { clearInterval(pollTimer); }
    };
  }, []);

  // 监听 select-conversation 事件：从 Layout 的对话记录面板选择对话后加载
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent;
      if (ce.detail?.conversationId) {
        handleSelectConv(ce.detail.conversationId);
      }
    };
    window.addEventListener('select-conversation', handler);
    return () => window.removeEventListener('select-conversation', handler);
  }, []);

  // ============================================================
  // 智能滚动：用户手动滚动查看历史时停止自动滚动
  // 当用户不在底部时，不自动跳到底部
  // ============================================================
  const messageListRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // 检测用户是否在底部附近（阈值 100px）
  const isNearBottom = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);

  // 监听手动滚动
  const handleScroll = useCallback(() => {
    if (!isNearBottom()) {
      setUserScrolledUp(true);
    } else {
      setUserScrolledUp(false);
    }
  }, [isNearBottom]);

  // 新消息到达时，只在用户未手动滚动时自动跳到底部
  useEffect(() => {
    if (!userScrolledUp && messagesEndRef.current) {
      const el = messagesEndRef.current.parentElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [messages, sending, userScrolledUp]);

  // 用户发送新消息时强制跳到底部（使用 scrollTop 确保精确到最底部）
  useEffect(() => {
    if (sending && messagesEndRef.current) {
      setUserScrolledUp(false);
      const el = messagesEndRef.current.parentElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [sending]);

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

  // 处理"新对话"：只清空当前对话状态，不在数据库创建空对话。
  // 空对话会在用户首次发送消息时由 handleSend 自动创建。
  // 原实现提前创建的空对话会出现在侧栏列表中，用户点击后看到的是空白无消息的对话。
  const handleNew = () => {
    setPlusMenuOpen(false);
    setCurrentConvId(null);
    setMessages([]);
    setCurrentConvTokenTotal(0);
    setStreamTokens(null);
    setLiveReasoning('');
  };

const handleSelectConv = async (id: string) => {
    // FE-RACE-02: 请求序列守卫 — 切换会话时递增，丢弃过期响应
    const reqId = ++loadReqIdRef.current;
    try {
      const conv = await api.getConversation(id);
      // 守卫：若已发起新的加载请求，丢弃当前响应
      if (reqId !== loadReqIdRef.current) return;
      setCurrentConvId(id);
      setMessages((conv.messages || []).map((m: any) => {
        let reasoning: string | undefined;
        if (m.toolResults) {
          try { const tr = JSON.parse(m.toolResults); if (tr.reasoning) reasoning = tr.reasoning; } catch {}
        }
        return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, reasoning };
      }));
      setCurrentConvTokenTotal(typeof conv.tokenTotal === 'number' ? conv.tokenTotal : 0);
      setStreamTokens(null);
      setLiveReasoning(''); // S2：换对话清空思考横条
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
  };

  // ============================================================


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
    // 同时检查 agents 端
    fetch('/api/agents/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ conversationId: currentConvId }),
    }).then(r => r.json()).then(data => {
      if (!cancelled && data.success === false && data.message === '没有正在进行的生成') {
        // 没有进行中的生成，不操作
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentConvId]);

  const handleDeleteConv = async (id: string) => {
    if (!(await confirmDialog('Delete this conversation?'))) return;
    try {
      await api.deleteConversation(id);
      // 同步删除 Supabase 记录（手机端同步）
      await fetch('/api/sync/delete-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ conversationId: id }),
      }).catch(() => {}); // 后端未配置同步时静默忽略
      if (currentConvId === id) { setCurrentConvId(null); setMessages([]); setCurrentConvTokenTotal(0); }
      load();
    } catch (e: unknown) { alert('Delete failed: ' + (e instanceof Error ? e.message : String(e))); }
  };

  const handleSend = async () => {
    const content = input.trim();
    const currentAttachments = [...attachmentsRef.current];
    // 允许纯发图片（无文字时），content 为空但有附件时仍可发送
    if ((!content && currentAttachments.length === 0) || sending) return;
    setInput('');
    setAttachments([]);
    attachmentsRef.current = [];
    setStreamTokens(null);

    if (!currentConvId) {
      const dp = selectedProvider || providers[0];
      if (!dp) { alert('请先配置 AI Provider'); return; }
      const model = selectedModel || (Array.isArray(dp.models) && dp.models[0]) || dp.defaultModel || 'gpt-4o';
      // 纯图片发送时用默认标题
      const convTitle = content || '图片消息';
      const conv = await api.createConversation({ title: convTitle.slice(0, 30), providerId: dp.id, model });
      setCurrentConvId(conv.id);
      // 修复：创建新对话后立即刷新对话列表，否则新对话不会出现在侧栏中
      load();
      window.dispatchEvent(new CustomEvent('conversations-changed'));
      await doSend(conv.id, content, currentAttachments);
    } else {
      await doSend(currentConvId, content, currentAttachments);
    }
  };

  const doSend = async (convId: string, content: string, attachments?: Attachment[]) => {
    setSending(true);
    setRetryInfo(null);
    setStreamTokens(null);
    setLiveReasoning(''); // S2：新一轮发送清空思考横条
    // 分离图片和其他文件
    const imageAttachments = (attachments || []).filter(a => a.dataUrl.startsWith('data:image/'));
    const fileAttachments = (attachments || []).filter(a => !a.dataUrl.startsWith('data:image/'));
    // 构建带附件的本地消息
    let displayContent = content || '';
    for (const att of (attachments || [])) {
      if (att.dataUrl.startsWith('data:image/')) {
        displayContent += `\n\n![image](${att.dataUrl})`;
      } else {
        displayContent += `\n\n[上传文件: ${att.name}]`;
      }
    }
    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: displayContent, createdAt: new Date().toISOString() };
    const aiMsg: Message = { id: `a-${Date.now()}`, role: 'assistant', content: '', createdAt: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg, aiMsg]);

    abortRef.current = new AbortController();

    // 流式 rAF 批量更新 — 像Codex一样流畅：局部累加 + requestAnimationFrame 合并渲染
    // 高频delta（100+ tokens/秒）只在每帧(~16ms)刷新一次UI，避免每token重渲染
    let accumulatedContent = '';
    let reasoningContent = '';
    let rafPending = false;

    const flushUI = () => {
      rafPending = false;
      if (!mountedRef.current) return; // Oracle 修复：组件已卸载则跳过
      const content = accumulatedContent;
      // S2 修复：推理过程不再写入消息气泡，实时怼到输入框上方横条
      if (reasoningContent) setLiveReasoning(reasoningContent);
      setMessages(prev => prev.map(m =>
        m.id === aiMsg.id ? { ...m, content } : m
      ));
    };

    const scheduleFlush = () => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushUI);
      }
    };

    try {
      if (mode === 'super') {
        const history = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        const agentResults: any[] = [];
        // 清空本会话旧事件（新一轮任务开始）
        useActivityStore.getState().clearConv(convId);

await streamOrchestrate(
          {
            prompt: content,
            conversationId: convId,
            history,
            images: imageAttachments.map(a => a.dataUrl),
            files: fileAttachments.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
            deepThinking,
            webSearch,
            loop: loopMode,
          },
          {
            onEvent: (event) => {
              if (!mountedRef.current) return;
              if (currentConvRef.current !== convId) return;
              switch (event.kind) {
                case 'envelope': {
                  const ev = event.ev;
                  // 统一协议事件 → Activity Store（过程区：任务卡/工具/Agent 状态）
                  useActivityStore.getState().appendEvent(convId, ev);
                  // ask-user 审批：Level 1 敏感工具需用户确认 → 弹确认框并把决定回传
                  if (ev.eventType === 'task.ask-confirm' && ev.metadata?.approvalId) {
                    const apId = String(ev.metadata.approvalId);
                    const toolName = String(ev.metadata.toolName || '工具');
                    const argsSummary = String(ev.metadata.argsSummary || '');
                    void (async () => {
                      const ok = await confirmDialog({
                        title: '🔐 需要你的确认',
                        message: `AI 请求执行操作：${toolName}\n\n参数：${argsSummary}\n\n是否允许？（Level 1 只读模式下需要显式授权）`,
                        confirmText: '允许',
                        cancelText: '拒绝',
                      });
                      try {
                        await api.decideApproval(apId, ok ? 'approved' : 'rejected');
                      } catch { /* 决议失败静默（后端超时兜底） */ }
                    })();
                  }
                  // 最终输出（编排汇总）→ 气泡；子 Agent 过程（agent.message.*）留在过程区（与最终输出分离）
                  if (ev.eventType === 'agent.output.delta' && ev.content) {
                    accumulatedContent += ev.content;
                    scheduleFlush();
                  } else if (ev.eventType === 'agent.error' || ev.eventType === 'task.failed') {
                    accumulatedContent += `\n❌ ${ev.content || '错误'}\n`;
                    scheduleFlush();
                  }
                  break;
                }
                case 'text-delta': {
                  // 兜底：旧协议 message 事件也累积（兼容）
                  accumulatedContent += event.text;
                  scheduleFlush();
                  break;
                }
                case 'reasoning-delta': {
                  reasoningContent += event.text;
                  scheduleFlush();
                  break;
                }
                case 'usage': {
                  setStreamTokens(event.usage);
                  break;
                }
                case 'retry': {
                  setRetryInfo(event.retry);
                  break;
                }
                case 'stream-truncated': {
                  if (currentConvRef.current !== convId) return;
                  accumulatedContent += '\n⚠️ 响应流中断（未收到完整结束标记）\n';
                  scheduleFlush();
                  break;
                }
                case 'error': {
                  if (currentConvRef.current !== convId) return;
                  accumulatedContent += `\n❌ ${event.message}\n`;
                  scheduleFlush();
                  break;
                }
                default: break;
              }
            },
          },
          abortRef.current?.signal,
        );
        // 流式结束：同步刷新最后一帧
        if (rafPending) flushUI();
        if (currentConvRef.current !== convId) return;
        // 移除本地乐观 aiMsg，让轮询从服务端加载真实消息
        setMessages(prev => prev.filter(m => m.id !== aiMsg.id));
        sendNotification('AI 回复完成', { body: accumulatedContent.slice(0, 100) });
      } else {
// 普通模式：流式 + reasoning；统一协议事件写入 Activity Store，兼容回调保持旧渲染
        // 清空本会话旧事件（新一轮任务开始）——仅清空本 turn 的事件
        useActivityStore.getState().clearConv(convId);

await streamConversation(
          convId, content,
          {
            onEvent: (event) => {
              if (!mountedRef.current) return;
              if (currentConvRef.current !== convId) return;
              switch (event.kind) {
                case 'envelope': {
                  // 统一协议事件 → Activity Store（过程区）
                  useActivityStore.getState().appendEvent(convId, event.ev);
                  // ask-user 审批：Level 1 敏感工具需用户确认 → 弹确认框并把决定回传
                  if (event.ev.eventType === 'task.ask-confirm' && event.ev.metadata?.approvalId) {
                    const apId = String(event.ev.metadata.approvalId);
                    const toolName = String(event.ev.metadata.toolName || '工具');
                    const argsSummary = String(event.ev.metadata.argsSummary || '');
                    void (async () => {
                      const ok = await confirmDialog({
                        title: '🔐 需要你的确认',
                        message: `AI 请求执行操作：${toolName}\n\n参数：${argsSummary}\n\n是否允许？（Level 1 只读模式下需要显式授权）`,
                        confirmText: '允许',
                        cancelText: '拒绝',
                      });
                      try {
                        await api.decideApproval(apId, ok ? 'approved' : 'rejected');
                      } catch { /* 决议失败静默（后端超时兜底） */ }
                    })();
                  }
                  break;
                }
                case 'text-delta': {
                  accumulatedContent += event.text;
                  scheduleFlush();
                  break;
                }
                case 'reasoning-delta': {
                  reasoningContent += event.text;
                  scheduleFlush();
                  break;
                }
                case 'usage': {
                  setStreamTokens(event.usage);
                  break;
                }
                case 'replace': {
                  // message-replace：去重替换累积内容
                  accumulatedContent = event.content;
                  scheduleFlush();
                  break;
                }
                case 'retry': {
                  setRetryInfo(event.retry);
                  break;
                }
                case 'stream-truncated': {
                  if (currentConvRef.current !== convId) return;
                  accumulatedContent += '\n⚠️ 响应流中断（未收到完整结束标记）\n';
                  scheduleFlush();
                  break;
                }
                case 'error': {
                  if (currentConvRef.current !== convId) return;
                  accumulatedContent += `\n❌ ${event.message}\n`;
                  scheduleFlush();
                  break;
                }
                default: break;
              }
            },
          },
          {
            signal: abortRef.current?.signal,
            images: imageAttachments.map(a => a.dataUrl), // 传递图片附件
            providerId: selectedProvider?.id, // 传递当前选中的 provider（支持同对话切换模型）
            model: selectedModel, // 传递当前选中的 model
            files: fileAttachments.map(a => ({ name: a.name, dataUrl: a.dataUrl })), // 传递文件附件
            deepThinking,
            reasoningEffort: deepThinking ? 'medium' : undefined,
            webSearch,
            loop: loopMode,
          },
        );
        // 流式结束：同步刷新最后一帧
        if (rafPending) flushUI();
        if (currentConvRef.current !== convId) return;
        // 移除本地乐观 aiMsg，让轮询从服务端加载真实消息
        setMessages(prev => prev.filter(m => m.id !== aiMsg.id));
        sendNotification('AI 回复完成', { body: (accumulatedContent || '').slice(0, 100) });
      }
      load();
      window.dispatchEvent(new CustomEvent('conversations-changed'));
      try {
        const updated = await api.getConversation(convId);
        setCurrentConvTokenTotal(typeof updated.tokenTotal === 'number' ? updated.tokenTotal : 0);
      } catch { /* ignore */ }
    } catch (e: unknown) {
      // Oracle 修复：AbortError（用户主动停止）静默跳过，保留已生成的部分内容
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (e instanceof Error && e.name === 'AbortError') return;
      // convId 守卫防止跨对话错误显示
      if (currentConvRef.current !== convId) return;
      // 出错时移除本地乐观 aiMsg，防止残留空消息气泡
      setMessages(prev => prev.filter(m => m.id !== aiMsg.id));
      // 添加一个错误消息让用户知道
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`, role: 'assistant',
        content: `❌ ${(e instanceof Error ? e.message : String(e))}`,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
      setRetryInfo(null);
      // 流结束后立即清空思考横条
      setLiveReasoning('');
    }
  };

  // Voice input: Web Speech API with real-time transcription (like Codex dictation)
  const toggleVoice = () => {
    if (recording) {
      if (recognitionRef.current) recognitionRef.current.stop();
      else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop();
      setRecording(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      // 修复：中文语音识别 + 连续模式 + 实时中间结果
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      let finalTranscript = '';
      recognition.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interim += transcript;
          }
        }
        // 实时更新输入框：已确认文本 + 中间识别文本
        const display = (finalTranscript + interim).trim();
        if (display) setInput(display);
      };
      recognition.onend = () => {
        setRecording(false);
        // 最终确认的文本保留在 input 中
      };
      recognition.onerror = (e: any) => {
        setRecording(false);
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          console.warn('语音识别错误:', e.error);
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
      alert('语音输入不可用，需要麦克风权限。');
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
          const base64 = reader.result as string;
          try {
            const res = await fetch('/api/conversations/stt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
              body: JSON.stringify({ audio: base64 }),
            });
            if (res.ok) {
              const data = await res.json();
              if (data.text) setInput(prev => prev ? `${prev} ${data.text}`.trim() : data.text);
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
      alert('麦克风访问被拒绝。');
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const att: Attachment = { name: file.name, dataUrl };
        setAttachments(prev => {
          const next = [...prev, att];
          attachmentsRef.current = next;
          return next;
        });
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
    setPlusMenuOpen(false);
  };

  const hasMessages = messages.length > 0;
  const contextTokens = Math.round(messages
    .filter(m => m.role !== 'tool')
    .reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4);

  // Inline input bar JSX
  const renderInputBar = () => (
    <div style={{ width: '100%', position: 'relative' }}>
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />

      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {attachments.map((att, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
              {att.dataUrl.startsWith('data:image/') ? (
                <img src={att.dataUrl} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 32, height: 32, borderRadius: 4, background: 'var(--sidebar-item-active)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {att.name.split('.').pop()?.toUpperCase() || '?'}
                </div>
              )}
              <span style={{ fontSize: 12, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{att.name}</span>
              <button onClick={() => { setAttachments(prev => { const next = prev.filter((_, idx) => idx !== i); attachmentsRef.current = next; return next; }); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
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
            onClick={(e) => { e.stopPropagation(); setPlusMenuOpen(!plusMenuOpen); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: plusMenuOpen ? 'var(--color-accent)' : 'var(--text-tertiary)', padding: '0 12px', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Plus size={20} />
          </button>
          {plusMenuOpen && (
            <div className="glass-menu" style={{
              position: 'absolute', bottom: 52, left: 0, minWidth: 180, zIndex: 9999,
              borderRadius: 12, padding: 4,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              WebkitClipPath: 'none', clipPath: 'none',
            }}>
              <button onClick={handleNew} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', borderRadius: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 13 }}>
                <MessageSquare size={16} /> 新建对话
              </button>
              <button onClick={() => { setPlusMenuOpen(false); fileInputRef.current?.click(); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', borderRadius: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 13 }}>
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
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
        />

        {/* Mic (right) */}
        <button onClick={toggleVoice} title="Voice input"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: recording ? 'var(--color-danger)' : 'var(--text-tertiary)', padding: '0 8px', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Mic size={18} />
        </button>

        {/* Stop/Send (right) */}
        {sending ? (
          <button onClick={() => {
            if (abortRef.current) abortRef.current.abort();
            if (currentConvId) {
              api.cancelConversation(currentConvId).catch(() => {});
              api.cancelAgentGeneration(currentConvId).catch(() => {});
            }
            setSending(false);
          }}
            title="停止生成"
            style={{ flexShrink: 0, height: 44, borderRadius: 8, padding: '0 16px', border: 'none', margin: '0 4px 0 0', background: 'none', cursor: 'pointer', color: 'var(--color-danger)' }}>
            <XCircle size={18} />
          </button>
        ) : (
          <button onClick={handleSend} disabled={sending || !input.trim()}
            className="btn btn-primary"
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

      {/* Token stats bar + 模式切换 + 权限等级（对照 Chat.tsx） */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 8px 4px', fontSize: 11, color: 'var(--text-tertiary)', flexWrap: 'wrap', borderTop: '1px solid var(--border-primary)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {hasMessages && <span>📖 上下文: {contextTokens > 0 ? `${contextTokens.toLocaleString()} tokens` : `${messages.length} 条消息`}</span>}
          {hasMessages && currentConvTokenTotal > 0 && <span>⚡ 对话累计: {currentConvTokenTotal.toLocaleString()} tokens</span>}
          {hasMessages && currentConvTokenTotal === 0 && !sending && <span>⚡ 对话累计: 暂无数据</span>}
          {streamTokens && <span>· 本次: {streamTokens.total_tokens.toLocaleString()} tokens</span>}
          {workspacePath && <span>📁 <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{workspacePath}</span></span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 模型选择器 */}
          {selectedProvider && (
            <select
              value={selectedProvider.id}
              onChange={(e) => {
                const p = providers.find((pp: any) => pp.id === e.target.value);
                if (p) {
                  setSelectedProvider(p);
                  setSelectedModel((p.models && p.models[0]) || p.defaultModel || 'gpt-4o');
                }
              }}
              style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer', maxWidth: 140 }}
              title="选择 AI 模型（支持多模态的模型可分析图片）"
            >
              {providers.filter((p: any) => p.capabilities?.includes?.('text')).map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.capabilities?.includes?.('image') ? ' 📷' : ''}
                </option>
              ))}
            </select>
          )}
          {/* 模式切换 */}
          <button onClick={() => setMode('normal')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'normal' ? 'rgba(94,158,255,0.3)' : 'transparent'}`, background: mode === 'normal' ? 'rgba(94,158,255,0.12)' : 'var(--bg-surface)', color: mode === 'normal' ? 'var(--color-accent)' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            ⊥ 普通
          </button>
          <button onClick={() => setMode('super')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'super' ? 'rgba(167,139,250,0.3)' : 'transparent'}`, background: mode === 'super' ? 'rgba(167,139,250,0.12)' : 'var(--bg-surface)', color: mode === 'super' ? '#a78bfa' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            ⊥ 超级
          </button>
<span style={{ color: 'var(--border-primary)' }}>|</span>
          {/* 深度思考开关（DeepSeek R1 风格 thinking 模式） */}
          <button onClick={() => setDeepThinking(d => !d)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${deepThinking ? 'rgba(94,158,255,0.3)' : 'transparent'}`, background: deepThinking ? 'rgba(94,158,255,0.12)' : 'var(--bg-surface)', color: deepThinking ? 'var(--color-accent)' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            🧠 深度思考
          </button>
          {/* 联网搜索开关 */}
          <button onClick={() => setWebSearch(w => !w)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${webSearch ? 'rgba(52,211,153,0.3)' : 'transparent'}`, background: webSearch ? 'rgba(52,211,153,0.12)' : 'var(--bg-surface)', color: webSearch ? 'var(--color-success)' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            🌐 联网搜索
          </button>
          {/* 循环模式开关 — 勾选后 AI 持续执行直到任务完整完成 */}
          <button onClick={() => setLoopMode(l => !l)}
            title="循环模式：AI 持续执行直到完整完成任务"
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${loopMode ? 'rgba(245,158,11,0.3)' : 'transparent'}`, background: loopMode ? 'rgba(245,158,11,0.12)' : 'var(--bg-surface)', color: loopMode ? '#f59e0b' : 'var(--text-tertiary)', cursor: 'pointer' }}>
            ♾️ 循环
          </button>
          <span style={{ color: 'var(--border-primary)' }}>|</span>
          {/* 权限等级（Level 1:只读 → Level 2:完全 → Level 3:超级） */}
          <button onClick={() => { const nl = permissionLevel >= 3 ? 1 : permissionLevel + 1; api.setPermissions(nl).then(() => setPermissionLevel(nl)).catch(() => {}); }}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${permissionLevel === 3 ? 'rgba(239,68,68,0.3)' : permissionLevel === 2 ? 'rgba(52,211,153,0.3)' : 'rgba(245,158,11,0.3)'}`, background: permissionLevel === 3 ? 'rgba(239,68,68,0.12)' : permissionLevel === 2 ? 'rgba(52,211,153,0.12)' : 'rgba(245,158,11,0.12)', color: permissionLevel === 3 ? '#ef4444' : permissionLevel === 2 ? 'var(--color-success)' : '#f59e0b', cursor: 'pointer' }}>
            {permissionLevel === 3 ? '🔴 Level 3' : permissionLevel === 2 ? '🔓 Level 2' : '🔒 Level 1'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: hasMessages ? 20 : '18vh' }}>
      {/* 审计修复：加载错误提示 banner — 替代静默吞错 */}
      {loadError && (
        <div style={{ width: '100%', maxWidth: 720, padding: '8px 16px', marginBottom: 8, borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--color-danger)', fontSize: 13, textAlign: 'center' }}>
          ⚠️ {loadError}
          <button onClick={() => { setLoadError(null); load(); }} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>重试</button>
        </div>
      )}
      {!hasMessages ? (
        <div style={{ width: '100%', maxWidth: 840, padding: '0 24px' }}>
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6, letterSpacing: '-0.02em', textAlign: 'center' }}>
              What can I build for you?
            </h1>
            <p style={{ fontSize: 14, color: 'var(--text-tertiary)', marginBottom: 28, textAlign: 'center' }}>
              Describe your idea — vibe code it into reality.
            </p>
            {renderInputBar()}
          </motion.div>
        </div>
      ) : (
        <div ref={messageListRef} onScroll={handleScroll} aria-live="polite" aria-atomic="true" style={{ width: '100%', maxWidth: 840, padding: '0 24px', paddingBottom: 120, overflowY: 'auto', maxHeight: 'calc(100vh - 180px)' }}>
          {messages.map((msg, i) => {
            const isLastAssistant = msg.role === 'assistant' && (i === messages.length - 1 || messages[i + 1]?.role === 'user');
            return (
            <div key={msg.id}>
              <MemoBubble msg={msg} index={i} />
              {msg.role === 'assistant' && (false) && null}
            </div>
            );
          })}

          <ActivityStreamLive convId={currentConvId} />

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

          <div ref={messagesEndRef} />

          <div style={{ position: 'fixed', bottom: 24, left: 'var(--sidebar-width)', right: 0, display: 'flex', justifyContent: 'center', zIndex: 10 }}>
            <div style={{ width: '100%', maxWidth: 840, padding: '0 24px' }}>
              {renderInputBar()}
            </div>
          </div>
        </div>
      )}

      
    </div>
  );
}
