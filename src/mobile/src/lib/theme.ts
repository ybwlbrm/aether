// 浅色/深色主题机制：data-theme on <html>，默认跟随系统，手动选择持久化
export type ThemeMode = 'light' | 'dark';
const STORAGE_KEY = 'aether_mobile_theme';

export function getStoredTheme(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  // 同步浏览器 UI 与 meta theme-color（可选）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#0a0b10' : '#f5f5f7');
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
}

export function initTheme(): void {
  const stored = getStoredTheme();
  const mode: ThemeMode =
    stored ??
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(mode);
}
