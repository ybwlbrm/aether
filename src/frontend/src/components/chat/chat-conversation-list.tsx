/**
 * Chat 的差异化会话列表（可折叠 + 内联新建/重命名/删除）。
 *
 * 只有 Chat 的会话列表是页面内联的（Layout 侧栏不持有它），因此它留在 Chat 私有目录；
 * 列表的**数据**由 useConversations 拥有，本组件纯展示与转发。
 */
import { AnimatePresence, motion } from 'framer-motion';
import { Edit3, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from 'lucide-react';
import { EmptyState, Panel } from '../ui';
import type { Conversation } from '../../hooks/useConversations';

export interface ChatConversationListProps {
  readonly conversations: Conversation[];
  readonly loading: boolean;
  readonly collapsed: boolean;
  readonly activeId: string | null;
  readonly onToggleCollapsed: () => void;
  readonly onNew: () => void;
  readonly onSelect: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onRename: (id: string, title: string) => void;
}

export function ChatConversationList({
  conversations, loading, collapsed, activeId, onToggleCollapsed, onNew, onSelect, onDelete, onRename,
}: ChatConversationListProps) {
  if (collapsed) {
    return (
      <motion.div className="flex-shrink-0 flex flex-col items-center pt-2"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
        <div style={{ padding: 8, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={onToggleCollapsed} className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-white/[0.08]" style={{ color: 'var(--text-tertiary)' }} title="展开对话列表" aria-label="展开对话列表">
            <PanelLeftOpen size={18} />
          </button>
          <button onClick={onNew} className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-white/[0.08]" style={{ color: 'var(--color-accent)' }} title="新建对话" aria-label="新建对话">
            <Plus size={18} />
          </button>
          <div className="text-center" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{conversations.length}</div>
        </div>
      </motion.div>
    );
  }

  return (
    <AnimatePresence initial={false}>
      <motion.div key="conv-list" className="w-72 flex-shrink-0 flex flex-col min-h-0"
        initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: 288 }} exit={{ opacity: 0, width: 0 }} transition={{ duration: 0.2 }}>
        <Panel tone="subtle" className="flex min-h-0 flex-1 flex-col p-0!">
          <div className="flex min-h-0 flex-1 flex-col p-3!">
            <div className="flex items-center justify-between" style={{ padding: '8px 8px 12px' }}>
              <span style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>对话列表</span>
              <div className="flex items-center gap-1">
                <button className="btn btn-primary" onClick={onNew} title="新建对话" style={{ width: 44, padding: 0 }} aria-label="新建对话">
                  <Plus size={18} />
                </button>
                <button onClick={onToggleCollapsed} className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.08]"
                  style={{ color: 'var(--text-tertiary)' }} title="收起" aria-label="收起对话列表"><PanelLeftClose size={16} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {conversations.map((conv, i) => (
                <motion.div
                  key={conv.id}
                  onClick={() => onSelect(conv.id)}
                  className="cursor-pointer group"
                  style={{ padding: 12, borderRadius: 8, background: activeId === conv.id ? 'var(--card-hover-bg)' : 'transparent', border: 'none' }}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.4 }}
                  whileHover={{ y: -1, transition: { duration: 0.2 } }}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center flex-shrink-0" style={{ width: 34, height: 34, borderRadius: 10, background: activeId === conv.id ? 'rgba(94, 158, 255, 0.18)' : 'var(--bg-surface)' }}>
                      <MessageSquare size={15} style={{ color: activeId === conv.id ? 'var(--color-accent)' : 'var(--text-secondary)' }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate" title={conv.title} style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{conv.title}</div>
                      <div className="mt-1 truncate" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {new Date(conv.updatedAt).toLocaleString()}
                        {typeof conv.tokenTotal === 'number' && conv.tokenTotal > 0 && ` · ⚡ ${conv.tokenTotal.toLocaleString()} tokens`}
                      </div>
                    </div>
                    <button
                      className="flex items-center justify-center w-8 h-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/[0.08] flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = prompt('重命名对话:', conv.title);
                        if (next && next.trim() && next.trim() !== conv.title) onRename(conv.id, next.trim());
                      }}
                      title="重命名对话" aria-label="重命名对话" style={{ color: 'var(--text-tertiary)' }}
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      className="flex items-center justify-center w-8 h-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/[0.08] flex-shrink-0"
                      onClick={(e) => { e.stopPropagation(); onDelete(conv.id); }}
                      title="删除对话" aria-label="删除对话" style={{ color: 'var(--text-tertiary)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </motion.div>
              ))}
              {loading && conversations.length === 0 && (
                <div className="empty-state">
                  <div className="spinner" style={{ width: 20, height: 20, margin: '0 auto 8px' }} />
                  <div className="empty-state-title" style={{ fontSize: 13 }}>加载中...</div>
                </div>
              )}
              {!loading && conversations.length === 0 && (
                <EmptyState icon={<MessageSquare size={28} />} title="暂无对话" className="border-0 bg-transparent p-4! shadow-none" />
              )}
            </div>
          </div>
        </Panel>
      </motion.div>
    </AnimatePresence>
  );
}
