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
import { User, Search, Trash2, MessageSquare, Plus, ChevronRight } from 'lucide-react';

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

export default function ConversationList({ onSelect, onNewCommand, variant = 'home' }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [sync, setSync] = useState<SyncState>(() => getSyncState());
  useEffect(() => onSyncStateChange(setSync), []);

  const [activePreview, setActivePreview] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await getConversations();
      setConversations(data);
    } catch (e) {
      console.error('加载对话列表失败:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = subscribeConversations((payload: any) => {
      if (payload?.eventType === 'DELETE') {
        const deletedId = payload.old?.id;
        if (deletedId) {
          setConversations((prev) => prev.filter((c) => c.id !== deletedId));
        }
        return;
      }
      load();
    });
    return unsub;
  }, [load]);

  const activeConv = conversations.find((c) =>
    Date.now() - new Date(c.updated_at).getTime() < 30 * 60 * 1000
  );

  useEffect(() => {
    if (!activeConv) {
      setActivePreview('');
      return;
    }
    let cancelled = false;
    getMessages(activeConv.id).then((msgs) => {
      if (cancelled) return;
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      const content = last?.content?.replace(/```[\s\S]*?```/g, '代码块').slice(0, 40) ?? '';
      setActivePreview(content);
    });
    return () => {
      cancelled = true;
    };
  }, [activeConv?.id]);

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
    const ok = await deleteConversation(convId);
    if (ok) {
      setConversations((prev) => prev.filter((c) => c.id !== convId));
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

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        加载中...
      </div>
    );
  }

  const isHome = variant === 'home';

  return (
    <div className="home-page fade-in">
      {isHome && (
        <>
          <header className="home-header">
            <h1 className="home-title">Aether</h1>
            <div className="home-avatar" aria-label="用户">
              <User size={20} />
            </div>
          </header>

          <div className="device-status-row">
            <span className={`device-status-dot ${online ? 'online' : ''}`} aria-hidden="true" />
            <span className="device-name">
              Aether 工作站 · {online ? '在线' : '未连接'}
            </span>
          </div>

          <div className="device-card glass-surface">
            <div className="device-card-status">
              {online ? '电脑端在线' : '电脑端未连接'}
            </div>
            <div className="device-card-synced">最近同步 {lastSyncLabel}</div>
          </div>

          {activeConv && (
            <div
              className="continue-card glass-surface"
              onClick={() => onSelect(activeConv)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(activeConv)}
            >
              <div className="continue-title">继续工作</div>
              <div className="continue-preview">
                {activeConv.title}
                {activePreview && <span>· {activePreview}</span>}
                <ChevronRight size={16} className="continue-chevron" />
              </div>
            </div>
          )}
        </>
      )}

      <div className="section-title">最近对话</div>

      <div className="search-field">
        <Search size={18} className="search-field-icon" aria-hidden="true" />
        <input
          className="search-field-input"
          type="text"
          placeholder="搜索对话"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="conv-list">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <MessageSquare size={28} />
            </div>
            <h3 className="empty-state-title">暂无对话</h3>
            <p className="empty-state-desc">
              桌面端 Aether 的对话记录将自动同步到这里
            </p>
            <button className="btn-primary" onClick={onNewCommand} style={{ marginTop: 16, width: 'auto' }}>
              发送新指令
            </button>
          </div>
        ) : (
          filtered.map((conv) => (
            <div
              key={conv.id}
              className="conv-row"
              onClick={() => onSelect(conv)}
            >
              <div className="conv-main">
                <div className="conv-title">{conv.title}</div>
                <div className="conv-sub">
                  {conv.message_count != null
                    ? `${conv.message_count} 条消息`
                    : conv.model || 'AI'}
                </div>
              </div>
              <span className="conv-time">{formatTime(conv.updated_at)}</span>
              <button
                className="conv-delete"
                onClick={(e) => handleDelete(e, conv.id, conv.title)}
                aria-label={`删除 ${conv.title}`}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))
        )}
      </div>

      <button className="new-command-cta" onClick={onNewCommand} type="button">
        <Plus size={20} aria-hidden="true" />
        继续告诉 Aether 下一步…
      </button>
    </div>
  );
}