import { useState, useEffect, useCallback } from 'react';
import { getConversations, subscribeConversations, deleteConversation } from '../api/supabase';

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
}

export default function ConversationList({ onSelect, onNewCommand }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

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
    // P0-A06/A21：回调接收完整 payload。
    // DELETE 事件（桌面端删除对话 → 级联删除）→ 本地立即移除，避免重新拉取仍缓存旧行；
    // 其余事件（INSERT/UPDATE）→ 重新加载列表。
    const unsub = subscribeConversations((payload: any) => {
      if (payload?.eventType === 'DELETE') {
        const deletedId = payload.old?.id;
        if (deletedId) {
          setConversations(prev => prev.filter(c => c.id !== deletedId));
        }
        return;
      }
      load();
    });
    return unsub;
  }, [load]);

  const filtered = searchQuery.trim()
    ? conversations.filter(c => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : conversations;

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const handleDelete = async (e: React.MouseEvent, convId: string, convTitle: string) => {
    e.stopPropagation();
    if (!confirm(`确定删除「${convTitle}」？\n此操作不可恢复。`)) return;
    const ok = await deleteConversation(convId);
    if (ok) {
      setConversations(prev => prev.filter(c => c.id !== convId));
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

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        加载中...
      </div>
    );
  }

  return (
    <div className="app-layout">
      <div className="top-bar">
        <h1>Aether</h1>
        <div className="top-bar-actions">
          <span className="badge">{conversations.length} 对话</span>
          <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? '⟳' : '↻'} 刷新
          </button>
        </div>
      </div>

      <div className="conv-list">
        {/* 搜索栏 */}
        <input
          className="search-bar"
          type="text"
          placeholder="🔍 搜索对话..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <h3>暂无对话</h3>
            <p>桌面端 Aether 的对话记录将自动同步到这里</p>
            <div style={{ marginTop: 24 }}>
              <button className="btn-primary" onClick={onNewCommand}>
                发送新指令
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: '8px 4px 4px' }}>
              <button className="btn-primary" onClick={onNewCommand}>
                ✏️ 发送新指令
              </button>
            </div>
            {filtered.map((conv) => (
              <div
                key={conv.id}
                className="conv-item"
                onClick={() => onSelect(conv)}
              >
                <div className="conv-item-title">{conv.title}</div>
                <div className="conv-item-meta">
                  <span>{conv.model || 'AI'}</span>
                  <span>{formatTime(conv.updated_at)}</span>
                </div>
                {conv.message_count != null && (
                  <div className="conv-item-preview">
                    {conv.message_count} 条消息
                  </div>
                )}
                <button
                  onClick={(e) => handleDelete(e, conv.id, conv.title)}
                  style={{
                    position: 'absolute', right: 12, top: 12,
                    background: 'none', border: 'none', color: 'var(--text-secondary)',
                    fontSize: 16, cursor: 'pointer', padding: 4,
                    opacity: 0.5,
                  }}
                  onMouseEnter={e => { (e.target as HTMLElement).style.opacity = '1'; }}
                  onMouseLeave={e => { (e.target as HTMLElement).style.opacity = '0.5'; }}
                  title="删除对话"
                >
                  🗑️
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}