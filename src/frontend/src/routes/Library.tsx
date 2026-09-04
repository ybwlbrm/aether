import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api/client';
import { Database, Image, Film, FileText, Trash2, Eye, Edit3, X, CheckSquare, Square } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';

export function Library() {
  const [media, setMedia] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [viewing, setViewing] = useState<any | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  // P1-13: 三态 — loading / error / data
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 批量删除：选择模式 + 已选 ids
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const loadData = () => {
    setLoading(true);
    setError(null);
    Promise.all([api.getMedia(), api.getDocuments()])
      .then(([m, d]) => { setMedia(m); setDocuments(d); })
      .catch((e) => setError((e instanceof Error ? e.message : String(e)) || '加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleDeleteMedia = async (id: string) => {
    if (!(await confirmDialog('确定删除此媒体文件？此操作不可撤销。'))) return;
    try { await api.deleteMedia(id); setMedia(prev => prev.filter(m => m.id !== id)); } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); }
  };
  const handleDeleteDoc = async (id: string) => {
    if (!(await confirmDialog('确定删除此文档？此操作不可撤销。'))) return;
    try { await api.deleteDocument(id); setDocuments(prev => prev.filter(d => d.id !== id)); } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  // 批量删除：切换选择模式（退出时清空已选）
  const toggleSelectionMode = () => {
    setSelectionMode(prev => { if (prev) setSelectedIds(new Set()); return !prev; });
  };
  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedIds(prev => {
      const mediaIds = media.map(m => m.id);
      const allSelected = mediaIds.length > 0 && mediaIds.every(id => prev.has(id));
      return allSelected ? new Set() : new Set(mediaIds);
    });
  };
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!(await confirmDialog(`确定删除选中的 ${selectedIds.size} 个媒体文件？此操作不可撤销。`))) return;
    try {
      await api.batchDeleteMedia([...selectedIds]);
      setSelectedIds(new Set());
      loadData(); // 删除后刷新列表
    } catch (e: unknown) { alert('批量删除失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  const handleRename = async (item: any) => {
    if (!newName.trim()) return;
    try {
      if (item.type === 'media') {
        await api.updateMedia(item.id, { name: newName });
      } else {
        await api.updateDocument(item.id, { name: newName });
      }
      setRenaming(null); setNewName(''); api.getMedia().then(setMedia).catch(() => {}); api.getDocuments().then(setDocuments).catch(() => {});
    } catch (e: unknown) { alert('重命名失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  const allItems = [
    ...media.map((m: any) => ({
      id: m.id, type: 'media', name: m.name, subtype: m.type, date: m.createdAt, content: JSON.stringify(m.metadata || {}),
      icon: m.type === 'video' ? <Film size={18} /> : <Image size={18} />,
      color: m.type === 'video' ? 'var(--color-warning)' : '#a78bfa',
      onDelete: () => handleDeleteMedia(m.id),
      onView: () => setViewing(m),
    })),
    ...documents.map((d: any) => ({
      id: d.id, type: 'document', name: d.name, subtype: d.type, date: d.createdAt, content: d.path || '',
      icon: <FileText size={18} />,
      color: 'var(--color-success)',
      onDelete: () => handleDeleteDoc(d.id),
      onView: () => setViewing(d),
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
      <PageHeader title="Library" description="Generated media, documents, and more" icon={<Database size={22} />} color="#60a5fa" />

      <div className="grid grid-cols-3 gap-6" style={{ marginBottom: '32px' }}>
        {[
          { icon: <Image size={24} />, label: 'Images', count: media.filter(m => m.type === 'image').length, color: '#a78bfa' },
          { icon: <Film size={24} />, label: 'Videos', count: media.filter(m => m.type === 'video').length, color: 'var(--color-warning)' },
          { icon: <FileText size={24} />, label: 'Documents', count: documents.length, color: 'var(--color-success)' },
        ].map((cat, i) => (
          <div key={cat.label} style={{ height: 'var(--card-height)', padding: '20px', borderRadius: 'var(--card-radius)', background: 'var(--card-bg)', backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))', WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))', border: '1px solid var(--card-border)', boxShadow: 'var(--card-shadow)' }}
            className="flex items-center gap-4">
            <div className="flex items-center justify-center flex-shrink-0" style={{ width: 40, height: 40, borderRadius: 8, background: `${cat.color}18` }}>
              <span style={{ color: cat.color }}>{cat.icon}</span>
            </div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)' }}>{cat.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 2 }}>{cat.count} items</div>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-card">
        <div className="flex items-center justify-between" style={{ marginBottom: '20px' }}>
          <h2 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)' }}>All Items</h2>
          <div className="flex items-center gap-2">
            {selectionMode && media.length > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={toggleAll}
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                title={selectedIds.size > 0 ? '取消全选' : '全选'}>
                {media.every(m => selectedIds.has(m.id)) ? <Square size={14} /> : <CheckSquare size={14} />}
                {media.every(m => selectedIds.has(m.id)) ? '取消全选' : '全选'}
              </button>
            )}
            {selectionMode && selectedIds.size > 0 && (
              <button onClick={handleBatchDelete}
                className="btn btn-sm"
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, color: '#fff', background: '#dc2626', border: '1px solid #dc2626' }}
                title="批量删除">
                <Trash2 size={14} /> 删除 ({selectedIds.size})
              </button>
            )}
            <button className={`btn ${selectionMode ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={toggleSelectionMode}
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {selectionMode ? <Square size={14} /> : <CheckSquare size={14} />}
              {selectionMode ? '退出选择' : '选择模式'}
            </button>
          </div>
        </div>
        {loading ? (
          // P1-13: Loading Skeleton
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ height: 'var(--card-height)', borderRadius: 12, background: 'rgba(255,255,255,0.04)' }} className="animate-pulse" />
            ))}
          </div>
        ) : error ? (
          // P1-13: Error State + Retry
          <div className="empty-state">
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
            <div className="empty-state-title">{error}</div>
            <button className="btn btn-primary mt-3" onClick={loadData}>重试</button>
          </div>
        ) : allItems.length === 0 ? (
          <div className="empty-state">
            <Database size={36} className="empty-state-icon" />
            <div className="empty-state-title">No items in library yet</div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {allItems.map((item, i) => (
              <motion.div
                key={item.id}
                className="flex flex-col justify-between min-w-0"
                style={{
                  height: 'var(--card-height)', padding: '16px', borderRadius: '12px',
                  background: 'var(--card-bg)',
                  backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
                  WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
                  border: '1px solid var(--card-border)',
                  boxShadow: 'var(--card-shadow)',
                  position: 'relative',
                }}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.4 }}
                whileHover={{ y: -2, transition: { duration: 0.2 } }}
              >
                <div className="flex items-start gap-3 min-w-0">
                  {selectionMode && item.type === 'media' && (
                    <button
                      onClick={() => toggleSelection(item.id)}
                      className="flex items-center justify-center flex-shrink-0 w-6 h-6 rounded-lg hover:bg-white/[0.06]"
                      style={{ color: selectedIds.has(item.id) ? 'var(--color-accent, #60a5fa)' : 'var(--text-tertiary)' }}
                      title={selectedIds.has(item.id) ? '取消选择' : '选择'}
                    >
                      {selectedIds.has(item.id) ? <CheckSquare size={16} /> : <Square size={16} />}
                    </button>
                  )}
                  <div className="flex items-center justify-center flex-shrink-0" style={{ width: 36, height: 36, borderRadius: 10, background: `${item.color}18` }}>
                    <span style={{ color: item.color, opacity: 0.9 }}>{item.icon}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    {renaming === item.id ? (
                      <input
                        className="input"
                        style={{ height: 30, fontSize: 12, padding: '0 10px' }}
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !(e.nativeEvent as any).isComposing && handleRename(item)}
                        autoFocus
                      />
                    ) : (
                      <div className="truncate" title={item.name} style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={item.onView} className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} title="查看">
                      <Eye size={14} />
                    </button>
                    <button onClick={() => { setRenaming(item.id); setNewName(item.name); }} className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} title="重命名">
                      <Edit3 size={14} />
                    </button>
                    <button onClick={item.onDelete} className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} title="删除">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="tag flex-shrink-0">{item.subtype}</span>
                  <span className="truncate" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{new Date(item.date).toLocaleString()}</span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* View Modal */}
      {viewing && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md" onClick={() => setViewing(null)} />
          <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
            <div className="glass-card pointer-events-auto" style={{
              maxWidth: '48rem', width: '100%', margin: '0 1rem', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
              clipPath: 'none',
            }}>
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{viewing.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}>{viewing.subtype?.toUpperCase()}</span>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{new Date(viewing.date).toLocaleString()}</span>
                  </div>
                </div>
                <button className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} onClick={() => setViewing(null)}><X size={14} /></button>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {/* media 图片预览：viewing 是后端 media 对象，subtype 即 m.type (image/video) */}
                {viewing.subtype === 'image' && viewing.url && (
                  <div className="rounded-[14px] overflow-hidden mb-4" style={{ background: '#000', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 240 }}>
                    <img src={viewing.url} alt={viewing.name} style={{ maxWidth: '100%', maxHeight: '50vh', objectFit: 'contain' }} />
                  </div>
                )}
                {viewing.subtype === 'video' && viewing.url && (
                  <div className="rounded-[14px] overflow-hidden mb-4" style={{ background: '#000' }}>
                    <video src={viewing.url} controls style={{ width: '100%', maxHeight: '50vh' }} />
                  </div>
                )}

                {/* 文档类型（有 path 无 url 就是文档）：根据文件扩展名判断是否可预览 */}
                {!viewing.url && viewing.path && (() => {
                  const name = (viewing.name || '').toLowerCase();
                  const isImageExt = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(name);
                  const isVideoExt = /\.(mp4|webm|ogg|mov|avi)$/i.test(name);
                  const docUrl = `/api/documents/${viewing.id}/download`;
                  if (isImageExt) {
                    return (
                      <div className="rounded-[14px] overflow-hidden mb-4" style={{ background: '#000', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 240 }}>
                        <img src={docUrl} alt={viewing.name} style={{ maxWidth: '100%', maxHeight: '50vh', objectFit: 'contain' }} />
                      </div>
                    );
                  }
                  if (isVideoExt) {
                    return (
                      <div className="rounded-[14px] overflow-hidden mb-4" style={{ background: '#000' }}>
                        <video src={docUrl} controls style={{ width: '100%', maxHeight: '50vh' }} />
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* 详情说明 */}
                <div className="rounded-[14px] p-4" style={{ background: 'var(--input-bg)' }}>
                  {viewing.subtype && viewing.subtype !== 'image' && viewing.subtype !== 'video' && (
                    <p className="text-xs mb-2" style={{ color: 'var(--text-tertiary)' }}>Type: {viewing.subtype?.toUpperCase()}</p>
                  )}
                  {viewing.content && (
                    <div>
                      <pre className="mt-2 text-xs p-3 rounded-lg" style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', background: 'var(--bg-surface)' }}>{viewing.content}</pre>
                      {!viewing.url && viewing.path && viewing.id && (
                        <a href={`/api/documents/${viewing.id}/download`} target="_blank" rel="noopener noreferrer"
                          className="btn btn-primary mt-3" style={{ display: 'inline-flex', fontSize: 13 }}>
                          <FileText size={14} /> 下载文件
                        </a>
                      )}
                    </div>
                  )}
                  {!viewing.content && (
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>该文件暂无更多详情。</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
    </div>
  );
}