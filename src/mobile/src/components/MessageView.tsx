import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getMessages,
  sendCommand,
  subscribeMessages,
  getSyncState,
  onSyncStateChange,
  type SyncStatus,
} from '../api/supabase';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Plus,
  ArrowUp,
} from 'lucide-react';
import AetherMark from './AetherMark';

// ============================================================
// CodeBlock — 弱化边框/行号/背景，代码即内容（§26）
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

// Markdown 渲染（react-markdown + remark-gfm，样式 class 化）
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

// Reasoning — 极轻执行状态（§24：不转圈、无紫、完成静态）
function ReasoningBlock({ reasoning, active }: { reasoning: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
  }, []);

  // 仅 active 时计时，完成即静态
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

function safeParse(json?: string): any | null {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
  tool_calls?: string;
  tool_results?: string;
}

interface Props {
  conversationId: string;
  conversationTitle: string;
  onBack: () => void;
}

export default function MessageView({ conversationId, conversationTitle, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
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
  // P0-A08：Realtime 连接状态（realtime 正常时不轮询，断开时降级轮询）
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => getSyncState().status);
  const reasoningBarRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantReceivedRef = useRef(false);
  // §8.4：仅在接近底部时跟随新内容；用户上翻阅读时停止跟随
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Reasoning 起始时间表（per msg id）
  const reasoningStartRef = useRef<Record<string, number>>({});

  const loadMessages = useCallback(async () => {
    try {
      const data = await getMessages(conversationId);
      setMessages(data);
    } catch (e) {
      console.error('加载消息失败:', e);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    loadMessages();
    // 实时订阅新消息（支持流式逐字更新 — 后端 streaming 不断 upsert 同一消息）
    const unsub = subscribeMessages(conversationId, (newMsg: Message) => {
      setMessages((prev) => {
        const existingIdx = prev.findIndex((m) => m.id === newMsg.id);
        if (existingIdx !== -1) {
          const next = [...prev];
          next[existingIdx] = newMsg;
          return next;
        }
        if (newMsg.role === 'user') {
          const tempIdx = prev.findIndex((m) => m.id.startsWith('temp-'));
          if (tempIdx !== -1) {
            const next = [...prev];
            next[tempIdx] = newMsg;
            return next;
          }
          return [...prev, newMsg];
        }
        return [...prev, newMsg];
      });
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
      if (newMsg.role === 'assistant') {
        setSending(false);
        assistantReceivedRef.current = true;
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        setLiveReasoning('');
      }
    });
    return unsub;
  }, [conversationId, loadMessages]);

  // 轮询兜底（P0-A08）：Realtime 连接正常时不轮询；断开时降级每 2 秒轮询
  useEffect(() => {
    return onSyncStateChange((s) => setSyncStatus(s.status));
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    if (syncStatus === 'connected') return; // Realtime 正常 → 不启动轮询
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      try {
        const data = await getMessages(conversationId);
        if (cancelled) return;
        setMessages((prev) => {
          const merged = [...prev];
          let changed = false;
          for (const newMsg of data) {
            const idx = merged.findIndex((m) => m.id === newMsg.id);
            if (idx !== -1) {
              if (merged[idx].content !== newMsg.content) {
                merged[idx] = newMsg;
                changed = true;
              }
            } else {
              merged.push(newMsg);
              changed = true;
            }
          }
          return changed ? merged : prev;
        });
        const hasAssistant = data.some((m: Message) => m.role === 'assistant');
        if (hasAssistant) {
          setSending(false);
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        }
      } catch { /* 忽略网络错误 */ }
    }, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [conversationId, syncStatus]);

  // §8.4 条件跟随滚动
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    setShowJump(!nearBottomRef.current);
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
    }
  }, [messages]);

  // P1 修复：组件卸载时清理 pending 超时定时器
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, []);

  // 加载提示词模板（从 localStorage）
  useEffect(() => {
    try {
      const saved = localStorage.getItem('aether_mobile_templates');
      if (saved) setTemplates(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  // 计算 token 总量（§10 #6）
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

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    assistantReceivedRef.current = false;

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const optimisticMsg: Message = {
      id: tempId, role: 'user', content: text, created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    // §10 #3 元数据前缀原样
    const contentWithMeta = `[mode=${mode}][level=${permissionLevel}][deep=${deepThinking}][web=${webSearch}][loop=${loopMode}] ${text}`.trim();
    const ok = await sendCommand(contentWithMeta, conversationId);
    if (!ok) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setSending(false);
      return;
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (assistantReceivedRef.current) return;
      setSending((s) => {
        if (s) {
          setMessages((prev) => [...prev, {
            id: `timeout-${Date.now()}`,
            role: 'assistant',
            content: '等待超时，桌面端可能未运行或 AI 配置有误',
            created_at: new Date().toISOString(),
          }]);
          return false;
        }
        return false;
      });
    }, 300000); // 5分钟超时
  };

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

  const renderMessage = (msg: Message, index: number) => {
    const isUser = msg.role === 'user';
    const isTool = msg.role === 'tool';
    const isSystem = msg.role === 'system';
    const isExpanded = expandedTools.has(msg.id);
    const isLastMessage = index === messages.length - 1;

    // Tool — 轻量 pill（§25）
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

    // System — 极轻居中（§历史 保持）
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

    // assistant 消息最后一条且仍在等待 → reasoning 处于活跃状态
    const activeReasoning = isUser ? false : (sending && isLastMessage);

    return (
      <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`} key={msg.id}>
        {isUser ? (
          <>
            <div className="msg-content">{content}</div>
            <span className="msg-time">{formatTime(msg.created_at)}</span>
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

  return (
    <div className="chat-page">
      {/* 顶栏（§19：会话名 + Aether 工作站状态） */}
      <div className="chat-header">
        <button className="chat-back" onClick={onBack} aria-label="返回">
          <ChevronLeft size={22} />
        </button>
        <div className="chat-titles">
          <h2 className="chat-title">{conversationTitle}</h2>
          <p className="chat-subtitle">
            <span className={`sync-dot ${online ? 'online' : ''}`} />
            {sending ? 'Aether 工作站 · 正在工作' : online ? 'Aether 工作站 · 已同步' : 'Aether 工作站 · 连接中断'}
          </p>
        </div>
        <button className="chat-actions" onClick={() => setSettingsOpen(true)} aria-label="执行设置">
          <MoreHorizontal size={20} />
        </button>
      </div>

      {/* 消息列表（§23 内容自然展开） */}
      <div className="message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <h3 className="empty-state-title">暂无消息</h3>
            <p className="empty-state-desc">向桌面端 Aether 发送一条指令</p>
          </div>
        ) : (
          messages.map((m, i) => renderMessage(m, i))
        )}
        {sending && (
          <div className="msg msg-assistant">
            <div className="msg-asst-meta">
              <AetherMark size={14} className="msg-asst-mark" />
              <span className="msg-asst-name">Aether</span>
            </div>
            <div className="msg-content">
              <span>正在处理…</span>
              <span className="stream-indicator" />
            </div>
          </div>
        )}
      </div>

      {/* 回到底部（§29 iOS 轻量浮动） */}
      {showJump && (
        <button
          className="jump-bottom"
          onClick={() => {
            const el = listRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ChevronDown size={16} />
          到底部
        </button>
      )}

      {/* 思考横条（§24 中性，输入框上方） */}
      {liveReasoning ? (
        <div className="reasoning-bar">
          <span className="reasoning-bar-dot" />
          <div ref={reasoningBarRef} className="reasoning-bar-text">{liveReasoning}</div>
        </div>
      ) : null}

      {/* Command Bar（§28 Signature Floating Liquid Glass） */}
      <div className="command-bar-wrap">
        <div className="command-bar">
          <button className="command-bar-btn" onClick={() => setTemplateOpen(!templateOpen)} title="提示词模板">
            <Plus size={20} />
          </button>
          <textarea
            className="command-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入指令…"
            rows={1}
            disabled={sending}
          />
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            aria-label="发送"
          >
            <ArrowUp size={18} />
          </button>
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

      {/* 执行设置 Bottom Sheet（§8.3 功能全保留） */}
      {settingsOpen && (
        <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="sheet settings-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <h3 className="sheet-title">执行设置</h3>

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