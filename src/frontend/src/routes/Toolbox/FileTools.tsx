import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { Upload, Download, FileImage, Sliders, Music, X, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import type { ConvertOption } from './types';

interface FileToolsProps {
  selected: ConvertOption;
  onBack: () => void;
  onConvert: () => void;
  converting: boolean;
  progress: number;
  elapsedSec: number;
  toolMissing: boolean;
  missingToolInfo: any;
  files: File[];
  setFiles: (files: File[]) => void;
  targetFormat: string;
  setTargetFormat: (v: string) => void;
  watermarkText: string;
  setWatermarkText: (v: string) => void;
  quality: number;
  setQuality: (v: number) => void;
  width: string;
  setWidth: (v: string) => void;
  height: string;
  setHeight: (v: string) => void;
  result: string | null;
  downloads: string[];
  error: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleDrop: (e: React.DragEvent) => void;
  utilityInput: string;
  setUtilityInput: (v: string) => void;
}

export function FileTools({
  selected, onBack, onConvert, converting, progress, elapsedSec, toolMissing, missingToolInfo,
  files, setFiles, targetFormat, setTargetFormat,
  watermarkText, setWatermarkText,
  quality, setQuality, width, setWidth, height, setHeight,
  result, downloads, error,
  fileInputRef, handleDrop,
  utilityInput, setUtilityInput
}: FileToolsProps) {
  const isImageToImage = selected.from.every(f => ['png', 'jpg', 'jpeg', 'webp'].includes(f))
    && selected.to.every(f => ['png', 'jpg', 'jpeg', 'webp'].includes(f));

  // YouTube 下载：URL 输入模式（不显示文件上传区）
  const isYoutubeDownload = selected.kind === 'youtube-download';

  return (
    <>
      {/* 工具缺失提示：需要 ffmpeg/yt-dlp/LibreOffice 但系统未安装时显示下载指引 */}
      {toolMissing && missingToolInfo && (
        <div style={{ marginTop: 4, marginBottom: 16, padding: '14px 16px', borderRadius: 'var(--radius-md)',
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
          display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <AlertCircle size={18} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 'var(--font-sm)', color: '#f59e0b', fontWeight: 600, marginBottom: 4 }}>
              此功能需要额外组件，当前未检测到
            </p>
            <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
              {missingToolInfo.downloadHint}
            </p>
            <a href={missingToolInfo.downloadUrl} target="_blank" rel="noopener noreferrer"
              className="btn btn-secondary btn-sm" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
              <Download size={14} /> 前往下载
            </a>
          </div>
        </div>
      )}

      {/* YouTube 下载：URL 输入 */}
      {isYoutubeDownload && (
        <div style={{ marginTop: 4 }}>
          <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginBottom: 8, display: 'block' }}>视频链接（YouTube 等，支持 1000+ 站点）</label>
          <input
            className="input"
            value={utilityInput}
            onChange={e => setUtilityInput(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            style={{ width: '100%' }}
          />
          <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginTop: 6 }}>
            首次使用可能需要下载 yt-dlp 工具，耗时约 10-30 秒。
          </p>
        </div>
      )}

      {/* 上传区（YouTube 下载除外） */}
      {!isYoutubeDownload && (
        <div onDragOver={e => e.preventDefault()} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
          style={{ border: '2px dashed var(--border-primary)', borderRadius: 'var(--radius-md)', padding: '36px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg-surface)' }}>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => {
            if (e.target.files) {
              setFiles(Array.from(e.target.files));
            }
          }} style={{ display: 'none' }} />
          <Upload size={28} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px', display: 'block' }} />
          <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>拖拽文件到此处，或点击选择（支持：{selected.from.join(', ')}）</p>
        </div>
      )}

      {/* 已选文件 */}
      {files.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginBottom: 8 }}>已选择 {files.length} 个文件</p>
          {files.map((f, i) => (
            <div key={i} className="flex items-center justify-between py-2 px-3 rounded-lg" style={{ background: 'var(--bg-surface)', marginBottom: 4, borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-primary)', maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)' }}>{(f.size / 1024).toFixed(1)} KB</span>
            </div>
          ))}
        </div>
      )}

      {/* 水印文字输入（仅 watermark） */}
      {selected.op === 'watermark' && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginBottom: 8, display: 'block' }}>水印文字</label>
          <input className="input" value={watermarkText} onChange={e => setWatermarkText(e.target.value)} placeholder="输入水印文字" style={{ maxWidth: 300 }} />
        </div>
      )}

      {/* 目标格式（convert / video-extract / youtube-download） */}
      {((selected.kind === 'convert' && files.length > 0) || selected.kind === 'video-extract' || isYoutubeDownload) && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginBottom: 8, display: 'block' }}>目标格式{isYoutubeDownload ? '（音频格式自动转 MP3）' : ''}</label>
          <div className="flex gap-2 flex-wrap">
            {selected.to.map(f => (
              <button key={f} onClick={() => setTargetFormat(f)}
                className="px-5 py-2.5 rounded-[14px] text-sm font-medium transition-all"
                style={{
                  background: targetFormat === f ? `${selected.color}20` : 'var(--bg-surface)',
                  color: targetFormat === f ? selected.color : 'var(--text-secondary)',
                  border: `1px solid ${targetFormat === f ? `${selected.color}40` : 'var(--border-primary)'}`,
                }}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 图片选项：压缩质量 + 宽高（仅图片 → 图片） */}
      {isImageToImage && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginBottom: 8, display: 'block' }}>
            <Sliders size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />压缩质量（jpg/webp 生效）
          </label>
          <div className="flex items-center gap-3">
            <input type="range" min={1} max={100} value={quality} onChange={e => setQuality(Number(e.target.value))}
              style={{ flex: 1, accentColor: selected.color }} />
            <span style={{ fontSize: 'var(--font-sm)', color: selected.color, fontWeight: 600, minWidth: 44, textAlign: 'right' }}>{quality}%</span>
          </div>
          <div className="flex gap-3" style={{ marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginBottom: 6, display: 'block' }}>宽度 (px)</label>
              <input type="number" min={1} className="input" placeholder="auto" value={width} onChange={e => setWidth(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginBottom: 6, display: 'block' }}>高度 (px)</label>
              <input type="number" min={1} className="input" placeholder="auto" value={height} onChange={e => setHeight(e.target.value)} style={{ width: '100%' }} />
            </div>
          </div>
        </div>
      )}

      {/* 音乐解锁：支持格式说明 */}
      {selected.kind === 'unlock' && (
        <div style={{ marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius-sm)', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Music size={18} style={{ color: '#a78bfa', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            支持格式：<b style={{ color: '#a78bfa' }}>ncm</b>（网易云 AES-CBC）· <b style={{ color: '#a78bfa' }}>qmc</b>（QQ音乐 seed+置换表）· <b style={{ color: '#a78bfa' }}>kgm</b>（酷狗掩码表）。
          </span>
        </div>
      )}

      {/* 开始处理（工具缺失时禁用） */}
      {(isYoutubeDownload
        ? (utilityInput.trim().length > 0 && targetFormat)
        : (files.length > 0 && (selected.kind !== 'convert' || targetFormat))
      ) && (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={onConvert} disabled={converting || toolMissing}>
            {toolMissing ? <><AlertCircle size={18} /> 缺少依赖组件</> : converting ? <><Loader2 size={18} className="animate-spin" /> 处理中 {elapsedSec} 秒</> : <><Download size={18} /> 开始{selected.op === 'merge' ? '合并' : selected.op === 'watermark' ? '加水印' : selected.op === 'to-image' ? '转换' : selected.op === 'to-text' ? '提取' : selected.kind === 'youtube-download' ? '下载' : '转换'}</>}
          </button>
        </div>
      )}

      {converting && (
        <div style={{ marginTop: 16 }}>
          {/* 徒有其表修复：进度条改为不确定动画（滑动条），不再显示假百分比 */}
          <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
            <div style={{
              position: 'absolute', top: 0, bottom: 0, width: '30%',
              background: 'linear-gradient(90deg, var(--color-accent), #a78bfa)', borderRadius: 2,
              animation: 'toolbox-indeterminate 1.2s ease-in-out infinite',
            }} />
          </div>
          <style>{'@keyframes toolbox-indeterminate { 0% { left: -30%; } 100% { left: 100%; } }'}</style>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius-sm)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircle2 size={18} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-success)' }}>{result}</span>
        </div>
      )}
      {downloads.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', marginBottom: 8 }}>下载转换结果：</p>
          <div className="flex gap-2 flex-wrap">
            {downloads.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                <Download size={14} /> 文件 {i + 1}
              </a>
            ))}
          </div>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius-sm)', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={18} style={{ color: 'var(--color-danger)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-danger)' }}>{error}</span>
        </div>
      )}
    </>
  );
}