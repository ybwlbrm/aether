import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppearanceStore } from '../../store/appearance';
import { api } from '../../api/client';

/**
 * WallpaperLayer — 全局环境层（spec §49-54/§97）。
 *
 * 层级：Wallpaper → Adaptive Scrim → Material → Shell → Content
 *
 * 兼容旧机制：继续监听 bg-slideshow-* 与 custombg-change CustomEvent
 * （旧 Settings 页面未迁移前保持功能不断），同时接受 appearance store 驱动。
 */

/** 采样图片亮度（0-1） */
function sampleLuminance(img: HTMLImageElement): number {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0.5;
  try {
    ctx.drawImage(img, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      total += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    }
    return total / (data.length / 4);
  } catch {
    return 0.5;
  }
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function WallpaperLayer() {
  const wallpaper = useAppearanceStore((s) => s.wallpaper);
  const setWallpaper = useAppearanceStore((s) => s.setWallpaper);
  const colorScheme = useAppearanceStore((s) => s.colorScheme);

  // Directory 模式运行时图片列表（不入 store，避免膨胀持久化）
  const [dirImages, setDirImages] = useState<string[]>([]);
  const [dirUnavailable, setDirUnavailable] = useState(false);
  const slideTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const probeImgRef = useRef<HTMLImageElement>(null);

  // 当前显示图片 URL
  const activeUrl =
    wallpaper.source === 'upload' && wallpaper.path
      ? wallpaper.path
      : wallpaper.source === 'directory' && wallpaper.activeItem
        ? wallpaper.activeItem
        : null;

  const hasActive = wallpaper.source !== 'none' && !!activeUrl;

  // ============================================================
  // 兼容旧 CustomEvent（旧 Settings 未迁移前）
  // ============================================================
  useEffect(() => {
    const startHandler = (e: Event) => {
      const ce = e as CustomEvent<{ images?: string[]; interval?: number }>;
      const { images, interval } = ce.detail ?? {};
      if (images && images.length > 0) {
        setDirImages(images);
        setDirUnavailable(false);
        setWallpaper({
          source: 'directory',
          activeItem: images[0] ?? null,
          slideshow: true,
          interval: typeof interval === 'number' && interval > 0 ? interval : wallpaper.interval,
        });
      } else {
        setWallpaper({ source: 'none', activeItem: null });
      }
    };
    const stopHandler = () => {
      setWallpaper({ source: 'none', activeItem: null, slideshow: false });
      setDirImages([]);
    };
    const clearHandler = () => {
      setWallpaper({ source: 'none', activeItem: null, slideshow: false });
      setDirImages([]);
    };
    const intervalHandler = (e: Event) => {
      const ce = e as CustomEvent<{ interval?: string | number }>;
      const v = parseInt(String(ce.detail?.interval), 10);
      if (Number.isFinite(v) && v > 0) setWallpaper({ interval: v });
    };
    const bgChangeHandler = (e: Event) => {
      const ce = e as CustomEvent<string | null>;
      const detail = ce.detail;
      if (detail) setWallpaper({ source: 'upload', path: detail });
      else setWallpaper({ source: 'none', path: null });
    };
    window.addEventListener('bg-slideshow-start', startHandler);
    window.addEventListener('bg-slideshow-stop', stopHandler);
    window.addEventListener('bg-slideshow-clear', clearHandler);
    window.addEventListener('bg-slideshow-interval', intervalHandler);
    window.addEventListener('custombg-change', bgChangeHandler);
    return () => {
      window.removeEventListener('bg-slideshow-start', startHandler);
      window.removeEventListener('bg-slideshow-stop', stopHandler);
      window.removeEventListener('bg-slideshow-clear', clearHandler);
      window.removeEventListener('bg-slideshow-interval', intervalHandler);
      window.removeEventListener('custombg-change', bgChangeHandler);
    };
  }, [setWallpaper, wallpaper.interval]);

  // ============================================================
  // Directory 模式：从后端加载图片列表
  // ============================================================
  useEffect(() => {
    if (wallpaper.source !== 'directory') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getBackgrounds();
        if (cancelled) return;
        const images: string[] = res?.images ?? [];
        if (images.length === 0) {
          setDirUnavailable(true);
          return;
        }
        setDirUnavailable(false);
        setDirImages(images);
        // 恢复上次位置（兼容旧 bgSlideshowIndex）
        const saved = parseInt(localStorage.getItem('bgSlideshowIndex') || '0', 10);
        const len = images.length;
        const idx = Number.isFinite(saved) ? (((saved % len) + len) % len) : 0;
        setWallpaper({ activeItem: images[idx] ?? images[0] });
        if (wallpaper.interval && (res?.interval ?? 0) > 0) {
          setWallpaper({ interval: res.interval });
        }
      } catch {
        if (!cancelled) setDirUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallpaper.source]);

  // ============================================================
  // Slideshow 定时器
  // ============================================================
  useEffect(() => {
    if (!wallpaper.slideshow || dirImages.length === 0) return;
    if (slideTimerRef.current) clearInterval(slideTimerRef.current);
    slideTimerRef.current = setInterval(() => {
      if (wallpaper.randomize) {
        const next = Math.floor(Math.random() * dirImages.length);
        setWallpaper({ activeItem: dirImages[next] });
      } else {
        const cur = dirImages.indexOf(wallpaper.activeItem ?? '');
        const next = (cur + 1) % dirImages.length;
        setWallpaper({ activeItem: dirImages[next] });
      }
    }, wallpaper.interval * 1000);
    return () => {
      if (slideTimerRef.current) clearInterval(slideTimerRef.current);
    };
  }, [wallpaper.slideshow, wallpaper.interval, wallpaper.randomize, dirImages, wallpaper.activeItem, setWallpaper]);

  // 持久化轮播位置
  useEffect(() => {
    if (wallpaper.slideshow && dirImages.length > 0) {
      try {
        localStorage.setItem('bgSlideshowIndex', String(Math.max(0, dirImages.indexOf(wallpaper.activeItem ?? ''))));
      } catch {
        /* ignore */
      }
    }
  }, [wallpaper.slideshow, wallpaper.activeItem, dirImages]);

  // ============================================================
  // 环境层标记（data-wallpaper / data-bg-active）
  // ============================================================
  useEffect(() => {
    const root = document.documentElement;
    if (hasActive) {
      root.setAttribute('data-wallpaper', 'active');
      root.setAttribute('data-bg-active', 'true');
    } else {
      root.removeAttribute('data-wallpaper');
      root.removeAttribute('data-bg-active');
    }
  }, [hasActive]);

  // ============================================================
  // 自适应对比（spec §54）：采样亮度 → scrim + glass 透明度
  // ============================================================
  useEffect(() => {
    const root = document.documentElement;
    if (!hasActive || !probeImgRef.current) {
      root.style.setProperty('--wallpaper-scrim', 'transparent');
      return;
    }
    const img = probeImgRef.current;
    if (!img.complete || img.naturalWidth === 0) return;
    const lum = sampleLuminance(img);
    // 亮图 → 增强 scrim；暗图 → 降低 scrim
    const adaptive = clamp((0.5 - lum) * 0.6, -0.12, 0.12);
    const base = colorScheme === 'light' ? 0.42 : 0.5;
    const overlay = clamp((wallpaper.overlay / 100) * base + adaptive, 0.05, 0.82);
    const scrimColor = colorScheme === 'light' ? '255, 255, 255' : '8, 9, 13';
    root.style.setProperty('--wallpaper-scrim', `rgba(${scrimColor}, ${overlay.toFixed(3)})`);
    // Glass 动态透明度（用户手动覆盖优先）
    root.style.setProperty('--glass-vibrancy-opacity', String(clamp(0.05 + lum * 0.05, 0.04, 0.14)));
  }, [hasActive, activeUrl, wallpaper.overlay, wallpaper.brightness, colorScheme]);

  // ============================================================
  // 渲染
  // ============================================================
  if (!hasActive) return null;

  const scrimStyle = {
    background: 'var(--wallpaper-scrim)',
    opacity: (wallpaper.brightness / 100) * 0.9 + 0.1,
  };

  return (
    <>
      {/* 隐藏 img：用于亮度采样 */}
      {activeUrl && (
        <img
          ref={probeImgRef}
          src={activeUrl}
          alt=""
          aria-hidden="true"
          style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        />
      )}
      {/* 壁纸层 */}
      <div
        aria-hidden="true"
        className="aether-wallpaper"
        key={wallpaper.activeItem ?? wallpaper.path ?? 'wallpaper'}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: -3,
          backgroundImage: `url(${activeUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          filter: `blur(${wallpaper.blur}px) brightness(${wallpaper.brightness / 100}) contrast(${wallpaper.contrast / 100}) saturate(${wallpaper.saturation / 100})`,
          transition: 'opacity 0.6s ease',
          pointerEvents: 'none',
        }}
      />
      {/* 自适应 scrim */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: -2,
          background: 'var(--wallpaper-scrim)',
          pointerEvents: 'none',
          transition: 'background 0.4s ease',
          opacity: 1,
          ...(scrimStyle as object),
        }}
      />
      {dirUnavailable && wallpaper.source === 'directory' && (
        <div
          role="status"
          style={{
            position: 'fixed',
            bottom: 12,
            right: 12,
            zIndex: 2000,
            fontSize: 12,
            color: 'var(--text-secondary)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
          }}
        >
          Folder unavailable — choose another folder
        </div>
      )}
    </>
  );
}
