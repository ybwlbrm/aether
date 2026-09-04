import { useState } from 'react';
import { motion } from 'framer-motion';
import { Link2, ExternalLink, Trash2, Plus, X, Search, Tag, Upload, Loader2, FolderPlus, Save, Eye, Pencil, Clock } from 'lucide-react';
import { confirm as confirmDialog } from '../../components/ui/confirm-dialog';
import { api } from '../../api/client';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import type { Bookmark, Note, WikiPage } from './types';
import { tabs, memoryTypeStyles, memoryFilters } from './constants';

interface BookmarksTabProps {
  bookmarks: Bookmark[];
  setBookmarks: React.Dispatch<React.SetStateAction<Bookmark[]>>;
  searchQuery: string;
  newBookmark: { title: string; url: string; tags: string };
  setNewBookmark: React.Dispatch<React.SetStateAction<{ title: string; url: string; tags: string }>>;
  fileImportRef: React.RefObject<HTMLInputElement>;
  importing: boolean;
  handleImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function BookmarksTab({
  bookmarks, setBookmarks, searchQuery, newBookmark, setNewBookmark,
  fileImportRef, importing, handleImport
}: BookmarksTabProps) {
  const filteredBookmarks = bookmarks.filter(b =>
    b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    b.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const addBookmark = () => {
    if (!newBookmark.url) return;
    const bookmark: Bookmark = {
      id: Date.now().toString(),
      title: newBookmark.title || newBookmark.url,
      url: newBookmark.url,
      tags: newBookmark.tags.split(',').map(t => t.trim()).filter(Boolean),
      summary: '',
      createdAt: new Date().toISOString(),
    };
    const updated = [bookmark, ...bookmarks];
    setBookmarks(updated);
    localStorage.setItem('knowledge_bookmarks', JSON.stringify(updated));
    setNewBookmark({ title: '', url: '', tags: '' });
  };

  const deleteBookmark = async (id: string) => {
    if (!(await confirmDialog('确定删除此收藏？此操作不可撤销。'))) return;
    const updated = bookmarks.filter(b => b.id !== id);
    setBookmarks(updated);
    localStorage.setItem('knowledge_bookmarks', JSON.stringify(updated));
  };

  return (
    <div className="glass-card" style={{ padding: '24px' }}>
      <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>添加收藏</h3>
      <div className="flex gap-3 mb-4">
        <input className="input flex-1" value={newBookmark.url} onChange={e => setNewBookmark(p => ({ ...p, url: e.target.value }))} placeholder="输入链接 URL..." />
        <input className="input" style={{ flex: 0.5 }} value={newBookmark.tags} onChange={e => setNewBookmark(p => ({ ...p, tags: e.target.value }))} placeholder="标签（逗号分隔）" />
        <button className="btn btn-primary" onClick={addBookmark}><Plus size={18} /> 添加</button>
      </div>

      {filteredBookmarks.length === 0 ? (
        <div className="empty-state py-12">
          <Link2 size={36} className="empty-state-icon" />
          <div className="empty-state-title">{searchQuery ? '未找到匹配的收藏' : '暂无收藏'}</div>
          <div className="empty-state-desc">{searchQuery ? `没有匹配"${searchQuery}"的收藏` : '添加链接开始收藏'}</div>
          {searchQuery && <button className="btn btn-ghost mt-3" onClick={() => {}} style={{ fontSize: '13px' }}>清除搜索</button>}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredBookmarks.map(b => (
            <motion.div key={b.id} className="rounded-[14px] p-4" style={{ background: 'var(--glass-fill)', border: '1px solid var(--border-primary)' }}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <a href={b.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-accent)', textDecoration: 'none' }}>
                    {b.title} <ExternalLink size={12} style={{ display: 'inline' }} />
                  </a>
                  <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 2 }}>{b.url}</p>
                  {b.tags.length > 0 && (
                    <div className="flex gap-1 mt-2">
                      {b.tags.map(tag => (
                        <span key={tag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(94,158,255,0.12)', color: 'var(--color-accent)' }}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <button onClick={() => deleteBookmark(b.id)} style={{ color: 'var(--text-tertiary)', cursor: 'pointer', background: 'none', border: 'none', padding: 4 }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}