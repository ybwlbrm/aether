import { useState, useEffect, useRef, useCallback } from 'react';
import { getMessages, sendCommand, subscribeMessages } from '../api/supabase';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// 代码块组件（带行号+复制按钮，透明背景）
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
    <div style={{ margin: '8px 0', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 11, fontWeight: 600, background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
        <span>{language}</span>
        <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{lines.length} 行</span>
        <button onClick={handleCopy} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}>{copied ? '已复制' : '复制'}</button>
      </div>
      <div style={{ padding: '8px 12px', overflowX: 'auto', fontSize: 12, lineHeight: 1.5, fontFamily: 'monospace', background: 'transparent' }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text-tertiary)', textAlign: 'right', minWidth: `${lineNumWidth}ch`, userSelect: 'none', flexShrink: 0 }}>{i + 1}</span>
            <span style={{ color: 'var(--text)' }}>{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Markdown 渲染组件（react-markdown + remark-gfm，支持表格/代码块/链接/图片等）
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
          return <code style={{ fontSize: 12, padding: '1px 5px', borderRadius: 4, background: 'transparent', color: 'var(--text)', border: 'none' }} {...props}>{children}</code>;
        },
        pre({ children }) { return <>{children}</>; },
        table({ children }) {
          return <div style={{ overflowX: 'auto', margin: '8px 0' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: 'transparent', border: '1px solid var(--border)' }}>{children}</table></div>;
        },
        th({ children }) { return <th style={{ border: '1px solid var(--border)', padding: '4px 8px', textAlign: 'left', background: 'rgba(94,158,255,0.08)', fontWeight: 600 }}>{children}</th>; },
        td({ children }) { return <td style={{ border: '1px solid var(--border)', padding: '4px 8px', background: 'transparent' }}>{children}</td>; },
        a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#5e9eff' }}>{children}</a>; },
        img({ src, alt }) {
          if (src?.startsWith('data:') || src?.startsWith('http')) {
            return <img src={src} alt={alt} style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 8, margin: '8px 0', display: 'block' }} />;
          }
          return <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>[图片]</span>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
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
  // 手机端思考过程横条
  const [liveReasoning, setLiveReasoning] = useState<string>('');
  const reasoningBarRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantReceivedRef = useRef(false);

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
        const existingIdx = prev.findIndex(m => m.id === newMsg.id);
        if (existingIdx !== -1) {
          const next = [...prev];
          next[existingIdx] = newMsg;
          return next;
        }
        if (newMsg.role === 'user') {
          const tempIdx = prev.findIndex(m => m.id.startsWith('temp-'));
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

  // 轮询兜底：Realtime 断连时仍能收到新消息（每 2 秒拉取一次）
  useEffect(() => {
    if (!conversationId) return;
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
            const idx = merged.findIndex(m => m.id === newMsg.id);
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
        // 检查是否有新的 assistant 消息（生成完成）
        const hasAssistant = data.some((m: Message) => m.role === 'assistant');
        if (hasAssistant) {
          setSending(false);
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        }
      } catch { /* 忽略网络错误 */ }
    }, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [conversationId]);

  // 自动滚动到底部
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // P1 修复：组件卸载时清理 pending 超时定时器，防泄漏/悬空 setState
  useEffect(() => {
    const current = timeoutRef.current;
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

  // 计算 token 总量（从助手消息 tool_results 累加）
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

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const optimisticMsg: Message = {
      id: tempId, role: 'user', content: text, created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    // 附加模式参数
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
            content: '⚠️ 等待超时，桌面端可能未运行或 AI 配置有误',
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
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  };

  const renderMessage = (msg: Message) => {
    const isUser = msg.role === 'user';
    const isTool = msg.role === 'tool';
    const isSystem = msg.role === 'system';
    const isExpanded = expandedTools.has(msg.id);

    // 工具消息 — 可展开/收起
    if (isTool) {
      const showFull = isExpanded || msg.content.length <= 150;
      const display = showFull ? msg.content : msg.content.slice(0, 150) + '...';
      return (
        <div className="message tool" key={msg.id} style={{ alignSelf: 'stretch', cursor: 'pointer' }}
          onClick={() => toggleToolExpand(msg.id)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: '#34d399', fontSize: 12 }}>🔧 工具结果</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{isExpanded ? '▲ 收起' : '▼ 展开'}</span>
          </div>
          <div style={{ whiteSpace: 'pre-wrap', maxHeight: isExpanded ? 400 : 120, overflowY: 'auto', fontWeight: 400 }}>
            {display}
          </div>
          <div className="message-time">{formatTime(msg.created_at)}</div>
        </div>
      );
    }

    if (isSystem) {
      return (
        <div className="message system" key={msg.id}>
          ⚙️ {msg.content}
          <div className="message-time">{formatTime(msg.created_at)}</div>
        </div>
      );
    }

    const content = msg.content;
    const hasCode = content.includes('```');
    let reasoning = '';
    if (msg.tool_results) {
      try {
        const tr = JSON.parse(msg.tool_results);
        if (tr.reasoning) reasoning = tr.reasoning;
      } catch { /* ignore */ }
    }

    return (
      <div className={`message ${isUser ? 'user' : 'assistant'}`} key={msg.id}>
        {reasoning && (
          <div style={{
            marginBottom: 8, padding: '8px 12px', borderRadius: 8,
            background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.15)',
            fontSize: 12, color: 'var(--text-secondary)',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: '#a78bfa' }}>🧠 思考过程</div>
            <div style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', lineHeight: 1.5 }}>{reasoning}</div>
          </div>
        )}
        {hasCode ? (
          <div style={{ marginTop: 4 }}>
            <MarkdownContent content={content} />
          </div>
        ) : (
          <div style={{ whiteSpace: 'pre-wrap' }}><MarkdownContent content={content} /></div>
        )}
        <div className="message-time">{formatTime(msg.created_at)}</div>
      </div>
    );
  };

  if (loading) {
    return (
<div className="app-layout chat-view">
        <div className="chat-header">
          <button className="back-btn" onClick={onBack}>←</button>
          <h2>{conversationTitle}</h2>
        </div>
        <div className="loading">
          <div className="spinner" />
          加载中...
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div className="chat-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <h2>{conversationTitle}</h2>
        <span className="status-dot online" />
      </div>

      {/* 模式/Level/Token 控制栏（对齐电脑端） */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)',
        borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
        background: 'rgba(10,10,15,0.6)', backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {convTokenTotal > 0 && <span>⚡ 累计: {convTokenTotal.toLocaleString()} tokens</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* 模式切换 */}
          <button onClick={() => setMode('normal')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'normal' ? 'rgba(94,158,255,0.3)' : 'transparent'}`, background: mode === 'normal' ? 'rgba(94,158,255,0.12)' : 'var(--bg-card)', color: mode === 'normal' ? '#5e9eff' : 'var(--text-secondary)', cursor: 'pointer' }}>
            ⊥ 普通
          </button>
          <button onClick={() => setMode('super')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'super' ? 'rgba(167,139,250,0.3)' : 'transparent'}`, background: mode === 'super' ? 'rgba(167,139,250,0.12)' : 'var(--bg-card)', color: mode === 'super' ? '#a78bfa' : 'var(--text-secondary)', cursor: 'pointer' }}>
            ⊥ 超级
          </button>
          <span style={{ color: 'var(--border)' }}>|</span>
          {/* 权限等级 */}
          <button onClick={() => setPermissionLevel(l => l >= 3 ? 1 : l + 1)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${permissionLevel === 3 ? 'rgba(239,68,68,0.3)' : permissionLevel === 2 ? 'rgba(52,211,153,0.3)' : 'rgba(245,158,11,0.3)'}`, background: permissionLevel === 3 ? 'rgba(239,68,68,0.12)' : permissionLevel === 2 ? 'rgba(52,211,153,0.12)' : 'rgba(245,158,11,0.12)', color: permissionLevel === 3 ? '#ef4444' : permissionLevel === 2 ? '#34d399' : '#f59e0b', cursor: 'pointer' }}>
            {permissionLevel === 3 ? '🔴 Level 3' : permissionLevel === 2 ? '🔓 Level 2' : '🔒 Level 1'}
          </button>
          <span style={{ color: 'var(--border)' }}>|</span>
          {/* 深度思考开关 */}
          <button onClick={() => setDeepThinking(d => !d)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${deepThinking ? 'rgba(94,158,255,0.3)' : 'transparent'}`, background: deepThinking ? 'rgba(94,158,255,0.12)' : 'transparent', color: deepThinking ? '#5e9eff' : 'var(--text-secondary)', cursor: 'pointer' }}>
            🧠 深度
          </button>
          {/* 联网搜索开关 */}
          <button onClick={() => setWebSearch(w => !w)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${webSearch ? 'rgba(52,211,153,0.3)' : 'transparent'}`, background: webSearch ? 'rgba(52,211,153,0.12)' : 'transparent', color: webSearch ? '#34d399' : 'var(--text-secondary)', cursor: 'pointer' }}>
            🌐 联网
          </button>
          {/* 循环模式开关 */}
          <button onClick={() => setLoopMode(l => !l)}
            title="循环模式：AI 持续执行直到完整完成任务"
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${loopMode ? 'rgba(245,158,11,0.3)' : 'transparent'}`, background: loopMode ? 'rgba(245,158,11,0.12)' : 'transparent', color: loopMode ? '#f59e0b' : 'var(--text-secondary)', cursor: 'pointer' }}>
            ♾️ 循环
          </button>
        </div>
      </div>

      <div className="message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <div className="empty-state-icon">💬</div>
            <h3>暂无消息</h3>
            <p>发送一条指令开始对话</p>
          </div>
        ) : (
          messages.map(renderMessage)
        )}
        {sending && (
          <div className="message assistant" style={{ alignSelf: 'flex-start', background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="spinner" style={{ width: 16, height: 16, margin: 0 }} />
              正在处理...
            </div>
          </div>
        )}
      </div>

      {/* 手机端思考过程横条 — 输入框上方 */}
      {liveReasoning ? (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8,
          margin: '4px 12px 2px', padding: '6px 10px',
          borderRadius: 12, maxHeight: 100,
          background: 'rgba(167,139,250,0.08)',
          border: '1px solid rgba(167,139,250,0.18)',
          backdropFilter: 'blur(12px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(12px) saturate(1.4)',
        }}>
          <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>🧠</span>
          <div ref={reasoningBarRef} style={{
            flex: 1, fontSize: 12, lineHeight: 1.6,
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap', maxHeight: 86,
            overflowY: 'auto',
          }}>{liveReasoning}</div>
        </div>
      ) : null}

      <div className="command-input-area">
        {templateOpen && (
          <div style={{
            position: 'fixed', bottom: 72, left: 12, right: 12, zIndex: 100,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 14, padding: 8, maxHeight: 240, overflowY: 'auto',
            backdropFilter: 'blur(24px)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>提示词模板</span>
              <button onClick={() => setTemplateOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 14, cursor: 'pointer' }}>✕</button>
            </div>
            {templates.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', padding: 8 }}>暂无模板</p>
            ) : (
              templates.map((t, i) => (
                <button key={i} onClick={() => { setInput(t.content); setTemplateOpen(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
                  <span style={{ fontWeight: 600 }}>{t.name}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 11, marginLeft: 6 }}>{t.content.slice(0, 40)}</span>
                </button>
              ))
            )}
          </div>
        )}
        <button onClick={() => setTemplateOpen(!templateOpen)}
          title="提示词模板"
          style={{ flexShrink: 0, height: 44, padding: '0 8px', borderRadius: 22, border: '1px solid var(--border)', background: templateOpen ? 'rgba(94,158,255,0.12)' : 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', fontSize: 16, cursor: 'pointer' }}>
          ⚡
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入指令，按 Enter 发送..."
          rows={1}
          disabled={sending}
        />
        <button
          className={`send-btn ${sending ? 'sending' : ''}`}
          onClick={handleSend}
          disabled={!input.trim() || sending}
        >
          {sending ? '⋯' : '↑'}
        </button>
      </div>
    </div>
  );
}