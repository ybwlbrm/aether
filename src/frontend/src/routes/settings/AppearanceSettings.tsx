import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image, Trash2, FolderOpen, Palette, Sun, Moon, Check,
  PlayCircle, Shuffle, Upload, FolderX,
} from 'lucide-react';
import { api } from '../../api/client';
import { useAppearanceStore, type UiTheme } from '../../store/appearance';

/**
 * AppearanceSettings — 外观引擎控制台（spec §45-54）。
 *
 * 三个独立维度：colorScheme（明暗）· material（Liquid Glass 参数）· wallpaper（环境层）。
 * 直接消费 appearance store，不再接收 props 透传。
 */

const UI_THEMES: Array<{ id: UiTheme; label: string }> = [
  { id: 'liquid-glass', label: 'Liquid Glass' },
  { id: 'dark-minimal', label: 'Dark Minimal' },
  { id: 'shadcn', label: 'shadcn' },
  { id: 'geist', label: 'Geist' },
  { id: 'magic', label: 'Magic' },
  { id: 'origin', label: 'Origin' },
  { id: 'light', label: 'Light' },
];

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

function Slider({
  label, value, min, max, step = 1, unit = '', onChange,
}: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 76, fontSize: 12.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        style={{ flex: 1, accentColor: 'var(--accent-interactive)' }}
      />
      <span style={{ width: 48, fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'right', flexShrink: 0 }}>
        {value}{unit}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: '16px 0', borderBottom: '1px solid var(--border-primary)' }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>{title}</h3>
      {children}
    </section>
  );
}

export function AppearanceSettings() {
  const colorScheme = useAppearanceStore((s) => s.colorScheme);
  const setColorScheme = useAppearanceStore((s) => s.setColorScheme);
  const uiTheme = useAppearanceStore((s) => s.uiTheme);
  const setUiTheme = useAppearanceStore((s) => s.setUiTheme);
  const material = useAppearanceStore((s) => s.material);
  const setMaterialMode = useAppearanceStore((s) => s.setMaterialMode);
  const setMaterialParam = useAppearanceStore((s) => s.setMaterialParam);
  const resetMaterial = useAppearanceStore((s) => s.resetMaterial);
  const wallpaper = useAppearanceStore((s) => s.wallpaper);
  const setWallpaper = useAppearanceStore((s) => s.setWallpaper);
  const resetWallpaper = useAppearanceStore((s) => s.resetWallpaper);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dirImages, setDirImages] = useState<string[]>([]);
  const [dirInfo, setDirInfo] = useState('');
  const [dirUnavailable, setDirUnavailable] = useState(false);

  // ============================================================
  // 壁纸：加载当前目录图片
  // ============================================================
  const loadBgImages = useCallback(async () => {
    try {
      const res = await api.getBackgrounds();
      const images: string[] = res?.images ?? [];
      setDirImages(images);
      setDirUnavailable(images.length === 0);
    } catch {
      setDirUnavailable(true);
    }
  }, []);

  useEffect(() => {
    if (wallpaper.source === 'directory') loadBgImages();
  }, [wallpaper.source, loadBgImages]);

  // 上传单图
  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    try {
      const urls = await Promise.all(
        files.map((f) => new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(f);
        })),
      );
      const res = await api.uploadBackgrounds(urls);
      const all = res?.images ?? urls;
      setDirImages(all);
      setWallpaper({ source: 'upload', path: urls[0] ?? null });
      setDirUnavailable(false);
    } catch {
      setDirUnavailable(true);
    }
    e.target.value = '';
  }, [setWallpaper]);

  // 选择目录（electron 环境）或手动输入
  const handleBgFolderSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const dir = e.target.files?.[0]?.webkitRelativePath ? e.target.value : e.target.value;
    if (!dir) return;
    setDirInfo(dir);
    try {
      await api.setBackgroundSource('dir', dir);
      await loadBgImages();
      const imgs = await api.getBackgrounds();
      const images: string[] = imgs?.images ?? [];
      if (images.length > 0) {
        setWallpaper({ source: 'directory', activeItem: images[0] ?? null });
      }
    } catch {
      setDirUnavailable(true);
    }
    e.target.value = '';
  }, [loadBgImages, setWallpaper]);

  const handleRemoveBg = useCallback(() => {
    setWallpaper({ source: 'none', path: null, activeItem: null, slideshow: false });
    setDirImages([]);
  }, [setWallpaper]);

  // Slideshow 定时推进（设置面板内预览）
  useEffect(() => {
    if (!wallpaper.slideshow || dirImages.length === 0) return;
    const timer = setInterval(() => {
      const cur = dirImages.indexOf(wallpaper.activeItem ?? '');
      const next = wallpaper.randomize
        ? Math.floor(Math.random() * dirImages.length)
        : (cur + 1) % dirImages.length;
      setWallpaper({ activeItem: dirImages[next] });
    }, wallpaper.interval * 1000);
    return () => clearInterval(timer);
  }, [wallpaper.slideshow, wallpaper.interval, wallpaper.randomize, dirImages, wallpaper.activeItem, setWallpaper]);

  const applySlideshow = useCallback(async () => {
    if (wallpaper.slideshow && dirImages.length > 0) {
      try {
        await api.setBackgroundInterval(wallpaper.interval);
      } catch { /* ignore */ }
    }
  }, [wallpaper.slideshow, wallpaper.interval, dirImages.length]);

  return (
    <div style={{ maxWidth: 'var(--content-standard)', margin: '0 auto', padding: '24px' }}>
      {/* ================= Theme ================= */}
      <Section title="Theme">
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button
            onClick={() => setColorScheme('dark')}
            data-active={colorScheme === 'dark'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px',
              borderRadius: 'var(--radius-control)', border: '1px solid var(--border-primary)',
              background: colorScheme === 'dark' ? 'var(--sidebar-item-active)' : 'var(--bg-surface)',
              color: 'var(--text-primary)', fontSize: 12.5, cursor: 'pointer',
            }}
          >
            <Moon size={14} /> Dark
          </button>
          <button
            onClick={() => setColorScheme('light')}
            data-active={colorScheme === 'light'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px',
              borderRadius: 'var(--radius-control)', border: '1px solid var(--border-primary)',
              background: colorScheme === 'light' ? 'var(--sidebar-item-active)' : 'var(--bg-surface)',
              color: 'var(--text-primary)', fontSize: 12.5, cursor: 'pointer',
            }}
          >
            <Sun size={14} /> Light
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {UI_THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => setUiTheme(t.id)}
              data-active={uiTheme === t.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px',
                borderRadius: 'var(--radius-control)', border: '1px solid var(--border-primary)',
                background: uiTheme === t.id ? 'var(--sidebar-item-active)' : 'transparent',
                color: uiTheme === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 12, cursor: 'pointer',
              }}
            >
              {uiTheme === t.id && <Check size={12} />}
              {t.label}
            </button>
          ))}
        </div>
      </Section>

      {/* ================= Liquid Glass ================= */}
      <Section title="Liquid Glass">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Use Liquid Glass across Aether
          </span>
          <button
            onClick={() => setMaterialMode(material.mode === 'glass' ? 'opaque' : 'glass')}
            role="switch"
            aria-checked={material.mode === 'glass'}
            style={{
              width: 40, height: 22, borderRadius: 11,
              background: material.mode === 'glass' ? 'var(--accent-interactive)' : 'var(--bg-surface-hover)',
              border: '1px solid var(--border-primary)', position: 'relative', cursor: 'pointer', padding: 0,
            }}
          >
            <span
              style={{
                position: 'absolute', top: 2, width: 16, height: 16, borderRadius: 8,
                background: '#fff',
                left: material.mode === 'glass' ? 20 : 2,
                transition: 'left 0.15s var(--motion-enter)',
              }}
            />
          </button>
        </div>
        {material.mode === 'glass' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Slider label="Intensity" value={material.intensity} min={0} max={100} unit="%" onChange={(v) => setMaterialParam('intensity', v)} />
            <Slider label="Blur" value={material.blur} min={0} max={36} unit="px" onChange={(v) => setMaterialParam('blur', v)} />
            <Slider label="Saturation" value={material.saturation} min={100} max={160} unit="%" onChange={(v) => setMaterialParam('saturation', v)} />
            <Slider label="Brightness" value={Math.round(material.brightness * 100)} min={95} max={115} unit="%" onChange={(v) => setMaterialParam('brightness', v / 100)} />
            <Slider label="Rim" value={material.rim} min={0} max={100} unit="%" onChange={(v) => setMaterialParam('rim', v)} />
            <div style={{ marginTop: 4 }}>
              <button
                onClick={resetMaterial}
                style={{ fontSize: 12, color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Reset to defaults
              </button>
            </div>
          </div>
        )}
      </Section>

      {/* ================= Wallpaper ================= */}
      <Section title="Wallpaper">
        {/* Source */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {(
            [
              { id: 'none' as const, label: 'None', icon: <Image size={14} /> },
              { id: 'upload' as const, label: 'Upload', icon: <Upload size={14} /> },
              { id: 'directory' as const, label: 'Directory', icon: <FolderOpen size={14} /> },
            ]
          ).map((s) => (
            <button
              key={s.id}
              onClick={() => setWallpaper({ source: s.id })}
              data-active={wallpaper.source === s.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px',
                borderRadius: 'var(--radius-control)', border: '1px solid var(--border-primary)',
                background: wallpaper.source === s.id ? 'var(--sidebar-item-active)' : 'var(--bg-surface)',
                color: 'var(--text-primary)', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              {s.icon} {s.label}
            </button>
          ))}
        </div>

        {wallpaper.source === 'upload' && (
          <div
            style={{
              border: '1px dashed var(--border-strong)',
              borderRadius: 'var(--radius-surface)',
              padding: 20,
              textAlign: 'center',
            }}
          >
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {wallpaper.path ? 'Current wallpaper active. Replace or remove:' : 'Drop image here (JPG / PNG / WebP / AVIF)'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="aether-ctx-btn"
                style={{ height: 34, padding: '0 12px', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-control)', fontSize: 12.5 }}
              >
                <Image size={14} /> Choose Image
              </button>
              {wallpaper.path && (
                <button
                  onClick={handleRemoveBg}
                  className="aether-ctx-btn"
                  style={{ height: 34, padding: '0 12px', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-control)', fontSize: 12.5, color: 'var(--color-danger)' }}
                >
                  <Trash2 size={14} /> Remove
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              multiple
              style={{ display: 'none' }}
              onChange={handleImageUpload}
            />
          </div>
        )}

        {wallpaper.source === 'directory' && (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="aether-ctx-btn"
                style={{ height: 34, padding: '0 12px', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-control)', fontSize: 12.5 }}
              >
                <FolderOpen size={14} /> Choose Folder
              </button>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={handleBgFolderSelect}
                {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dirInfo || wallpaper.activeItem ? 'Folder selected' : 'Select a folder with images'}
              </span>
            </div>

            {dirUnavailable ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-warning)', fontSize: 12.5, marginBottom: 10 }}>
                <FolderX size={14} /> Folder unavailable — choose another folder
              </div>
            ) : dirImages.length > 0 && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
                  gap: 6,
                  maxHeight: 180,
                  overflowY: 'auto',
                  marginBottom: 12,
                }}
              >
                {dirImages.map((img) => (
                  <button
                    key={img}
                    onClick={() => setWallpaper({ activeItem: img })}
                    title="Set as wallpaper"
                    style={{
                      width: 72,
                      height: 48,
                      padding: 0,
                      border: wallpaper.activeItem === img
                        ? '2px solid var(--accent-interactive)'
                        : '1px solid var(--border-primary)',
                      borderRadius: 6,
                      overflow: 'hidden',
                      cursor: 'pointer',
                      background: `url(${img}) center/cover no-repeat`,
                    }}
                  />
                ))}
              </div>
            )}

            {/* Slideshow */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
              <button
                onClick={() => { setWallpaper({ slideshow: !wallpaper.slideshow }); applySlideshow(); }}
                data-active={wallpaper.slideshow}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px',
                  borderRadius: 'var(--radius-control)', border: '1px solid var(--border-primary)',
                  background: wallpaper.slideshow ? 'var(--sidebar-item-active)' : 'transparent',
                  color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
                }}
              >
                <PlayCircle size={14} /> Slideshow {wallpaper.slideshow ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={() => setWallpaper({ randomize: !wallpaper.randomize })}
                data-active={wallpaper.randomize}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px',
                  borderRadius: 'var(--radius-control)', border: '1px solid var(--border-primary)',
                  background: wallpaper.randomize ? 'var(--sidebar-item-active)' : 'transparent',
                  color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
                }}
              >
                <Shuffle size={14} /> Randomize
              </button>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                Interval
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={wallpaper.interval}
                  onChange={(e) => setWallpaper({ interval: Math.max(1, Number(e.target.value) || 60) })}
                  aria-label="Slideshow interval (seconds)"
                  style={{
                    width: 64,
                    height: 30,
                    borderRadius: 'var(--radius-control)',
                    border: '1px solid var(--border-primary)',
                    background: 'var(--input-bg)',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    padding: '0 8px',
                  }}
                />
                s
              </label>
            </div>
          </div>
        )}

        {/* 壁纸调整滑块（spec §52） */}
        {wallpaper.source !== 'none' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
            <Slider label="Brightness" value={wallpaper.brightness} min={50} max={150} unit="%" onChange={(v) => setWallpaper({ brightness: v })} />
            <Slider label="Contrast" value={wallpaper.contrast} min={50} max={150} unit="%" onChange={(v) => setWallpaper({ contrast: v })} />
            <Slider label="Saturation" value={wallpaper.saturation} min={50} max={150} unit="%" onChange={(v) => setWallpaper({ saturation: v })} />
            <Slider label="Overlay" value={wallpaper.overlay} min={0} max={100} unit="%" onChange={(v) => setWallpaper({ overlay: v })} />
            <Slider label="Blur" value={wallpaper.blur} min={0} max={36} unit="px" onChange={(v) => setWallpaper({ blur: v })} />
          </div>
        )}
      </Section>

      <div style={{ padding: '16px 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
        <Palette size={13} style={{ display: 'inline', marginRight: 6, verticalAlign: -2 }} />
        Wallpaper is the environment layer — Glass is a material, not a brand.
      </div>
    </div>
  );
}
