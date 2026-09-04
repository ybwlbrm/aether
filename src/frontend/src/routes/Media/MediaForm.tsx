import { memo, useCallback } from 'react';
import { Image, Video, Upload, X, Loader2, Sparkles, Download, Trash2, Plus } from 'lucide-react';
import { motion } from 'framer-motion';
import { useGeneration, GenFormState, GenResult } from './useGeneration';

interface MediaFormProps {
  form: GenFormState;
  generating: boolean;
  genProgressLabel: string;
  genResults: GenResult[];
  toasts: Array<{ id: string; message: string; type: string }>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  availableSizes: string[];
  availableModels: string[];
  VIDEO_DURATIONS: Array<{ label: string; value: string }>;
  onTypeChange: (type: 'image' | 'video') => void;
  onProviderChange: (providerId: string) => void;
  onModelChange: (model: string) => void;
  onSizeChange: (size: string) => void;
  onNumChange: (num: number) => void;
  onVideoDurationChange: (videoDuration: string) => void;
  onPromptChange: (prompt: string) => void;
  onNegativePromptChange: (negativePrompt: string) => void;
  onImageUrlChange: (imageUrl: string) => void;
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFileUpload: () => void;
  onClearImage: () => void;
  onGenerate: () => void;
  onCancel: () => void;
  providers: Array<{ id: string; name: string; provider: string }>;
  defaultProvs: Record<string, string>;
}

const MediaFormInner = memo(function MediaFormInner({
  form,
  generating,
  genProgressLabel,
  genResults,
  toasts,
  fileInputRef,
  availableSizes,
  availableModels,
  VIDEO_DURATIONS,
  onTypeChange,
  onProviderChange,
  onModelChange,
  onSizeChange,
  onNumChange,
  onVideoDurationChange,
  onPromptChange,
  onNegativePromptChange,
  onImageUrlChange,
  onImageUpload,
  onFileUpload,
  onClearImage,
  onGenerate,
  onCancel,
  providers,
  defaultProvs,
}: MediaFormProps) {
  const handleTypeClick = useCallback((type: 'image' | 'video') => {
    onTypeChange(type);
  }, [onTypeChange]);

  return (
    <motion.div
      className="glass-card mb-6"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {/* Type */}
        <div>
          <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>类型</label>
          <div className="flex gap-2">
            <button
              className={`btn ${form.type === 'image' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, height: 44 }}
              onClick={() => handleTypeClick('image')}
            >
              <Image size={16} /> 图片
            </button>
            <button
              className={`btn ${form.type === 'video' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, height: 44 }}
              onClick={() => handleTypeClick('video')}
            >
              <Video size={16} /> 视频
            </button>
          </div>
        </div>

        {/* Provider */}
        <div>
          <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>Provider</label>
          <select
            className="input select"
            value={form.providerId}
            onChange={e => onProviderChange(e.target.value)}
          >
            <option value="">选择 Provider</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.name || p.provider}</option>
            ))}
          </select>
        </div>

        {/* Model */}
        <div>
          <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>模型</label>
          <select
            className="input select"
            value={form.model}
            onChange={e => onModelChange(e.target.value)}
          >
            <option value="">自动选择</option>
            {availableModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        {/* Size */}
        <div>
          <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>尺寸</label>
          <select
            className="input select"
            value={form.size}
            onChange={e => onSizeChange(e.target.value)}
          >
            {availableSizes.map(s => (
              <option key={s} value={s}>{s.replace('x', '×')}</option>
            ))}
          </select>
        </div>

        {/* Image count */}
        {form.type === 'image' && (
          <div>
            <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>数量</label>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              value={form.num}
              onChange={e => onNumChange(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
            />
          </div>
        )}

        {/* Video duration */}
        {form.type === 'video' && (
          <div>
            <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>时长</label>
            <select
              className="input select"
              value={form.videoDuration}
              onChange={e => onVideoDurationChange(e.target.value)}
            >
              {VIDEO_DURATIONS.map(d => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Prompt */}
      <div className="mb-4">
        <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>Prompt</label>
        <textarea
          className="input textarea"
          rows={3}
          value={form.prompt}
          onChange={e => onPromptChange(e.target.value)}
          placeholder="描述你想要生成的内容..."
        />
      </div>

      {/* Negative Prompt */}
      <div className="mb-4">
        <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
          Negative Prompt <span style={{ color: 'var(--text-tertiary)' }}>(可选)</span>
        </label>
        <textarea
          className="input textarea"
          rows={2}
          value={form.negativePrompt}
          onChange={e => onNegativePromptChange(e.target.value)}
          placeholder="不想要的内容..."
          style={{ minHeight: 40 }}
        />
      </div>

      {/* Reference Image */}
      <div className="mb-4">
        <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
          参考图片 <span style={{ color: 'var(--text-tertiary)' }}>(可选，用于图生图/图生视频)</span>
        </label>
        <div className="flex items-center gap-3">
          <input
            type="text"
            className="input"
            placeholder="粘贴图片 URL..."
            value={form.imageUrl}
            onChange={e => onImageUrlChange(e.target.value)}
            style={{ flex: 1 }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={onImageUpload}
          />
          <button className="btn btn-secondary" onClick={onFileUpload}>
            <Upload size={16} /> 上传
          </button>
          {form.imageData && (
            <button className="btn btn-ghost" onClick={onClearImage}>
              <X size={16} />
            </button>
          )}
        </div>
        {form.imageData && (
          <div className="mt-2 p-2 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', display: 'inline-block' }}>
            <img src={form.imageData} alt="参考图" style={{ maxHeight: 100, borderRadius: 6, objectFit: 'contain' }} />
          </div>
        )}
      </div>

      {/* Progress - FE-09: 仅显示真实等待时间，移除假进度条 */}
      {generating && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
              <Loader2 size={14} className="inline animate-spin mr-2" />
              {genProgressLabel}
            </span>
          </div>
        </div>
      )}

      {/* Results preview */}
      {genResults.length > 0 && (
        <div className="mb-4">
          <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>生成结果</label>
          <div className="flex gap-3 flex-wrap">
            {genResults.map(r => (
              <div key={r.id} className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--card-border)', width: 120, height: 120 }}>
                {r.type === 'video' ? (
                  <video src={r.url} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <img src={r.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          className="btn btn-primary"
          onClick={onGenerate}
          disabled={generating || !form.prompt.trim() || !form.providerId}
          style={{ flex: 1 }}
        >
          {generating ? (
            <><Loader2 size={18} className="animate-spin" /> 生成中...</>
          ) : (
            <><Sparkles size={18} /> 生成</>
          )}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </motion.div>
  );
});

export const MediaForm = MediaFormInner;