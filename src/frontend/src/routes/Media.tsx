import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Palette, Plus, Search, RefreshCw, AlertCircle, CheckCircle2, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { api } from '../api/client';
import { MediaForm } from './Media/MediaForm';
import { MediaGallery } from './Media/MediaGallery';
import { MediaPreviewModal } from './Media/MediaPreview';
import { useGeneration } from './Media/useGeneration';
import type { MediaItem } from './Media/shared';

interface ProviderConfig {
  id: string;
  name: string;
  provider: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  models: string[];
  capabilities: string[];
  isDefault: boolean;
}

export function Media() {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewItem, setPreviewItem] = useState<MediaItem | null>(null);
  const [defaultProvs, setDefaultProvs] = useState<Record<string, string>>({});
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const loadMedia = useCallback(async () => {
    setMediaLoading(true);
    setMediaError(null);
    try {
      const data = await api.getMedia();
      setMedia(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      setMediaError(e instanceof Error ? e.message : '加载媒体列表失败');
    } finally {
      setMediaLoading(false);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const provs = await api.getProviders();
      setProviders(Array.isArray(provs) ? provs : []);

      let dp: Record<string, string> = {};
      try {
        dp = await api.getDefaultProviders();
      } catch (e: unknown) {
        // Error handled by useGeneration toast
      }
      setDefaultProvs(dp);
    } catch (_e: unknown) { /* ignore - intentional */ }
  }, []);

  useEffect(() => {
    loadMedia();
    loadProviders();
  }, [loadMedia, loadProviders]);

  const filteredMedia = searchQuery
    ? media.filter(m =>
        (m.metadata?.prompt || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (m.name || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : media;

  const images = filteredMedia.filter(m => m.type === 'image');
  const videos = filteredMedia.filter(m => m.type === 'video');

  const hasApiKey = providers.length > 0;

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('确定删除此媒体文件？此操作不可撤销。'))) return;
    try {
      await api.deleteMedia(id);
      loadMedia();
    } catch (e: unknown) {
      // Error handled by useGeneration toast
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!(await confirmDialog(`确定删除选中的 ${selectedIds.size} 个媒体文件？此操作不可撤销。`))) return;
    try {
      await api.batchDeleteMedia([...selectedIds]);
      setSelectedIds(new Set());
      setSelectionMode(false);
      loadMedia();
    } catch (e: unknown) {
      // Error handled by useGeneration toast
    }
  };

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllSelection = () => {
    if (selectedIds.size === filteredMedia.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredMedia.map(m => m.id)));
    }
  };

  const handleDownload = (item: MediaItem) => {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = item.name || `media_${item.id}`;
    a.click();
  };

  const openPreview = (item: MediaItem) => {
    setPreviewItem(item);
  };

  const closePreview = () => {
    setPreviewItem(null);
  };

  const onFormReset = useCallback(() => {
    setShowForm(false);
    loadMedia();
  }, [loadMedia]);

  const { form, generating, genProgressLabel, genResults, toasts, fileInputRef, availableSizes, availableModels, VIDEO_DURATIONS,
    handleGenerate, handleTypeChange, handleProviderChange, handleModelChange, handleSizeChange,
    handleNumChange, handleVideoDurationChange, handlePromptChange, handleNegativePromptChange,
    handleImageUrlChange, handleImageUpload, handleFileUpload, clearImage, addToast } = useGeneration({
    providers,
    defaultProvs,
    onFormReset,
  });

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader
          title="AI Studio"
          description="图片、视频 AI 生成"
          icon={<Palette size={22} />}
          color="#a78bfa"
          action={
            <button
              className="btn btn-primary"
              onClick={() => setShowForm(!showForm)}
              disabled={!hasApiKey}
            >
              <Plus size={18} />
              {showForm ? '收起' : '生成'}
            </button>
          }
        />

        {!hasApiKey && (
          <div className="glass-card mb-6 text-center py-8">
            <AlertCircle size={32} style={{ color: 'var(--text-tertiary)', margin: '0 auto 12px', opacity: 0.5 }} />
            <p style={{ color: 'var(--text-secondary)' }}>请先在 AI Providers 中配置 API Provider</p>
          </div>
        )}

        {/* ===== GENERATION FORM ===== */}
        {showForm && hasApiKey && (
          <MediaForm
            form={form}
            generating={generating}
            genProgressLabel={genProgressLabel}
            genResults={genResults}
            toasts={toasts}
            fileInputRef={fileInputRef}
            availableSizes={availableSizes}
            availableModels={availableModels}
            VIDEO_DURATIONS={VIDEO_DURATIONS}
            onTypeChange={handleTypeChange}
            onProviderChange={handleProviderChange}
            onModelChange={handleModelChange}
            onSizeChange={handleSizeChange}
            onNumChange={handleNumChange}
            onVideoDurationChange={handleVideoDurationChange}
            onPromptChange={handlePromptChange}
            onNegativePromptChange={handleNegativePromptChange}
            onImageUrlChange={handleImageUrlChange}
            onImageUpload={handleImageUpload}
            onFileUpload={handleFileUpload}
            onClearImage={clearImage}
            onGenerate={handleGenerate}
            onCancel={() => setShowForm(false)}
            providers={providers}
            defaultProvs={defaultProvs}
          />
        )}

        {/* ===== GALLERY TOOLBAR ===== */}
        <div className="flex items-center justify-between mb-4">
          <div className="input-field" style={{ width: 280, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 16, height: 44 }}>
            <Search size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <input
              type="text"
              placeholder="搜索图片/视频..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 14 }}
            />
          </div>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)' }}>
              {filteredMedia.length} 个文件
            </span>
            <button className="btn btn-ghost btn-sm" onClick={loadMedia} title="刷新">
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        {/* ===== Batch Delete Toolbar ===== */}
        {filteredMedia.length > 0 && (
          <div className="flex items-center gap-3 mb-4" style={{ padding: '12px 16px', borderRadius: 12, background: 'var(--bg-surface)' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setSelectionMode(!selectionMode); setSelectedIds(new Set()); }}
              style={{ fontSize: 12, color: selectionMode ? 'var(--color-accent)' : 'var(--text-secondary)' }}
            >
              {selectionMode ? '退出选择' : '选择模式'}
            </button>
            {selectionMode && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={toggleAllSelection} style={{ fontSize: 12 }}>
                  {selectedIds.size === filteredMedia.length ? '取消全选' : '全选'} ({filteredMedia.length})
                </button>
                {selectedIds.size > 0 && (
                  <button className="btn btn-primary btn-sm" onClick={handleBatchDelete} style={{ fontSize: 12, background: 'var(--color-danger)', border: 'none' }}>
                    <Trash2 size={14} /> 删除 ({selectedIds.size})
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ===== GALLERY ===== */}
        {mediaError && !mediaLoading && (
          <div className="glass-card">
            <div className="empty-state">
              <div className="empty-state-icon" style={{ color: 'var(--color-danger)' }}>⚠️</div>
              <div className="empty-state-title">媒体加载失败</div>
              <div className="empty-state-desc">{mediaError}</div>
              <button className="btn btn-ghost mt-3" onClick={() => loadMedia()} style={{ fontSize: '13px' }}>
                重试
              </button>
            </div>
          </div>
        )}
        {mediaLoading && !mediaError && (
          <div className="glass-card">
            <div className="empty-state">
              <div className="empty-state-icon" style={{ animation: 'spin 1s linear infinite' }}>⏳</div>
              <div className="empty-state-title">加载中...</div>
            </div>
          </div>
        )}
        {!mediaLoading && !mediaError && filteredMedia.length === 0 ? (
          <div className="glass-card">
            <div className="empty-state">
              <Palette size={40} className="empty-state-icon" />
              <div className="empty-state-title">还没有生成内容</div>
              <div className="empty-state-desc">
                {searchQuery ? '没有匹配的搜索结果' : '点击上方「生成」按钮开始创建'}
              </div>
            </div>
          </div>
        ) : (
          <MediaGallery
            images={images}
            videos={videos}
            onPreview={openPreview}
            onDownload={handleDownload}
            onDelete={handleDelete}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelection={toggleSelection}
            onToggleAllSelection={toggleAllSelection}
            onBatchDelete={handleBatchDelete}
            filteredMediaLength={filteredMedia.length}
          />
        )}

        {/* ===== TOAST CONTAINER ===== */}
        <div style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 'var(--z-toast)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              className="glass-card"
              style={{
                padding: '12px 20px',
                pointerEvents: 'auto',
                maxWidth: 400,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 'var(--font-sm)',
              }}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
            >
              {t.type === 'ERROR' ? (
                <AlertCircle size={16} style={{ color: 'var(--color-danger)', flexShrink: 0 }} />
              ) : t.type === 'WARNING' ? (
                <AlertCircle size={16} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
              ) : (
                <CheckCircle2 size={16} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
              )}
              <span style={{ color: 'var(--text-primary)' }}>{t.message}</span>
            </motion.div>
          ))}
        </div>

        {/* ===== PREVIEW MODAL ===== */}
        {previewItem && (
          <MediaPreviewModal item={previewItem} onClose={closePreview} onDownload={handleDownload} onDelete={handleDelete} />
        )}
      </div>
    </div>
  );
}