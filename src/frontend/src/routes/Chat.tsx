import { useEffect, useState, useRef, useMemo, useCallback, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Plus, MessageSquare, Trash2, Bot, PanelLeftClose, PanelLeftOpen, XCircle, Edit3, Bookmark } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { PromptTemplateSelector } from '../components/PromptTemplateSelector';
import { useActivityStore } from '../store/activityStore';
import { requestNotificationPermission, sendNotification } from '../lib/notifications';
import { api } from '../api/client';
import { fetchEvents } from '../api/streamClient';
import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { OpenCodeStyleCodeBlock } from '../components/OpenCodeBlock';
import { useConversations, useStreamSend, useMessagePolling } from '../hooks';
import { EmptyState } from '../components/ui/empty-state';

// 流式消息 markdown 渲染（含 shiki 代码高亮 — OpenCode 风格代码卡片化）
const streamdownPlugins = { cjk };

/** 当前会话的 Activity Stream — 显示所有过程事件（thinking、tools），按 seq 顺序排列 */
function ChatActivityStream({ convId }: { convId: string | null }) {
  const events = useActivityStore(s => (convId ? s.getEvents(convId) : undefined));
  const taskCard = useMemo(() => (convId && events ? useActivityStore.getState().projectTaskCard(convId) : null), [convId, events]);
  if (!convId || !events || events.length === 0) return null;
  return <ActivityStream events={events} taskCard={taskCard} />;
}

// P2-5: 提取 MessageBubble 组件，用 React.memo 包裹，防止流式更新时全列表重渲染
const MessageBubble = memo(({ msg, i }: { msg: any; i: number }) => {
  if (msg.role === 'tool') return null;
  return (
  <motion.div key={msg.id} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}
    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
  >
    {msg.role === 'user' ? (
      <div style={{
        maxWidth: '75%',
        padding: '10px 16px',
        borderRadius: 22,
        background: 'var(--color-accent)',
        color: 'var(--on-accent)',
        fontSize: 16,
        lineHeight: '24px',
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-wrap',
      }}>
        {msg.content}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4, textAlign: 'right' }}>
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    ) : (
      <div style={{ maxWidth: '75%', padding: '2px 0' }}>
        {msg.content && (
          <div className="prose-md-body" style={{ fontSize: 'var(--font-base)', color: 'var(--text-primary)', lineHeight: 1.65, minWidth: 0, maxWidth: '100%' }}>
            <Streamdown plugins={streamdownPlugins} components={{ pre: OpenCodeStyleCodeBlock }}>{msg.content}</Streamdown>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    )}
  </motion.div>
  );
});
MessageBubble.displayName = 'MessageBubble';

import { ActivityStream } from '../components/activity/ActivityStream';

export function Chat() {
  const [providers, setProviders] = useState<any[]>([]);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [mode, setMode] = useState<'normal' | 'super'>('normal');
  const [deepThinking, setDeepThinking] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [loopMode, setLoopMode] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [currentConvTokenTotal, setCurrentConvTokenTotal] = useState<number>(0);
  const [permissionLevel, setPermissionLevel] = useState<number>(2);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState('');

  const currentConvRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const msgPollReqIdRef = useRef(0);
  const activityPollReqIdRef = useRef(0);
  const initDoneRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // useConversations hook
  const {
    conversations,
    convLoading,
    load: loadConversations,
    handleNew: handleNewConversation,
    handleSelect: handleSelectConversation,
    handleDelete: handleDeleteConversation,
    handleRename,
    setConversations,
  } = useConversations({
    onSelect: (id) => {
      setCurrentConv(id);
      loadMessages(id);
    },
    onCreate: (conv) => {
      setCurrentConv(conv.id);
      setMessages([]);
      setCurrentConvTokenTotal(0);
    },
    onChange: () => {},
  });

  const [currentConv, setCurrentConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [liveReasoning, setLiveReasoning] = useState<string>('');
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxRetries: number; status: number; delay: number } | null>(null);
  const [streamTokens, setStreamTokens] = useState<{ prompt_tokens: number; completion_tokens: number; total_tokens: number } | null>(null);

  const loadMessages = useCallback(async (id: string) => {
    const reqId = ++msgPollReqIdRef.current;
    setCurrentConv(id);
    setStreamTokens(null);
    setRetryInfo(null);
    setLoadError(null);
    setLiveReasoning('');
    try {
      const conv = await api.getConversation(id);
      if (reqId !== msgPollReqIdRef.current) return;
      const processed = (conv.messages || []).map((m: any) => {
        if (m.toolResults) {
          try {
            const tr = JSON.parse(m.toolResults);
            if (tr.reasoning) return { ...m, reasoning: tr.reasoning };
          } catch { /* ignore */ }
        }
        return m;
      });
      setMessages(processed);
      const tokenTotal = typeof conv.tokenTotal === 'number' ? conv.tokenTotal : 0;
      setCurrentConvTokenTotal(tokenTotal);
      try {
        const events = await fetchEvents(id);
        if (reqId !== msgPollReqIdRef.current) return;
        useActivityStore.getState().replaceEvents(id, events);
      } catch { /* ignore */ }
    } catch (e: unknown) {
      if (reqId !== msgPollReqIdRef.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // useStreamSend hook
  const {
    handleSend,
    stopGeneration,
  } = useStreamSend({
    conversationId: currentConv,
    mode,
    messages,
    deepThinking,
    webSearch,
    loopMode,
    selectedProvider: providers.find(p => p.id === currentConv) || null,
    selectedModel: undefined,
    attachments: [],
    onSendStart: () => {
      setSending(true);
      setThinking(true);
      setRetryInfo(null);
      setStreamTokens(null);
      setLiveReasoning('');
    },
    onSendEnd: (success) => {
      if (success) {
        setSending(false);
        setThinking(false);
        setLiveReasoning('');
      }
    },
    onTokens: setStreamTokens,
    onRetry: setRetryInfo,
    onLiveReasoning: setLiveReasoning,
    onMessagesUpdate: setMessages,
    onLoadMessages: loadMessages,
    onLoadConversations: loadConversations,
    currentConvRef,
    abortRef,
    mountedRef,
  });

  // useMessagePolling hook
  useMessagePolling({
    conversationId: currentConv,
    enabled: !!currentConv,
    intervalMs: 2000,
    onMessagesUpdate: setMessages,
    onTokenTotalUpdate: setCurrentConvTokenTotal,
    onSendingUpdate: (generating) => {
      setSending(generating);
      setThinking(generating);
    },
    onLiveReasoningUpdate: setLiveReasoning,
    currentConvRef,
    msgPollReqIdRef,
    activityPollReqIdRef,
    mountedRef,
    pollActivityEvents: true,
    getLastSeq: (convId) => useActivityStore.getState().getLastSeq(convId),
  });

  // Unified initialization
  useEffect(() => {
    if (initDoneRef.current) return;
    initDoneRef.current = true;

    loadConversations();
    requestNotificationPermission();

    api.getProviders().then((data: any[]) => setProviders(Array.isArray(data) ? data : [])).catch(() => {});
    api.getWorkspace().then((res: any) => setWorkspacePath(res?.defaultDir || '')).catch(() => {});
    api.getPermissions().then((res: any) => setPermissionLevel(res?.level ?? 2)).catch(() => {});

    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const isNew = params.get('new') === 'true';
    if (!isNew) return;
    window.history.replaceState({}, '', '/chat');

    if (q) {
      const tempUserMsg = { id: `temp-user-url-${Date.now()}`, role: 'user', content: q, createdAt: new Date().toISOString() };
      setMessages([tempUserMsg]);
      (async () => {
        const provs = await api.getProviders().catch(() => []);
        const dp = Array.isArray(provs) && provs.length > 0 ? provs[0] : null;
        if (!dp) {
          setMessages(prev => [...prev, { id: `temp-ai-noprovider-${Date.now()}`, role: 'assistant', content: '⚠️ 尚未配置 AI Provider。请前往左侧"设置" → "AI Provider"添加您的 API Key。', createdAt: new Date().toISOString() }]);
          return;
        }
        const model = Array.isArray(dp.models) && dp.models[0] ? dp.models[0] : (dp.defaultModel || 'gpt-4o');
        try {
          const conv = await api.createConversation({ title: q.slice(0, 30), providerId: dp.id, model });
          setCurrentConv(conv.id);
          const res = await api.sisyphusReply({ prompt: q, conversationId: conv.id, providerId: dp.id, model });
          if (res?.conversationId) {
            await loadMessages(res.conversationId);
            sendNotification('AI 回复完成', { body: String(res.reply || res.content || q).slice(0, 100) });
          }
        } catch (e: unknown) {
          setMessages(prev => [...prev, { id: `temp-ai-error-${Date.now()}`, role: 'assistant', content: '❌ AI 回复失败: ' + (e instanceof Error ? e.message : String(e)), createdAt: new Date().toISOString() }]);
        }
      })();
    } else {
      (async () => {
        const provs = await api.getProviders().catch(() => []);
        if (Array.isArray(provs) && provs.length > 0) {
          await handleNewConversation(provs);
        } else {
          setMessages([{ id: `err-${Date.now()}`, role: 'assistant', content: '⚠️ 尚未配置 AI Provider。请在设置中添加 API Key 后重试。', createdAt: new Date().toISOString() }]);
        }
      })();
    }
  }, [loadConversations, handleNewConversation, loadMessages]);

  useEffect(() => { currentConvRef.current = currentConv; }, [currentConv]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleDelete = useCallback(async (id: string) => {
    await handleDeleteConversation(id);
    if (currentConv === id) {
      setCurrentConv(null);
      setMessages([]);
      setCurrentConvTokenTotal(0);
    }
  }, [handleDeleteConversation, currentConv]);

  const contextTokens = Math.round(messages
    .filter(m => m.role !== 'tool')
    .reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4);
  const hasTokenData = currentConvTokenTotal > 0;

  const messageList = useMemo(() => messages, [messages]);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
    <div style={{ maxWidth: 'min(1100px, 100%)', margin: '0 auto', padding: '0 16px' }}>
      <PageHeader title="对话" description="与 AI 助手交流，管理多轮对话" icon={<MessageSquare size={22} />} color="var(--color-accent)" action={<button className="btn btn-primary" onClick={() => handleNewConversation(providers)} title="新建对话"><Plus size={18} /> 新建对话</button>} />

      <div className="flex flex-1 gap-6 min-h-0">
        {/* 左侧 — 对话列表（可折叠） */}
        <AnimatePresence initial={false}>
          {!listCollapsed && (
            <motion.div key="conv-list" className="w-72 flex-shrink-0 flex flex-col min-h-0"
              initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: 288 }} exit={{ opacity: 0, width: 0 }} transition={{ duration: 0.2 }}>
              <div style={{ padding: '12px' }}>
                <div className="flex items-center justify-between" style={{ padding: '8px 8px 12px' }}>
                  <span style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>对话列表</span>
                  <div className="flex items-center gap-1">
                    <button className="btn btn-primary" onClick={() => handleNewConversation(providers)} title="新建对话" style={{ width: 44, padding: 0 }}>
                      <Plus size={18} />
                    </button>
                    <button onClick={() => setListCollapsed(true)} className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.08]"
                      style={{ color: 'var(--text-tertiary)' }} title="收起" aria-label="收起对话列表"><PanelLeftClose size={16} /></button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto min-h-0" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {conversations.map((conv, i) => (
                    <motion.div
                      key={conv.id}
                      onClick={() => handleSelectConversation(conv.id)}
                      className="cursor-pointer group"
                      style={{
                        padding: '12px',
                        borderRadius: '8px',
                        background: currentConv === conv.id ? 'var(--card-hover-bg)' : 'transparent',
                        border: 'none',
                      }}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04, duration: 0.4 }}
                      whileHover={{ y: -1, transition: { duration: 0.2 } }}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex items-center justify-center flex-shrink-0" style={{ width: 34, height: 34, borderRadius: 10, background: currentConv === conv.id ? 'rgba(94, 158, 255, 0.18)' : 'var(--bg-surface)' }}>
                          <MessageSquare size={15} style={{ color: currentConv === conv.id ? 'var(--color-accent)' : 'var(--text-secondary)' }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate" title={conv.title} style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>{conv.title}</div>
                          <div className="mt-1 truncate" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                            {new Date(conv.updatedAt).toLocaleString()}
                            {typeof conv.tokenTotal === 'number' && conv.tokenTotal > 0 && ` · ⚡ ${conv.tokenTotal.toLocaleString()} tokens`}
                          </div>
                        </div>
                        <button
                          className="flex items-center justify-center w-8 h-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/[0.08] flex-shrink-0"
                          onClick={async (e) => {
                            e.stopPropagation();
                            const newTitle = prompt('重命名对话:', conv.title);
                            if (newTitle && newTitle.trim() && newTitle.trim() !== conv.title) {
                              await handleRename(conv.id, newTitle.trim());
                            }
                          }}
                          title="重命名对话"
                          aria-label="重命名对话"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          <Edit3 size={14} />
                        </button>
                        <button
                          className="flex items-center justify-center w-8 h-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/[0.08] flex-shrink-0"
                          onClick={(e) => { e.stopPropagation(); handleDelete(conv.id); }}
                          title="删除对话"
                          aria-label="删除对话"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                  {convLoading && conversations.length === 0 && (
                    <div className="empty-state">
                      <div className="spinner" style={{ width: 20, height: 20, margin: '0 auto 8px' }} />
                      <div className="empty-state-title" style={{ fontSize: 13 }}>加载中...</div>
                    </div>
                  )}
                  {!convLoading && conversations.length === 0 && (
                    <div className="empty-state">
                      <MessageSquare size={28} className="empty-state-icon" />
                      <div className="empty-state-title">暂无对话</div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 折叠后的小图标按钮 */}
        {listCollapsed && (
          <motion.div className="flex-shrink-0 flex flex-col items-center pt-2"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
            <div style={{ padding: '8px', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => setListCollapsed(false)} className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-white/[0.08]" style={{ color: 'var(--text-tertiary)' }} title="展开对话列表" aria-label="展开对话列表">
                <PanelLeftOpen size={18} />
              </button>
              <button onClick={() => handleNewConversation(providers)} className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-white/[0.08]" style={{ color: 'var(--color-accent)' }} title="新建对话" aria-label="新建对话">
                <Plus size={18} />
              </button>
              <div className="text-center" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{conversations.length}</div>
            </div>
          </motion.div>
        )}

        {/* 右侧 — 聊天区域 */}
        <div className="flex-1 flex flex-col min-h-0">
          {currentConv ? (
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="flex-1 overflow-y-auto min-h-0" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 8px 16px' }} aria-live="polite" aria-atomic="true">
                {loadError && (
                  <div className="flex flex-col items-center justify-center py-12" style={{ gap: 12 }}>
                    <div style={{ fontSize: '13px', color: 'var(--color-danger)' }}>⚠️ 消息加载失败: {loadError}</div>
                    <button className="btn btn-ghost" onClick={() => currentConv && loadMessages(currentConv)} style={{ fontSize: '13px' }}>
                      重试
                    </button>
                  </div>
                )}
                {!loadError && messageList.map((msg, i) => {
                const isUser = msg.role === 'user';
                return (
                  <div key={msg.id}>
                    <MessageBubble msg={msg} i={i} />
                    {isUser && <ChatActivityStream convId={currentConv} />}
                  </div>
                );
              })}
                {thinking && (
                  <div className="flex items-center justify-center py-4">
                    <div className="flex items-center gap-3">
                      <div className="flex gap-1">
                        <motion.div className="w-2 h-2 rounded-full" style={{ background: 'var(--color-accent)' }}
                          animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
                          transition={{ duration: 1.2, repeat: Infinity, delay: 0 }} />
                        <motion.div className="w-2 h-2 rounded-full" style={{ background: 'var(--color-accent)' }}
                          animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
                          transition={{ duration: 1.2, repeat: Infinity, delay: 0.2 }} />
                        <motion.div className="w-2 h-2 rounded-full" style={{ background: 'var(--color-accent)' }}
                          animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
                          transition={{ duration: 1.2, repeat: Infinity, delay: 0.4 }} />
                      </div>
                      <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                        处理中...
                      </span>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="flex items-center justify-between" style={{ padding: '6px 8px 4px', borderTop: '1px solid var(--border-primary)' }}>
<div className="flex items-center gap-3" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                     <span>📖 上下文: {contextTokens > 0 ? `${contextTokens.toLocaleString()} tokens` : `${messages.length} 条消息`}</span>
                     <span>⚡ 对话累计: {hasTokenData ? `${currentConvTokenTotal.toLocaleString()} tokens` : '暂无数据'}</span>
                     {streamTokens && <span>· 本次: {streamTokens.total_tokens.toLocaleString()} tokens</span>}
                   </div>
                <div className="flex items-center gap-2" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                  {workspacePath && <span className="flex items-center gap-1">📁 <span className="truncate" style={{ maxWidth: 120, display: 'inline-block' }}>{workspacePath}</span></span>}
                </div>
              </div>
              {retryInfo && (
                <div style={{ padding: '6px 8px 0', fontSize: '12px', color: 'var(--color-warning)' }}>
                  请求失败 ({retryInfo.status})，{retryInfo.attempt}/{retryInfo.maxRetries} 次重试中...
                </div>
              )}
              <div className="flex gap-3" style={{ padding: '8px 8px 4px' }}>
                <input className="input flex-1" value={input} onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) handleSend();
                  }}
                  placeholder="输入消息，按 Enter 发送..." />
                {sending ? (
                  <button className="btn btn-ghost" onClick={stopGeneration} title="停止生成" aria-label="停止生成" style={{ width: 44, padding: 0, flexShrink: 0, color: 'var(--color-danger)' }}>
                    <XCircle size={18} />
                  </button>
                ) : null}
                <button className="btn btn-ghost" onClick={() => setTemplateOpen(true)} title="提示词模板" aria-label="提示词模板" style={{ width: 44, padding: 0, flexShrink: 0, color: 'var(--text-secondary)' }}>
                  <Bookmark size={18} />
                </button>
                <button className="btn btn-primary" onClick={() => handleSend()} disabled={sending} title="发送" aria-label="发送" style={{ width: 44, padding: 0, flexShrink: 0 }}>
                  {sending ? <div className="spinner spinner-sm" /> : <Send size={18} />}
                </button>
              </div>
              <div className="flex items-center justify-between" style={{ padding: '8px 8px 0', borderTop: 'none' }}>
<div className="flex items-center gap-2">
                     <button onClick={() => setMode('normal')}
                       className="flex items-center gap-1.5 px-3 py-1 rounded-full transition-all"
                       style={{
                         fontSize: '11px', fontWeight: 600,
                         color: mode === 'normal' ? 'var(--color-accent)' : 'var(--text-tertiary)',
                         background: mode === 'normal' ? 'rgba(94,158,255,0.12)' : 'var(--bg-surface)',
                         border: `1px solid ${mode === 'normal' ? 'rgba(94,158,255,0.3)' : 'transparent'}`,
                       }}>
                       ⊥ 普通模式
                     </button>
                     <button onClick={() => setMode('super')}
                       className="flex items-center gap-1.5 px-3 py-1 rounded-full transition-all"
                       style={{
                         fontSize: '11px', fontWeight: 600,
                         color: mode === 'super' ? '#a78bfa' : 'var(--text-tertiary)',
                         background: mode === 'super' ? 'rgba(167,139,250,0.12)' : 'var(--bg-surface)',
                         border: `1px solid ${mode === 'super' ? 'rgba(167,139,250,0.3)' : 'transparent'}`,
                       }}>
                       ⊥ 超级模式
                     </button>
                     <span className="mx-1" style={{ color: 'var(--border-primary)' }}>|</span>
                     <button onClick={() => setDeepThinking(d => !d)}
                       className="flex items-center gap-1.5 px-3 py-1 rounded-full transition-all"
                       style={{
                         fontSize: '11px', fontWeight: 600,
                         color: deepThinking ? 'var(--color-accent)' : 'var(--text-tertiary)',
                         background: deepThinking ? 'rgba(94,158,255,0.12)' : 'var(--bg-surface)',
                         border: `1px solid ${deepThinking ? 'rgba(94,158,255,0.3)' : 'transparent'}`,
                       }}>
                       🧠 深度思考
                     </button>
                     <button onClick={() => setWebSearch(w => !w)}
                       className="flex items-center gap-1.5 px-3 py-1 rounded-full transition-all"
                       style={{
                         fontSize: '11px', fontWeight: 600,
                         color: webSearch ? 'var(--color-success)' : 'var(--text-tertiary)',
                         background: webSearch ? 'rgba(52,211,153,0.12)' : 'var(--bg-surface)',
                         border: `1px solid ${webSearch ? 'rgba(52,211,153,0.3)' : 'transparent'}`,
                       }}>
                        🌐 联网搜索
                      </button>
                      <button onClick={() => setLoopMode(l => !l)}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-full transition-all"
                        title="循环模式：AI 持续执行直到完整完成任务"
                        style={{
                          fontSize: '11px', fontWeight: 600,
                          color: loopMode ? 'var(--color-warning)' : 'var(--text-tertiary)',
                          background: loopMode ? 'rgba(245,158,11,0.12)' : 'var(--bg-surface)',
                          border: `1px solid ${loopMode ? 'rgba(245,158,11,0.3)' : 'transparent'}`,
                        }}>
                        ♾️ 循环
                      </button>
                      <span className="mx-1" style={{ color: 'var(--border-primary)' }}>|</span>
                      <button onClick={() => {
                        const newLevel = permissionLevel === 1 ? 2 : 1;
                        api.setPermissions(newLevel).then(() => setPermissionLevel(newLevel)).catch(() => {});
                      }}
                        className="flex items-center gap-1 px-3 py-1 rounded-full transition-all"
                        style={{
                          fontSize: '11px', fontWeight: 600,
                          color: permissionLevel === 2 ? 'var(--color-success)' : '#f59e0b',
                          background: permissionLevel === 2 ? 'rgba(52,211,153,0.12)' : 'rgba(245,158,11,0.12)',
                          border: `1px solid ${permissionLevel === 2 ? 'rgba(52,211,153,0.3)' : 'rgba(245,158,11,0.3)'}`,
                        }}>
                        {permissionLevel === 2 ? '🔓 Level 2' : '🔒 Level 1'}
                      </button>
                      </div>
                   </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
              <EmptyState
                icon={<Bot size={48} className="empty-state-icon" />}
                title="选择一个对话或新建一个"
                description="与 AI 助手交流，完成任务"
              />
            </div>
          )}
        </div>
      </div>
    </div>
    <PromptTemplateSelector
      open={templateOpen}
      onClose={() => setTemplateOpen(false)}
      onSelect={(content) => setInput(content)}
      currentInput={input}
    />
    </div>
  );
}