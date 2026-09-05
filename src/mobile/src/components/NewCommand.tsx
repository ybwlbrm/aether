import { useState, useRef, useEffect, useCallback } from 'react';
import { sendCommand, getClient, getConversations } from '../api/supabase';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
  tool_results?: string | null;
}

interface Props {
  onBack: () => void;
}

// 生成新的对话 ID（不持久化，每次进 NewCommand 都是新对话）
function generateConvId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'remote-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// 简单 markdown 渲染函数（轻量，不依赖第三方库）
function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  const parts: React.ReactNode[] = [];
  let key = 0;
  const codeBlocks: { start: number; end: number; lang: string; code: string }[] = [];
  const codeRegex = /```(\w*)\n([\s\S]*?)```/g;
  let cm: RegExpExecArray | null;
  while ((cm = codeRegex.exec(text)) !== null) {
    codeBlocks.push({ start: cm.index, end: cm.index + cm[0].length, lang: cm[1] || 'text', code: cm[2] });
  }
  if (codeBlocks.length > 0) {
    let pos = 0;
    for (const block of codeBlocks) {
      if (block.start > pos) parts.push(renderInline(text.slice(pos, block.start), key++));
      parts.push(
        <div key={`code-${key++}`} style={{ margin: '8px 0', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <div style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', textTransform: 'uppercase' }}>{block.lang}</div>
          <pre style={{ margin: 0, padding: '10px 12px', overflowX: 'auto', fontSize: 12, lineHeight: 1.5, fontFamily: 'monospace', color: '#e8e8f0', background: '#0d1117' }}><code>{block.code}</code></pre>
        </div>
      );
      pos = block.end;
    }
    if (pos < text.length) parts.push(renderInline(text.slice(pos), key++));
    return parts;
  }
  return renderInline(text, 0);
}

function renderInline(text: string, key: number): React.ReactNode {
  if (!text) return null;
  const elements: React.ReactNode[] = [];
  let remaining = text;
  let idx = 0;
  while (remaining.length > 0) {
    const imgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      const url = imgMatch[2];
      if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) {
        elements.push(<img key={`img-${key}-${idx}`} src={url} alt={imgMatch[1]} style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 8, margin: '8px 0', display: 'block' }} />);
      } else {
        elements.push(<span key={`img-${key}-${idx}`} style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>[图片]</span>);
      }
      remaining = remaining.slice(imgMatch[0].length);
      idx++; continue;
    }
    const linkMatch = remaining.match(/^\[([^\]]*)\]\(([^)]+)\)/);
    if (linkMatch) {
      elements.push(<a key={`link-${key}-${idx}`} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" style={{ color: '#5e9eff' }}>{linkMatch[1]}</a>);
      remaining = remaining.slice(linkMatch[0].length);
      idx++; continue;
    }
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) { elements.push(<strong key={`b-${key}-${idx}`}>{boldMatch[1]}</strong>); remaining = remaining.slice(boldMatch[0].length); idx++; continue; }
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) { elements.push(<em key={`i-${key}-${idx}`}>{italicMatch[1]}</em>); remaining = remaining.slice(italicMatch[0].length); idx++; continue; }
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      elements.push(<code key={`c-${key}-${idx}`} style={{ fontSize: 12, padding: '1px 5px', borderRadius: 4, background: 'rgba(167,139,250,0.14)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.18)' }}>{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length); idx++; continue;
    }
    elements.push(remaining[0]);
    remaining = remaining.slice(1);
    idx++;
  }
  return <span key={key}>{elements}</span>;
}

export default function NewCommand({ onBack }: Props) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveReasoning, setLiveReasoning] = useState('');
  const [mode, setMode] = useState<'normal' | 'super'>('normal');
  const [permissionLevel, setPermissionLevel] = useState(2);
  const [imageAttachments, setImageAttachments] = useState<string[]>([]);
  const [fileAttachments, setFileAttachments] = useState<{ name: string; dataUrl: string }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<any>(null);
  const sbRef = useRef<any>(null);
  const remoteConvIdRef = useRef<string>(generateConvId());
  const seenMsgIdsRef = useRef<Set<string>>(new Set());
const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const assistantReceivedRef = useRef(false);
const fileInputRef = useRef<HTMLInputElement>(null);

  // 自动滚动
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // 清理订阅 + 定时器
  useEffect(() => {
    return () => {
      if (channelRef.current && sbRef.current) {
        sbRef.current.removeChannel(channelRef.current).catch(() => {});
      }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
  }, []);

  // 细节：加载当前远程对话已有的历史消息（重启后能恢复）
  const loadRemoteHistory = useCallback(async () => {
    try {
      const convId = remoteConvIdRef.current;
      const convs = await getConversations();
      const conv = convs.find((c: any) => c.id === convId);
      if (conv) {
        const sb = getClient();
        if (sb) {
          const { data } = await sb
            .from('messages_sync')
            .select('*')
            .eq('conversation_id', convId)
            .order('created_at', { ascending: true });
          if (data && data.length > 0) {
            // 只保留已完成的 user 消息和 assistant 回复，标记已见 ID 避免重复
            const msgs = data.filter((m: any) => m.role === 'user' || m.role === 'assistant');
            const shown = msgs.filter((m: any) => !seenMsgIdsRef.current.has(m.id));
            shown.forEach((m: any) => seenMsgIdsRef.current.add(m.id));
            if (shown.length > 0) setMessages(prev => [...prev, ...shown]);
          }
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRemoteHistory(); }, [loadRemoteHistory]);

  // Q4 优化：Realtime 轮询兜底 — 网络波动或 Realtime 心跳延迟时，
  // 每 2s 拉取一次最新消息保证回复不"卡死"（与 Realtime 推送互补，不重复显示）
  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      // 仅在发送中或已有消息时轮询（空对话页无谓轮询无意义）
      try {
        const sb = getClient();
        if (!sb) return;
        const { data } = await sb
          .from('messages_sync')
          .select('*')
          .eq('conversation_id', remoteConvIdRef.current)
          .order('created_at', { ascending: true })
          .limit(50);
        if (!data) return;
        const msgs = data.filter((m: any) => m.role === 'user' || m.role === 'assistant');
        for (const m of msgs) {
          if (seenMsgIdsRef.current.has(m.id)) continue;
          seenMsgIdsRef.current.add(m.id);
          setMessages(prev => {
            // 替换本地乐观 temp 消息
            if (m.role === 'user') {
              const tempIdx = prev.findIndex(x => x.id.startsWith('temp-'));
              if (tempIdx !== -1) {
                const next = [...prev];
                next[tempIdx] = m as Message;
                return next;
              }
            }
            return [...prev, m as Message];
          });
          if (m.role === 'assistant') {
            assistantReceivedRef.current = true;
            if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
            setSending(false);
          }
        }
      } catch { /* 网络错误忽略，下轮重试 */ }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // 建立 Realtime 订阅，监听所有新消息
  const setupRealtime = () => {
    const sb = getClient();
    if (!sb) return;
    sbRef.current = sb;

    if (channelRef.current) {
      sb.removeChannel(channelRef.current).catch(() => {});
    }

    channelRef.current = sb.channel('new-command-messages')
      .on('postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages_sync',
          filter: `conversation_id=eq.${remoteConvIdRef.current}`,
        },
        handleMessage,
      )
      .on('postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages_sync',
          filter: `conversation_id=eq.${remoteConvIdRef.current}`,
        },
        handleMessage,
      )
      .subscribe();
  };

  // 统一处理 INSERT 和 UPDATE（流式逐字更新）
  const handleMessage = (payload: any) => {
    const newMsg = payload.new as Message;
    // 从 tool_results 提取 reasoning 更新思考横条（与桌面端一致）
    if (newMsg.tool_results) {
      try {
        const tr = JSON.parse(newMsg.tool_results);
        if (tr.reasoning) setLiveReasoning(tr.reasoning);
      } catch { /* ignore */ }
    }
    // 消息已存在 → 替换内容（流式更新）
    setMessages((prev) => {
      const existing = prev.findIndex(m => m.id === newMsg.id);
      if (existing !== -1) {
        const next = [...prev];
        next[existing] = newMsg;
        return next;
      }
      // 新消息 → 去重后添加
      if (seenMsgIdsRef.current.has(newMsg.id)) return prev;
      seenMsgIdsRef.current.add(newMsg.id);
      if (newMsg.role === 'user') {
        // 替换本地乐观 temp 消息
        const tempIdx = prev.findIndex(m => m.id.startsWith('temp-'));
        if (tempIdx !== -1) {
          const next = [...prev];
          next[tempIdx] = newMsg;
          return next;
        }
        return prev;
      }
      return [...prev, newMsg];
    });
    // 收到助手回复后取消发送状态
    if (newMsg.role === 'assistant') {
      setSending(false);
      assistantReceivedRef.current = true;
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    // 重置超时标记，确保新消息的超时能正常触发
    assistantReceivedRef.current = false;

    // 构建消息内容：文字 + 图片 + 文件
    let content = text;
    if (imageAttachments.length > 0) {
      content += '\n\n' + imageAttachments.map(url => `![image](${url})`).join('\n');
      setImageAttachments([]);
    }
    if (fileAttachments.length > 0) {
      content += '\n\n' + fileAttachments.map(f => `[上传文件: ${f.name}](${f.dataUrl})`).join('\n');
      setFileAttachments([]);
    }

    // 乐观添加用户消息
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [...prev, {
      id: tempId, role: 'user', content: text, created_at: new Date().toISOString(),
    }]);

    // 建立 Realtime 订阅（在发送前就建立，避免漏掉消息）
    setupRealtime();

    // 关键修复：带上固定的 conversationId，保证所有指令进入同一个远程对话
    // P1-16 修复：附加 mode/level 前缀，与 MessageView 协议一致，保证桌面端正确解析
    const contentWithMeta = `[mode=${mode}][level=${permissionLevel}] ${content}`.trim();
    const ok = await sendCommand(contentWithMeta, remoteConvIdRef.current);
    if (!ok) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setSending(false);
    }

    // 30秒超时兜底（防止 AI 挂了导致一直 loading）
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (assistantReceivedRef.current) return; // 已收到回复，不显示超时消息
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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        // 图片：读取为 data URL，直接嵌入消息
        const reader = new FileReader();
        reader.onload = () => setImageAttachments(prev => [...prev, reader.result as string]);
        reader.readAsDataURL(file);
      } else if (file.type.startsWith('text/') || file.name.match(/\.(py|js|ts|tsx|jsx|html|css|json|md|txt|xml|yaml|yml|sh|bat|ps1|env|gitignore|sql|rb|go|rs|c|cpp|h|hpp|java|kt|swift|php|pl|pm|r|m|mm|vue|svelte|astro)$/i)) {
        // 文本文件：读取为文本，附上文件名
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result as string;
          const fileBlock = `\n\n---\n**文件: ${file.name}**\n\`\`\`${file.name.split('.').pop() || ''}\n${text}\n\`\`\`\n`;
          setInput(prev => prev ? prev + fileBlock : fileBlock);
        };
        reader.readAsText(file);
      } else {
        // 其他文件：读取为 data URL，作为附件发送（桌面端会自动保存到 chat-files/）
        const reader = new FileReader();
        reader.onload = () => {
          setFileAttachments(prev => [...prev, { name: file.name, dataUrl: reader.result as string }]);
        };
        reader.readAsDataURL(file);
      }
    }
    e.target.value = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="app-layout new-command-page">
      <div className="chat-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <h2>新指令</h2>
      </div>

      {/* 模式/Level 控制栏（对齐 MessageView） */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)',
        borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
        background: 'rgba(10,10,15,0.6)', backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={() => setMode('normal')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'normal' ? 'rgba(94,158,255,0.3)' : 'transparent'}`, background: mode === 'normal' ? 'rgba(94,158,255,0.12)' : 'var(--bg-card)', color: mode === 'normal' ? '#5e9eff' : 'var(--text-secondary)', cursor: 'pointer' }}>
            ⊥ 普通
          </button>
          <button onClick={() => setMode('super')}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${mode === 'super' ? 'rgba(167,139,250,0.3)' : 'transparent'}`, background: mode === 'super' ? 'rgba(167,139,250,0.12)' : 'var(--bg-card)', color: mode === 'super' ? '#a78bfa' : 'var(--text-secondary)', cursor: 'pointer' }}>
            ⊥ 超级
          </button>
          <span style={{ color: 'var(--border)' }}>|</span>
          <button onClick={() => setPermissionLevel(l => l >= 3 ? 1 : l + 1)}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, border: `1px solid ${permissionLevel === 3 ? 'rgba(239,68,68,0.3)' : permissionLevel === 2 ? 'rgba(52,211,153,0.3)' : 'rgba(245,158,11,0.3)'}`, background: permissionLevel === 3 ? 'rgba(239,68,68,0.12)' : permissionLevel === 2 ? 'rgba(52,211,153,0.12)' : 'rgba(245,158,11,0.12)', color: permissionLevel === 3 ? '#ef4444' : permissionLevel === 2 ? '#34d399' : '#f59e0b', cursor: 'pointer' }}>
            {permissionLevel === 3 ? '🔴 Level 3' : permissionLevel === 2 ? '🔓 Level 2' : '🔒 Level 1'}
          </button>
        </div>
      </div>

      <div className="message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="new-command-hint">
            <div className="hint-icon">📡</div>
            <div>输入指令后发送到桌面端 Aether</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>
              桌面端会自动处理并回复
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === 'user';
            const hasCode = msg.content.includes('```');
            return (
              <div key={msg.id} className={`message ${isUser ? 'user' : 'assistant'}`}>
                {hasCode ? (
                  <div style={{ marginTop: 4 }}>{renderMarkdown(msg.content)}</div>
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{renderMarkdown(msg.content)}</div>
                )}
                <div className="message-time">{new Date(msg.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            );
          })
        )}
        {sending && (
          <div className="message assistant" style={{ alignSelf: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="spinner" style={{ width: 16, height: 16, margin: 0 }} />
              正在处理...
            </div>
          </div>
        )}
      </div>

      {/* 思考过程横条（与桌面端对齐：输入框上方） */}
      <div className="reasoning-bar" style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        margin: '4px 12px 2px', padding: '6px 10px',
        borderRadius: 12, maxHeight: 100,
        background: 'rgba(167,139,250,0.08)',
        border: '1px solid rgba(167,139,250,0.18)',
        backdropFilter: 'blur(12px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(12px) saturate(1.4)',
      }}>
        <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>🧠</span>
        <div style={{
          flex: 1, fontSize: 12, lineHeight: 1.6,
          color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap', maxHeight: 86,
          overflowY: 'auto',
        }}>{liveReasoning}</div>
      </div>

      <div className="command-input-area">
        {/* 附件预览 */}
        {imageAttachments.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4, width: '100%' }}>
            {imageAttachments.map((url, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={url} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} />
                <button onClick={() => setImageAttachments(prev => prev.filter((_, idx) => idx !== i))}
                  style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: '50%', background: 'var(--danger)', color: '#fff', border: 'none', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {fileAttachments.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4, width: '100%' }}>
            {fileAttachments.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, background: 'var(--bg-hover)', border: '1px solid var(--border)', fontSize: 12 }}>
                <span>📄</span>
                <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button onClick={() => setFileAttachments(prev => prev.filter((_, idx) => idx !== i))}
                  style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 10, padding: 2 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        <button onClick={() => fileInputRef.current?.click()}
          style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title="上传文件">
          📎
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
          disabled={(!input.trim() && imageAttachments.length === 0 && fileAttachments.length === 0) || sending}
        >
          {sending ? '⋯' : '↑'}
        </button>
      </div>
    </div>
  );
}