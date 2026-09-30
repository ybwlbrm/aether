import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { api, authHeaders } from '../../api/client';
import { dispatchAppEvent, subscribeAppEvent } from '../../lib/events';
import { confirm as confirmDialog } from '../ui/confirm-dialog';
import { ErrorState } from '../ui/error-state';

/**
 * ConversationsDrawer — 会话记录抽屉（T20，从旧 Layout L122-332 原样迁出）。
 *
 * 全局常驻：开关由 'toggle-conv-panel' 事件驱动（T19 由 Sidebar 派发）。
 * 会话选中走 'select-conversation' 事件契约（lib/events），页面据此加载。
 */

/** 抽屉宽度（px） */
const DRAWER_WIDTH = 260;
/** 关闭按钮命中区（px） */
const CLOSE_BTN_SIZE = 28;

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** 删除失败提示（关闭抽屉或再次操作时随状态复位） */
interface DeleteFailure {
  id: string;
  message: string;
}

export function ConversationsDrawer() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [deleteFailure, setDeleteFailure] = useState<DeleteFailure | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const convs = await api.getConversations();
      setConversations(convs || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // 会话列表变更 → 刷新
  useEffect(() => subscribeAppEvent('conversations-changed', () => { void loadConversations(); }), [loadConversations]);

  const handleSelectConv = useCallback(async (id: string) => {
    setOpen(false);
    setDeleteFailure(null);
    const path = window.location.pathname;
    if (path === '/command-center' || path === '/') {
      dispatchAppEvent('select-conversation', { conversationId: id });
    } else {
      navigate(`/command-center?selectConv=${id}`);
    }
  }, [navigate]);

  const handleDeleteConv = useCallback(async (id: string) => {
    if (!(await confirmDialog('确定删除此对话？'))) return;
    try {
      await api.deleteConversation(id);
      await fetch('/api/sync/delete-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...authHeaders() },
        body: JSON.stringify({ conversationId: id }),
      }).catch(() => {});
      setDeleteFailure(null);
      loadConversations();
    } catch (e: unknown) {
      setDeleteFailure({
        id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [loadConversations]);

  // 开关抽屉（T19 派发）
  useEffect(() => subscribeAppEvent('toggle-conv-panel', () => setOpen((prev) => !prev)), []);

  const closeButtonStyle = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-tertiary)',
    padding: 6,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: CLOSE_BTN_SIZE,
    minHeight: CLOSE_BTN_SIZE,
    fontSize: 16,
    lineHeight: 1,
  } as const;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-slot="conversations-drawer"
          initial={{ x: -DRAWER_WIDTH - 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -DRAWER_WIDTH - 40, opacity: 0 }}
          transition={{ duration: 0.2 }}
          style={{
            position: 'fixed',
            left: 'var(--sidebar-width)',
            top: 36,
            bottom: 0,
            width: DRAWER_WIDTH,
            // T6a：脱离刻度，走 tokens.css 的 --z-* 量表（sticky 层）。
            zIndex: 'var(--z-sticky)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-elevated)',
            borderRight: '1px solid var(--border-primary)',
            borderRadius: 0,
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--border-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>Chat History</span>
            <button onClick={() => setOpen(false)} aria-label="Close" style={closeButtonStyle}>
              ✕
            </button>
          </div>

          {/* 删除失败：内联 error-state（替代旧版裸 alert） */}
          {deleteFailure && (
            <div style={{ padding: 8 }}>
              <ErrorState
                title="删除失败"
                description={deleteFailure.message}
                action={
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setDeleteFailure(null)}
                  >
                    知道了
                  </button>
                }
              />
            </div>
          )}

          <div
            style={{
              overflowY: 'auto',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              padding: 8,
            }}
          >
            {conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => handleSelectConv(conv.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSelectConv(conv.id); }}
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conv.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {new Date(conv.updatedAt).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteConv(conv.id); }}
                  aria-label="Delete conversation"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-tertiary)',
                    flexShrink: 0,
                    padding: 4,
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {conversations.length === 0 && (
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-tertiary)', fontSize: 12 }}>
                No conversations yet
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
