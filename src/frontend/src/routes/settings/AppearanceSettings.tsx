import { useState, useEffect, useRef, useCallback } from 'react';
import { Image, Trash2, FolderOpen, Palette, Plus, Check } from 'lucide-react';
import { api } from '../../api/client';
import { confirm as confirmDialog } from '../../components/ui/confirm-dialog';

const DEFAULT_GLASS = { blurRadius: 26, saturate: 200, vibrancyOpacity: 0.06 };

function applyGlassToCSS(blur: number, saturate: number, opacity: number) {
  const root = document.documentElement;
  root.style.setProperty('--glass-blur-radius', `${blur}px`);
  root.style.setProperty('--glass-saturate', `${saturate}%`);
  root.style.setProperty('--glass-vibrancy-opacity', String(opacity));
}

function loadGlassFromStorage() {
  try {
    const saved = localStorage.getItem('glassEffect');
    if (saved) return JSON.parse(saved);
  } catch (_e: unknown) { /* ignore - intentional */ }
  return DEFAULT_GLASS;
}

interface AppearanceSettingsProps {
  theme: string;
  setTheme: (theme: string) => void;
  activeTheme: string;
  setActiveTheme: (theme: string) => void;
  bgImage: string | null;
  setBgImage: (image: string | null) => void;
  bgFolder: string;
  setBgFolder: (folder: string) => void;
  bgImages: string[];
  setBgImages: (images: string[]) => void;
  bgInterval: number;
  setBgInterval: (interval: number) => void;
  bgIntervalInput: string;
  setBgIntervalInput: (input: string) => void;
  bgEnabled: boolean;
  setBgEnabled: (enabled: boolean) => void;
  bgMode: 'upload' | 'dir';
  setBgMode: (mode: 'upload' | 'dir') => void;
  bgDirInput: string;
  setBgDirInput: (input: string) => void;
  bgDirInfo: string;
  setBgDirInfo: (info: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  bgFolderInputRef: React.RefObject<HTMLInputElement | null>;
  glassBlur: number;
  setGlassBlur: (blur: number) => void;
  glassSaturate: number;
  setGlassSaturate: (saturate: number) => void;
  glassOpacity: number;
  setGlassOpacity: (opacity: number) => void;
  glassEnabled: boolean;
  setGlassEnabled: (enabled: boolean) => void;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleRemoveBg: () => void;
  handleBgFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  loadBgImages: () => Promise<void>;
  handleEnableDirMode: () => Promise<void>;
  handleSwitchToUpload: () => Promise<void>;
  handleGlassBlur: (v: number) => void;
  handleGlassSaturate: (v: number) => void;
  handleGlassOpacity: (v: number) => void;
  handleResetGlass: () => void;
  handleToggleGlass: () => void;
}

export function AppearanceSettings({
  theme,
  setTheme,
  activeTheme,
  setActiveTheme,
  bgImage,
  setBgImage,
  bgFolder,
  setBgFolder,
  bgImages,
  setBgImages,
  bgInterval,
  setBgInterval,
  bgIntervalInput,
  setBgIntervalInput,
  bgEnabled,
  setBgEnabled,
  bgMode,
  setBgMode,
  bgDirInput,
  setBgDirInput,
  bgDirInfo,
  setBgDirInfo,
  fileInputRef,
  bgFolderInputRef,
  glassBlur,
  setGlassBlur,
  glassSaturate,
  setGlassSaturate,
  glassOpacity,
  setGlassOpacity,
  glassEnabled,
  setGlassEnabled,
  handleImageUpload,
  handleRemoveBg,
  handleBgFolderSelect,
  loadBgImages,
  handleEnableDirMode,
  handleSwitchToUpload,
  handleGlassBlur,
  handleGlassSaturate,
  handleGlassOpacity,
  handleResetGlass,
  handleToggleGlass,
}: AppearanceSettingsProps) {
  return (
    <div className="glass-card">
      <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>Appearance</h2>
      <div className="space-y-5">
        <div>
          <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Theme</label>
          <select className="input select" value={theme} onChange={e => setTheme(e.target.value)}>
            <option value="dark">Dark</option><option value="light">Light</option>
          </select>
        </div>
        <div>
          <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Custom Background</label>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
          <div className="flex items-center gap-3">
            <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
              <Image size={18} /> Upload Image
            </button>
            {bgImage && (
              <button className="btn btn-ghost" onClick={handleRemoveBg}>
                <Trash2 size={18} /> Remove
              </button>
            )}
          </div>
          {bgImage && (
            <div className="mt-4 p-2 rounded-[14px]" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
              <img src={bgImage} alt="Background preview" style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '8px', objectFit: 'cover' }} />
            </div>
          )}
          <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>Upload an image to use as custom background. Apple Liquid Glass style will be applied automatically.</p>
        </div>

        {/* 背景轮播 */}
        <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 24, marginTop: 24 }}>
          <div className="flex items-center justify-between mb-4">
            <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>背景轮播</h3>
            <div className="flex items-center gap-2">
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>启用</label>
              <button onClick={() => { const next = !bgEnabled; setBgEnabled(next); if (next && bgImages.length > 0) window.dispatchEvent(new CustomEvent('bg-slideshow-start', { detail: { images: bgImages, interval: bgInterval } })); else window.dispatchEvent(new CustomEvent('bg-slideshow-stop', {})); }}
                role="switch" aria-checked={bgEnabled} aria-label="背景轮播开关"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: bgEnabled ? 'var(--color-accent)' : 'var(--text-tertiary)' }}>
                {bgEnabled ? '🔵' : '⚪'}
              </button>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>选择文件夹上传（JPG/PNG）</label>
              <input type="file" className="hidden" onChange={handleBgFolderSelect} multiple accept="image/jpeg,image/png" ref={(el) => { bgFolderInputRef.current = el; }} />
              <div className="flex items-center gap-3">
                <button className="btn btn-primary" onClick={() => bgFolderInputRef.current?.click()}
                  style={bgMode === 'dir' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
                  title={bgMode === 'dir' ? '目录模式下不可上传，请先切回上传模式' : undefined}>
                  <FolderOpen size={18} /> 选择文件夹
                </button>
                {bgMode === 'dir' && <span className="text-xs" style={{ color: 'var(--color-warning)' }}>目录模式下不可上传，请先切回上传模式</span>}
                {bgFolder && <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{bgFolder}（{bgImages.length} 张）</span>}
              </div>
            </div>
            {/* 目录模式：直接读取本地文件夹 */}
            <div style={{ borderTop: '1px dashed var(--border-primary)', paddingTop: 16 }}>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm" style={{ color: 'var(--text-secondary)' }}>目录模式（直接读取本地文件夹图片）</label>
                {bgMode === 'dir' && (
                  <button className="btn btn-ghost btn-sm" onClick={handleSwitchToUpload} style={{ fontSize: 12 }}>
                    切回上传模式
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input className="input flex-1" type="text" placeholder="输入图片文件夹路径，如 D:\壁纸"
                  value={bgDirInput}
                  onChange={e => setBgDirInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleEnableDirMode(); }} />
                <button className="btn btn-secondary flex-shrink-0" onClick={handleEnableDirMode} style={{ color: bgMode === 'dir' ? 'var(--color-accent)' : undefined }}>
                  {bgMode === 'dir' ? '重新扫描' : '启用目录模式'}
                </button>
              </div>
              {bgDirInfo && <p className="text-xs mt-2" style={{ color: 'var(--color-accent)' }}>{bgDirInfo}</p>}
              {bgMode === 'dir' && (
                <div className="flex gap-2 overflow-x-auto" style={{ padding: '8px 0' }}>
                  {bgImages.slice(0, 10).map((img, i) => (
                    <img key={i} src={img} alt="" style={{ width: 60, height: 40, borderRadius: 4, objectFit: 'cover', border: '1px solid var(--card-border)' }} />
                  ))}
                  {bgImages.length === 0 && <span className="text-xs" style={{ color: 'var(--text-tertiary)', alignSelf: 'center' }}>该目录暂无图片（支持 png/jpg/jpeg/gif/webp/bmp/avif）</span>}
                  {bgImages.length > 10 && <span className="text-xs" style={{ color: 'var(--text-tertiary)', alignSelf: 'center' }}>+{bgImages.length - 10}</span>}
                </div>
              )}
            </div>
            {/* 背景轮播：切换秒数 */}
            <div>
              <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>切换秒数</label>
              <input className="input" type="number" min="3" max="60" value={bgIntervalInput}
                onChange={e => {
                  setBgIntervalInput(e.target.value);
                  const raw = parseInt(e.target.value, 10);
                  if (!Number.isFinite(raw)) return;
                  const v = Math.min(60, Math.max(3, raw));
                  setBgInterval(v);
                  window.dispatchEvent(new CustomEvent('bg-slideshow-interval', { detail: { interval: v } }));
                }}
                onBlur={() => {
                  const raw = parseInt(bgIntervalInput, 10);
                  const v = Number.isFinite(raw) ? Math.min(60, Math.max(3, raw)) : bgInterval;
                  setBgInterval(v);
                  setBgIntervalInput(String(v));
                  window.dispatchEvent(new CustomEvent('bg-slideshow-interval', { detail: { interval: v } }));
                  api.setBackgroundInterval(v).catch(() => { console.warn('[Settings] 间隔持久化失败'); });
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) (e.target as HTMLInputElement).blur(); }} />
            </div>
            {bgMode !== 'dir' && bgImages.length > 0 && (
              <div className="flex gap-2 overflow-x-auto" style={{ padding: '8px 0' }}>
                {bgImages.slice(0, 10).map((img, i) => (
                  <img key={i} src={img} alt="" style={{ width: 60, height: 40, borderRadius: 4, objectFit: 'cover', border: '1px solid var(--card-border)' }} />
                ))}
                {bgImages.length > 10 && <span className="text-xs" style={{ color: 'var(--text-tertiary)', alignSelf: 'center' }}>+{bgImages.length - 10}</span>}
              </div>
            )}
            {bgMode === 'upload' && bgImages.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                if (!(await confirmDialog('确定清除所有轮播图片？此操作不可撤销。'))) return;
                setBgImages([]); setBgFolder(''); setBgEnabled(false);
                try { await api.clearBackgrounds(); } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
                window.dispatchEvent(new CustomEvent('bg-slideshow-clear', {}));
              }}
                style={{ color: 'var(--color-danger)' }}>清除轮播图片</button>
            )}
          </div>
        </div>

        {/* 玻璃效果滑块 */}
        <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 24, marginTop: 24 }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>Liquid Glass 效果</h3>
              <button onClick={handleToggleGlass}
                role="switch" aria-checked={glassEnabled} aria-label="Liquid Glass 效果开关"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: glassEnabled ? 'var(--color-accent)' : 'var(--text-tertiary)' }}>
                {glassEnabled ? '🔵' : '⚪'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost btn-sm" onClick={handleResetGlass} style={{ fontSize: 12 }}>重置默认</button>
            </div>
          </div>
          <div className="space-y-5">
            {/* 模糊半径 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>模糊半径</label>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>{glassBlur}px</span>
              </div>
              <input type="range" min="0" max="60" value={glassBlur} onChange={e => handleGlassBlur(parseInt(e.target.value))}
                style={{ width: '100%', height: 6, borderRadius: 3, appearance: 'none', WebkitAppearance: 'none', background: 'linear-gradient(to right, var(--color-accent) ' + (glassBlur / 60 * 100) + '%, rgba(255,255,255,0.1) ' + (glassBlur / 60 * 100) + '%)', outline: 'none', cursor: 'pointer' }} />
              <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}><span>0px</span><span>60px</span></div>
            </div>

            {/* 饱和度 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>饱和度</label>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>{glassSaturate}%</span>
              </div>
              <input type="range" min="50" max="400" value={glassSaturate} onChange={e => handleGlassSaturate(parseInt(e.target.value))}
                style={{ width: '100%', height: 6, borderRadius: 3, appearance: 'none', WebkitAppearance: 'none', background: 'linear-gradient(to right, var(--color-accent) ' + ((glassSaturate - 50) / 350 * 100) + '%, rgba(255,255,255,0.1) ' + ((glassSaturate - 50) / 350 * 100) + '%)', outline: 'none', cursor: 'pointer' }} />
              <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}><span>50%</span><span>400%</span></div>
            </div>

            {/* 透明度 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>透明度</label>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>{glassOpacity.toFixed(2)}</span>
              </div>
              <input type="range" min="0.02" max="0.30" step="0.01" value={glassOpacity} onChange={e => handleGlassOpacity(parseFloat(e.target.value))}
                style={{ width: '100%', height: 6, borderRadius: 3, appearance: 'none', WebkitAppearance: 'none', background: 'linear-gradient(to right, var(--color-accent) ' + ((glassOpacity - 0.02) / 0.28 * 100) + '%, rgba(255,255,255,0.1) ' + ((glassOpacity - 0.02) / 0.28 * 100) + '%)', outline: 'none', cursor: 'pointer' }} />
              <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}><span>0.02</span><span>0.30</span></div>
            </div>
          </div>
        </div>

        {/* UI 主题选择 */}
        <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 24, marginTop: 24 }}>
          <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>UI 主题</h3>
          <div className="grid grid-cols-4 gap-3">
            {[
              { id: 'liquid-glass', label: 'Liquid Glass', desc: 'Apple 毛玻璃', colors: ['var(--color-accent)', '#a78bfa', '#0a0b10'] },
              { id: 'shadcn', label: 'shadcn/ui', desc: '简洁中性', colors: ['#3b82f6', '#09090b', '#18181b'] },
              { id: 'geist', label: 'Geist', desc: 'Vercel 极简', colors: ['#0070f3', '#000000', '#1a1a1a'] },
              { id: 'magic', label: 'Magic UI', desc: '渐变光效', colors: ['#a78bfa', '#0a0a0f', '#1a1a2e'] },
              { id: 'origin', label: 'Origin UI', desc: '圆润柔和', colors: ['#6366f1', '#0c0c10', '#1c1c24'] },
              { id: 'dark-minimal', label: '简约暗色', desc: '纯黑低对比', colors: ['#666666', '#000000', '#111111'] },
              { id: 'light', label: '简约亮色', desc: '纯白高对比', colors: ['#3b82f6', '#fafafa', '#ffffff'] },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => {
                  setActiveTheme(t.id);
                  localStorage.setItem('uiTheme', t.id);
                  document.documentElement.setAttribute('data-theme', t.id === 'liquid-glass' ? 'dark' : t.id);
                  const root = document.documentElement;
                  root.style.removeProperty('--glass-blur-radius');
                  root.style.removeProperty('--glass-saturate');
                  root.style.removeProperty('--glass-vibrancy-opacity');
                  const cs = getComputedStyle(root);
                  const newBlur = parseInt(cs.getPropertyValue('--glass-blur-radius').trim()) || 26;
                  const newSat = parseInt(cs.getPropertyValue('--glass-saturate').trim()) || 200;
                  const newOp = parseFloat(cs.getPropertyValue('--glass-vibrancy-opacity').trim()) || 0.06;
                  setGlassBlur(newBlur);
                  setGlassSaturate(newSat);
                  setGlassOpacity(newOp);
                  const effect = { blurRadius: newBlur, saturate: newSat, vibrancyOpacity: newOp };
                  localStorage.setItem('glassEffect', JSON.stringify(effect));
                  const repaintEls = document.querySelectorAll<HTMLElement>('.glass-card, .sidebar-glass, .input, .select, .btn');
                  repaintEls.forEach(el => {
                      el.style.transform = 'translateZ(0.001px)';
                      el.style.backdropFilter = 'none';
                    });
                  setTimeout(() => {
                    repaintEls.forEach(el => {
                      el.style.transform = '';
                      el.style.backdropFilter = '';
                    });
                  }, 50);
                }}
                className="rounded-[14px] transition-all"
                style={{
                  padding: 12,
                  background: activeTheme === t.id ? `${t.colors[0]}15` : 'var(--card-bg)',
                  border: activeTheme === t.id ? `2px solid ${t.colors[0]}` : '1px solid var(--card-border)',
                  borderRadius: 14,
                  display: 'flex', flexDirection: 'column', gap: 10,
                }}
              >
                <div style={{ display: 'flex', gap: 5 }}>
                  {t.colors.map((c, ci) => (
                    <span key={ci} style={{ width: 26, height: 18, borderRadius: 5, background: c, border: '1px solid rgba(255,255,255,0.15)', flexShrink: 0 }} />
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: activeTheme === t.id ? t.colors[0] : 'var(--text-primary)' }}>{t.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}