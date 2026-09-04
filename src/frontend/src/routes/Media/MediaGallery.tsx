import { memo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Download, Trash2, Play } from 'lucide-react';
import { MediaItem } from './shared';

interface MediaGalleryProps {
  images: MediaItem[];
  videos: MediaItem[];
  onPreview: (item: MediaItem) => void;
  onDownload: (item: MediaItem) => void;
  onDelete: (id: string) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onToggleAllSelection: () => void;
  onBatchDelete: () => void;
  filteredMediaLength: number;
}

const MediaGalleryInner = memo(function MediaGalleryInner({
  images,
  videos,
  onPreview,
  onDownload,
  onDelete,
  selectionMode,
  selectedIds,
  onToggleSelection,
  onToggleAllSelection,
  onBatchDelete,
  filteredMediaLength,
}: MediaGalleryProps) {
  const renderGalleryItem = useCallback((
    item: MediaItem,
    isVideo: boolean
  ) => (
    <motion.div
      key={item.id}
      className="gallery-item"
      style={{
        breakInside: 'avoid',
        marginBottom: 16,
        borderRadius: 12,
        overflow: 'hidden',
        position: 'relative',
        cursor: 'pointer',
        background: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
        transition: 'all 0.2s ease',
      }}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={() => onPreview(item)}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = 'var(--card-hover-shadow)';
        e.currentTarget.style.borderColor = 'var(--border-primary)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = '';
        e.currentTarget.style.boxShadow = '';
        e.currentTarget.style.borderColor = '';
      }}
    >
      {isVideo ? (
        <video
          src={item.url}
          muted
          preload="metadata"
          style={{ width: '100%', display: 'block' }}
          onMouseEnter={e => { e.currentTarget.play().catch(() => {}); }}
          onMouseLeave={e => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
        />
      ) : (
        <img
          src={item.url}
          alt={item.metadata?.prompt || ''}
          loading="lazy"
          style={{ width: '100%', display: 'block' }}
        />
      )}
      {isVideo && (
        <div style={{
          position: 'absolute', top: 8, right: 8,
          background: 'rgba(0,0,0,0.6)',
          padding: '2px 8px',
          borderRadius: 4,
          fontSize: 11,
          color: 'var(--text-primary)',
        }}>
          <Play size={12} className="inline mr-1" /> 视频
        </div>
      )}
      <div
        className="gallery-item-overlay"
        style={{
          position: 'absolute',
          bottom: 0, left: 0, right: 0,
          padding: '12px 16px',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
          opacity: 0,
          transition: 'opacity 0.2s ease',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '0'; }}
      >
        <button
          className="btn btn-ghost btn-sm"
          onClick={e => { e.stopPropagation(); onDownload(item); }}
          style={{ color: 'var(--text-primary)', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)' }}
        >
          <Download size={14} />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={e => { e.stopPropagation(); onDelete(item.id); }}
          style={{ color: 'var(--text-primary)', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)' }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  ), [onPreview, onDownload, onDelete]);

  if (images.length === 0 && videos.length === 0) {
    return null;
  }

  return (
    <div>
      {/* Images Section */}
      {images.length > 0 && (
        <div className="mb-8">
          <h3 className="mb-4" style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>
            <svg width="18" height="18" className="inline mr-2" style={{ color: 'var(--color-accent)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            图片 ({images.length})
          </h3>
          <div style={{ columnCount: 3, columnGap: 16 }}>
            {images.map(item => renderGalleryItem(item, false))}
          </div>
        </div>
      )}

      {/* Videos Section */}
      {videos.length > 0 && (
        <div className="mb-8">
          <h3 className="mb-4" style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>
            <svg width="18" height="18" className="inline mr-2" style={{ color: '#a78bfa' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            视频 ({videos.length})
          </h3>
          <div style={{ columnCount: 3, columnGap: 16 }}>
            {videos.map(item => renderGalleryItem(item, true))}
          </div>
        </div>
      )}
    </div>
  );
});

export const MediaGallery = MediaGalleryInner;