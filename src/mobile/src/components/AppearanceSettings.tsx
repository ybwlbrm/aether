import { useState, useEffect, useRef } from 'react';

interface Props {
  onBack: () => void;
}

// 与桌面端 Settings.tsx 保持一致
const DEFAULT_GLASS = { blurRadius: 26, saturate: 200, vibrancyOpacity: 0.06 };

function applyGlassToCSS(blur: number, saturate: number, opacity: number, enabled: boolean) {
  const root = document.documentElement;
  if (enabled) {
    root.style.setProperty('--glass-blur-radius', `${blur}px`);
    root.style.setProperty('--glass-saturate', `${saturate}%`);
    root.style.setProperty('--glass-vibrancy-opacity', String(opacity));
  } else {
    root.style.setProperty('--glass-blur-radius', `0px`);
    root.style.setProperty('--glass-saturate', `100%`);
    root.style.setProperty('--glass-vibrancy-opacity', `1`);
  }
}

function loadGlassFromStorage() {
  try {
    const saved = localStorage.getItem('aether_glass_effect');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return DEFAULT_GLASS;
}

export default function AppearanceSettings({ onBack }: Props) {
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [bgMsg, setBgMsg] = useState('');
  const [glassEnabled, setGlassEnabled] = useState(true);
  const [glassBlur, setGlassBlur] = useState(DEFAULT_GLASS.blurRadius);
  const [glassSaturate, setGlassSaturate] = useState(DEFAULT_GLASS.saturate);
  const [glassOpacity, setGlassOpacity] = useState(DEFAULT_GLASS.vibrancyOpacity);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Q3 修复：内置背景源列表 — 让用户无需上传图片即可切换多样背景（默认不再是纯黑）
  const [bgSource, setBgSource] = useState<'default' | 'aurora' | 'ocean' | 'sunset' | 'midnight' | 'custom'>('default');
  const BUILTIN_BGS: { id: string; label: string; css: string }[] = [
    { id: 'default', label: '深蓝夜空（默认）', css: 'radial-gradient(120% 90% at 15% 0%, rgba(94,158,255,0.22) 0%, rgba(139,92,246,0.16) 38%, rgba(10,11,16,0) 62%), radial-gradient(120% 100% at 100% 100%, rgba(52,211,153,0.10) 0%, rgba(10,11,16,0) 55%), linear-gradient(165deg, #0d0f1a 0%, #131528 45%, #0a0b13 100%)' },
    { id: 'aurora', label: '极光', css: 'radial-gradient(130% 100% at 20% 10%, rgba(52,211,153,0.28) 0%, rgba(94,158,255,0.18) 45%, rgba(10,11,16,0) 70%), radial-gradient(120% 100% at 85% 0%, rgba(167,139,250,0.26) 0%, rgba(10,11,16,0) 60%), linear-gradient(180deg, #08131f 0%, #0b1c2e 60%, #071018 100%)' },
    { id: 'ocean', label: '深海', css: 'radial-gradient(120% 100% at 50% 0%, rgba(56,189,248,0.20) 0%, rgba(10,11,16,0) 60%), linear-gradient(175deg, #0a1628 0%, #0d2233 50%, #071018 100%)' },
    { id: 'sunset', label: '暮色', css: 'radial-gradient(130% 100% at 80% 10%, rgba(251,146,60,0.22) 0%, rgba(236,72,153,0.14) 40%, rgba(10,11,16,0) 65%), linear-gradient(170deg, #1c1020 0%, #2a1420 50%, #0d0b13 100%)' },
    { id: 'midnight', label: '静谧黑', css: 'linear-gradient(165deg, #0c0d12 0%, #12141d 48%, #090a0f 100%)' },
  ];

  useEffect(() => {
    const saved = localStorage.getItem('aether_mobile_bg');
    if (saved) setBgImage(saved);
    const bgSourceSaved = localStorage.getItem('aether_mobile_bg_source');
    if (bgSourceSaved) setBgSource(bgSourceSaved as typeof bgSource);
    const enabled = localStorage.getItem('aether_glass_enabled') !== 'false';
    setGlassEnabled(enabled);
    const g = loadGlassFromStorage();
    setGlassBlur(g.blurRadius);
    setGlassSaturate(g.saturate);
    setGlassOpacity(g.vibrancyOpacity);
    applyGlassToCSS(g.blurRadius, g.saturate, g.vibrancyOpacity, enabled);
  }, []);

  // Q3：切换内置背景源（隐藏默认纯黑，提供多档渐变）
  const handleBgSource = (id: string) => {
    if (id === 'custom') return;
    const found = BUILTIN_BGS.find(b => b.id === id);
    if (!found) return;
    setBgSource(id as typeof bgSource);
    setBgImage(null);
    localStorage.removeItem('aether_mobile_bg');
    try { localStorage.setItem('aether_mobile_bg_source', id); } catch { /* ignore */ }
    // 直接设置 .app-layout 和 body 的背景，避免 CSS 变量 fallback 不生效的问题
    const bgValue = found.css;
    document.body.style.backgroundImage = bgValue;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
    const layout = document.querySelector('.app-layout') as HTMLElement | null;
    if (layout) {
      layout.style.backgroundImage = bgValue;
      layout.style.backgroundSize = 'cover';
      layout.style.backgroundPosition = 'center';
      layout.style.backgroundAttachment = 'fixed';
    }
  };

  const persistGlass = (blur: number, saturate: number, opacity: number, enabled: boolean) => {
    localStorage.setItem('aether_glass_effect', JSON.stringify({ blurRadius: blur, saturate, vibrancyOpacity: opacity }));
    localStorage.setItem('aether_glass_enabled', String(enabled));
    applyGlassToCSS(blur, saturate, opacity, enabled);
  };

  const handleBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // P0-5: 大小校验 — localStorage 上限约 5MB，控制 4MB 以内避免静默失败
    if (file.size > 4 * 1024 * 1024) {
      setBgMsg('⚠️ 图片过大（>4MB），请选择更小的图片');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setBgImage(dataUrl);
      setBgSource('custom');
      setBgMsg('');
      const bgValue = `url(${dataUrl})`;
      try {
        localStorage.setItem('aether_mobile_bg', dataUrl);
        localStorage.setItem('aether_mobile_bg_source', 'custom');
        // 直接设置 body 和 .app-layout 的 background-image（CSS 变量在某些 Android WebView 中可能不生效）
        document.body.style.backgroundImage = bgValue;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundAttachment = 'fixed';
        const layout = document.querySelector('.app-layout') as HTMLElement | null;
        if (layout) {
          layout.style.backgroundImage = bgValue;
          layout.style.backgroundSize = 'cover';
          layout.style.backgroundPosition = 'center';
          layout.style.backgroundAttachment = 'fixed';
        }
      } catch {
        setBgMsg('⚠️ 存储空间不足，请使用更小的图片');
        setBgImage((prev) => {
          if (prev) {
            document.body.style.backgroundImage = `url(${prev})`;
          }
          return prev;
        });
      }
    };
    reader.onerror = () => setBgMsg('⚠️ 图片读取失败，请重试');
    reader.readAsDataURL(file);
  };

  const handleRemoveBg = () => {
    setBgImage(null);
    localStorage.removeItem('aether_mobile_bg');
    // 恢复默认内置渐变
    document.body.style.backgroundImage = '';
    document.body.style.backgroundSize = '';
    document.body.style.backgroundPosition = '';
    document.body.style.backgroundAttachment = '';
    const layout = document.querySelector('.app-layout') as HTMLElement | null;
    if (layout) {
      layout.style.backgroundImage = '';
      layout.style.backgroundSize = '';
      layout.style.backgroundPosition = '';
      layout.style.backgroundAttachment = '';
    }
  };

  const handleToggleGlass = () => {
    const next = !glassEnabled;
    setGlassEnabled(next);
    persistGlass(glassBlur, glassSaturate, glassOpacity, next);
  };

  const handleBlur = (v: number) => { setGlassBlur(v); persistGlass(v, glassSaturate, glassOpacity, glassEnabled); };
  const handleSaturate = (v: number) => { setGlassSaturate(v); persistGlass(glassBlur, v, glassOpacity, glassEnabled); };
  const handleOpacity = (v: number) => { setGlassOpacity(v); persistGlass(glassBlur, glassSaturate, v, glassEnabled); };

  const handleReset = () => {
    setGlassBlur(DEFAULT_GLASS.blurRadius);
    setGlassSaturate(DEFAULT_GLASS.saturate);
    setGlassOpacity(DEFAULT_GLASS.vibrancyOpacity);
    setGlassEnabled(true);
    persistGlass(DEFAULT_GLASS.blurRadius, DEFAULT_GLASS.saturate, DEFAULT_GLASS.vibrancyOpacity, true);
  };

  // 滑块组件
  const Slider = ({ label, value, min, max, step, unit, onChange, disabled }: {
    label: string; value: number; min: number; max: number; step: number; unit: string;
    onChange: (v: number) => void; disabled?: boolean;
  }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
        <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        disabled={disabled}
        style={{
          width: '100%', height: 4, borderRadius: 2, appearance: 'none', outline: 'none',
          background: disabled ? 'var(--border)' : `linear-gradient(to right, var(--accent) ${((value - min) / (max - min)) * 100}%, var(--border) ${((value - min) / (max - min)) * 100}%)`,
        }}
      />
    </div>
  );

  return (
    <div className="app-layout">
      <div className="top-bar">
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 20, cursor: 'pointer', padding: 4 }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>外观设置</h1>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 40 }}>
        {/* 背景图片 */}
        <div className="glass-card" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>背景图片</h3>

          {/* Q3：内置背景源快速切换 */}
          <div style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>内置背景</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {BUILTIN_BGS.map(b => (
                <button
                  key={b.id}
                  onClick={() => handleBgSource(b.id)}
                  style={{
                    padding: '10px 12px', borderRadius: 10, fontSize: 12, cursor: 'pointer',
                    background: bgSource === b.id && !bgImage ? 'rgba(94,158,255,0.15)' : 'var(--bg-hover)',
                    border: `1px solid ${bgSource === b.id && !bgImage ? 'rgba(94,158,255,0.4)' : 'var(--border)'}`,
                    color: bgSource === b.id && !bgImage ? 'var(--accent)' : 'var(--text)',
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBgUpload} />
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-primary" style={{ flex: 1, padding: '12px 20px' }} onClick={() => fileInputRef.current?.click()}>
              上传背景
            </button>
            {bgImage && (
              <button onClick={handleRemoveBg} style={{ padding: '12px 16px', borderRadius: 12, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
                移除
              </button>
            )}
          </div>
          {bgImage && (
            <div style={{ marginTop: 12, padding: 4, borderRadius: 12, background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
              <img src={bgImage} alt="" style={{ width: '100%', maxHeight: 140, borderRadius: 8, objectFit: 'cover' }} />
            </div>
          )}
        </div>

        {/* 玻璃效果 */}
        <div className="glass-card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>玻璃效果</h3>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Apple Liquid Glass 风格</p>
            </div>
            <button
              onClick={handleToggleGlass}
              style={{
                width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer',
                background: glassEnabled ? 'var(--accent)' : 'var(--border)',
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 3, width: 20, height: 20, borderRadius: '50%',
                background: '#fff', transition: 'left 0.2s', left: glassEnabled ? 25 : 3,
              }} />
            </button>
          </div>
          <Slider label="模糊强度" value={glassBlur} min={0} max={40} step={1} unit="px" onChange={handleBlur} disabled={!glassEnabled} />
          <Slider label="色彩饱和度" value={glassSaturate} min={100} max={300} step={10} unit="%" onChange={handleSaturate} disabled={!glassEnabled} />
          <Slider label="透明度" value={Math.round(glassOpacity * 100)} min={0} max={20} step={1} unit="%" onChange={v => handleOpacity(v / 100)} disabled={!glassEnabled} />
          <button onClick={handleReset} style={{ marginTop: 8, background: 'none', border: 'none', color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: 0 }}>
            重置默认值
          </button>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 4 }}>
          设置自动保存，重启 App 不丢失
        </p>
      </div>
    </div>
  );
}