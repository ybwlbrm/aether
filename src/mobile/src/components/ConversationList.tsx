import { useState, useEffect, useCallback } from 'react';
import {
  getConversations,
  subscribeConversations,
  deleteConversation,
  getMessages,
  getSyncState,
  onSyncStateChange,
  type SyncState,
} from '../api/supabase';
import { type ChatMessage } from '../lib/message-store';
import { User, Search, Trash2, MessageSquare, Plus, ChevronRight, PlayCircle, RefreshCw } from 'lucide-react';

interface Conversation {
  id: string;
  title: string;
  model?: string;
  message_count?: number;
  updated_at: string;
  created_at: string;
}

interface Props {
  onSelect: (conv: Conversation) => void;
  onNewCommand: () => void;
  variant?: 'home' | 'conversations';
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

// §24：列表加载状态
type ListPhase = 'loading' | 'success' | 'empty' | 'error';

const PREVIEW_ROWS_LIMIT = 10;

export default function ConversationList({ onSelect, onNewCommand, variant = 'home' }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [phase, setPhase] = useState<ListPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [sync, setSync] = useState<SyncState>(() => getSyncState());
  useEffect(() => onSyncStateChange(setSync), []);

  const [activePreview, setActivePreview] = useState('');
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await getConversations({ limit: 50 });
      if (res.error) {
        setPhase('error');
        setLoadError(res.error.message);
        return;
      }
      const data = (res.data ?? []) as Conversation[];
      setConversations(data);
      setPhase(data.length > 0 ? 'success' : 'empty');
      setLoadError(null);
    } catch (e) {
      setPhase('error');
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = subscribeConversations((payload) => {
      if (payload?.eventType === 'DELETE') {
        const deletedId = payload.old?.id;
        if (typeof deletedId === 'string') {
          setConversations((prev) => prev.filter((c) => c.id !== deletedId));
        }
        return;
      }
      load();
    });
    return unsub;
  }, [load]);

  // 「继续工作」：最近 30 分钟有更新的对话
  const activeConv = conversations.find((c) =>
    Date.now() - new Date(c.updated_at).getTime() < 30 * 60 * 1000
  );

  useEffect(() => {
    if (!activeConv) {
      setActivePreview('');
      return;
    }
    let cancelled = false;
    getMessages(activeConv.id, { limit: 50 }).then((res) => {
      if (cancelled || res.error) return;
      const msgs = (res.data ?? []) as ChatMessage[];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      const content = last?.content?.replace(/```[\s\S]*?```/g, '代码块').slice(0, 40) ?? '';
      setActivePreview(content);
    });
    return () => { cancelled = true; };
  }, [activeConv?.id]);

  // 最近对话预览：仅对可见列表前 N 条惰性加载最后一条 assistant 消息
  useEffect(() => {
    const visible = conversations.slice(0, PREVIEW_ROWS_LIMIT);
    const targets = visible.filter((c) => !(c.id in previews) && c.message_count != null);
    if (targets.length === 0) return;
    let cancelled = false;
    Promise.all(
      targets.map(async (c) => {
        try {
          const res = await getMessages(c.id, { limit: 20 });
          if (cancelled || res.error) return null;
          const msgs = (res.data ?? []) as ChatMessage[];
          const last = [...msgs].reverse().find((m) => m.role === 'assistant');
          const preview = last?.content?.replace(/```[\s\S]*?```/g, '代码块').slice(0, 42) ?? '';
          return { id: c.id, preview };
        } catch { return null; }
      }),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const r of results) {
        if (r && r.preview) next[r.id] = r.preview;
      }
      if (Object.keys(next).length > 0) {
        setPreviews((prev) => ({ ...prev, ...next }));
      }
    });
    return () => { cancelled = true; };
  }, [conversations]);

  const filtered = searchQuery.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : conversations;

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const handleDelete = async (e: React.MouseEvent, convId: string, convTitle: string) => {
    e.stopPropagation();
    if (!window.confirm(`确定删除「${convTitle}」？\n此操作不可恢复。`)) return;
    // §32：本地立即反馈，失败恢复行 + 错误提示
    const prev = conversations;
    setConversations((p) => p.filter((c) => c.id !== convId));
    const ok = await deleteConversation(convId);
    if (!ok) {
      setConversations(prev);
      setLoadError('删除失败，请重试');
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} 小时前`;
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  const online = sync.status === 'connected';
  const lastSyncLabel = sync.lastSyncAt ? formatClock(sync.lastSyncAt) : '—';
  const isHome = variant === 'home';

  const searchNoResult = searchQuery.trim() !== '' && filtered.length === 0 && phase === 'success';

  if (phase === 'loading') {
    return (
      <div className="home-page fade-in">
        <header className="home-header">
          <h1 className="home-title">Aether</h1>
          <div className="home-avatar" aria-label="用户"><User size={18} /></div>
        </header>
        <div className="loading"><div className="spinner" />加载中...</div>
      </div>
    );
  }
  return (
    <div className="home-page fade-in">
      {/* 顶栏 */}
      <header className="home-header">
        <h1 className="home-title">Aether</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing} aria-label="刷新">
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          </button>
          <div className="home-avatar" aria-label="用户"><User size={18} /></div>
        </div>
      </header>

      {isHome && phase === 'success' && (
        <>
          {/* 轻状态区 */}
          <div className="home-status">
            <span className={`home-status-dot ${online ? 'online' : ''}`} aria-hidden="true" />
            <span className="home-status-name">{online ? '在线' : '未连接'}</span>
            <span className="home-status-divider">·</span>
            <span className="home-status-name">Aether 工作站</span>
            <span className="home-status-sub">最近同步 {lastSyncLabel}</span>
          </div>

          {/* 继续工作 — 轻 continuation row */}
          {activeConv && (
            <div className="continue-section">
              <div className="section-label" style={{ padding: 0, paddingBottom: 4 }}>继续工作</div>
              <div
                className="continue-row"
                onClick={() => onSelect(activeConv)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && onSelect(activeConv)}
              >
                <div className="continue-row-mark"><PlayCircle size={20} /></div>
                <div className="continue-row-main">
                  <div className="continue-row-title">{activeConv.title}</div>
                  {activePreview && <div className="continue-row-preview">继续：{activePreview}</div>}
                </div>
                <ChevronRight size={16} className="continue-chevron" />
              </div>
            </div>
          )}
        </>
      )}

      {/* 最近对话 */}
      <div className="section-label">最近对话</div>

      <div className="search-field">
        <Search size={17} className="search-field-icon" aria-hidden="true" />
        <input
          className="search-field-input"
          type="text"
          placeholder="搜索对话"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="conv-list">
        {phase === 'error' ? (
          <div className="empty-state">
            <h3 className="empty-state-title">加载失败</h3>
            <p className="empty-state-desc">{loadError || '无法获取对话列表'}</p>
            <button className="btn-ghost" onClick={load} style={{ marginTop: 16 }}>点击重试</button>
          </div>
        ) : searchNoResult ? (
          <div className="empty-state">
            <h3 className="empty-state-title">无搜索结果</h3>
            <p className="empty-state-desc">没有找到匹配的对话</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><MessageSquare size={26} /></div>
            <h3 className="empty-state-title">暂无对话</h3>
            <p className="empty-state-desc">桌面端 Aether 的对话记录将自动同步到这里</p>
            <button className="btn-primary" onClick={onNewCommand} style={{ marginTop: 18, width: 'auto', padding: '0 28px' }}>
              发送新指令
            </button>
          </div>
        ) : (
          filtered.map((conv) => (
            <div key={conv.id} className="conv-row" onClick={() => onSelect(conv)}>
              <div className="conv-main">
                <div className="conv-title">{conv.title}</div>
                <div className="conv-preview">
                  {previews[conv.id] ?? (conv.message_count != null ? `${conv.message_count} 条消息` : (conv.model || 'AI'))}
                </div>
              </div>
              <span className="conv-time">{formatTime(conv.updated_at)}</span>
              <button
                className="conv-delete"
                onClick={(e) => handleDelete(e, conv.id, conv.title)}
                aria-label={`删除 ${conv.title}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      <button className="new-command-cta" onClick={onNewCommand} type="button">
        <Plus size={18} aria-hidden="true" />
        告诉 Aether 下一步…
      </button>
    </div>
  );
}
