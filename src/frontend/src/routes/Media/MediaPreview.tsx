import { memo } from 'react';
import { motion } from 'framer-motion';
import { X, Download, Trash2 } from 'lucide-react';
import { MediaItem, formatDate } from './shared';

interface MediaPreviewModalProps {
  item: MediaItem;
  onClose: () => void;
  onDownload: (item: MediaItem) => void;
  onDelete: (id: string) => void;
}

const MediaPreviewModalInner = memo(function MediaPreviewModalInner({
  item,
  onClose,
  onDownload,
  onDelete,
}: MediaPreviewModalProps) {
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal-backdrop)', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
        onClick={onClose}
      />
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)', pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <motion.div
          className="glass-card pointer-events-auto"
          style={{
            maxWidth: '90vw', maxHeight: '90vh', width: item.type === 'video' ? 800 : 'auto',
            padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', clipPath: 'none',
          }}
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--card-border)' }}>
            <div>
              <span style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>
                {item.type === 'video' ? '视频预览' : '图片预览'}
              </span>
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginLeft: 12 }}>
                {formatDate(item.createdAt)}
              </span>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={18} /></button>
          </div>
          <div style={{ padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300, background: '#000', overflow: 'hidden' }}>
            {item.type === 'video' ? (
              <video src={item.url} controls autoPlay style={{ maxWidth: '100%', maxHeight: '75vh', display: 'block' }} />
            ) : (
              <img src={item.url} alt={item.metadata?.prompt || ''} style={{ maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain' }} />
            )}
          </div>
          <div style={{ padding: '12px 20px', display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', borderTop: '1px solid var(--card-border)' }}>
            {item.metadata?.model && <span>模型: {item.metadata.model}</span>}
            {item.metadata?.size && <span>尺寸: {item.metadata.size}</span>}
            <span>类型: {item.type === 'video' ? '视频' : '图片'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--card-border)' }}>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.metadata?.prompt || ''}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0, marginLeft: 16 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => onDownload(item)}><Download size={14} /> 下载</button>
              <button className="btn btn-ghost btn-sm" onClick={() => onDelete(item.id)}><Trash2 size={14} /> 删除</button>
            </div>
          </div>
        </motion.div>
      </div>
    </>
  );
});

export const MediaPreviewModal = MediaPreviewModalInner;