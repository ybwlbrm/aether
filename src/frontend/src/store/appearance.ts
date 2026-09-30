import { create } from 'zustand';

/**
 * Appearance Engine — 全局外观状态。
 *
 * 三个独立维度（spec §92/§93）：
 *   colorScheme : 'dark' | 'light'             —— 明暗
 *   material    : glass | opaque + 5 参数       —— 材质（Liquid Glass ON/OFF）
 *   wallpaper   : none | upload | directory     —— 环境层
 *
 * 兼容旧 localStorage key（uiTheme / glassEffect / glassEnabled / customBg），
 * 首次加载时迁移进新存储 aether.appearance。
 */

export type ColorScheme = 'dark' | 'light';
export type MaterialMode = 'glass' | 'opaque';
export type WallpaperSource = 'none' | 'upload' | 'directory';
export type UiTheme = 'liquid-glass' | 'shadcn' | 'geist' | 'magic' | 'origin' | 'dark-minimal' | 'light';
export type MaterialParam = 'intensity' | 'blur' | 'saturation' | 'brightness' | 'rim';

export interface MaterialState {
  mode: MaterialMode;
  /** 0-100，默认 60 —— 克制（spec §48） */
  intensity: number;
  /** 0-36px，默认 14 */
  blur: number;
  /** 100-160%，默认 130 */
  saturation: number;
  /** 0.95-1.15，默认 1.05 */
  brightness: number;
  /** 0-100，默认 40 */
  rim: number;
}

export interface WallpaperState {
  source: WallpaperSource;
  /** 上传模式：图片 URL / dataURL */
  path: string | null;
  /** 目录模式：当前激活项 */
  activeItem: string | null;
  slideshow: boolean;
  /** 秒 */
  interval: number;
  randomize: boolean;
  /** 50-150（百分比） */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 0-100（scrim 不透明度） */
  overlay: number;
  /** 0-36（壁纸模糊） */
  blur: number;
}

export interface AppearanceState {
  colorScheme: ColorScheme;
  uiTheme: UiTheme;
  material: MaterialState;
  wallpaper: WallpaperState;

  setColorScheme: (scheme: ColorScheme) => void;
  setUiTheme: (theme: UiTheme) => void;
  setMaterialMode: (mode: MaterialMode) => void;
  setMaterialParam: (key: MaterialParam, value: number) => void;
  resetMaterial: () => void;
  setWallpaper: (patch: Partial<WallpaperState>) => void;
  resetWallpaper: () => void;
  toggleGlass: () => void;
  toggleSlideshow: () => void;
}

const STORAGE_KEY = 'aether.appearance';

const DEFAULT_MATERIAL: MaterialState = {
  mode: 'glass',
  intensity: 60,
  blur: 14,
  saturation: 130,
  brightness: 1.05,
  rim: 40,
};

const DEFAULT_WALLPAPER: WallpaperState = {
  source: 'none',
  path: null,
  activeItem: null,
  slideshow: false,
  interval: 60,
  randomize: false,
  brightness: 100,
  contrast: 100,
  saturation: 100,
  overlay: 40,
  blur: 0,
};

/** 从旧 localStorage key 迁移一次（幂等） */
function migrateLegacy(): Partial<AppearanceState> | null {
  try {
    const legacy = localStorage.getItem('aether.appearance');
    if (legacy) return null;
    const migrated: Partial<AppearanceState> = {};
    const uiTheme = localStorage.getItem('uiTheme') as UiTheme | null;
    if (uiTheme && uiTheme !== 'liquid-glass') {
      migrated.uiTheme = uiTheme;
      migrated.colorScheme = uiTheme === 'light' ? 'light' : 'dark';
    }
    const glassEnabled = localStorage.getItem('glassEnabled');
    if (glassEnabled === 'false') {
      migrated.material = { ...DEFAULT_MATERIAL, mode: 'opaque' };
    }
    const glassEffect = localStorage.getItem('glassEffect');
    if (glassEffect) {
      const g = JSON.parse(glassEffect) as { blurRadius?: number; saturate?: number; vibrancyOpacity?: number };
      migrated.material = {
        ...(migrated.material ?? DEFAULT_MATERIAL),
        blur: typeof g.blurRadius === 'number' ? Math.max(0, Math.min(36, g.blurRadius)) : DEFAULT_MATERIAL.blur,
        saturation: typeof g.saturate === 'number' ? Math.max(100, Math.min(160, g.saturate)) : DEFAULT_MATERIAL.saturation,
      };
    }
    const customBg = localStorage.getItem('customBg');
    if (customBg) {
      migrated.wallpaper = {
        ...DEFAULT_WALLPAPER,
        source: 'upload',
        path: customBg,
      };
    }
    return migrated;
  } catch {
    return null;
  }
}

function loadInitial(): Partial<AppearanceState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppearanceState>;
      return {
        material: { ...DEFAULT_MATERIAL, ...(parsed.material ?? {}) },
        wallpaper: { ...DEFAULT_WALLPAPER, ...(parsed.wallpaper ?? {}) },
        ...parsed,
      };
    }
  } catch {
    /* ignore - intentional */
  }
  return migrateLegacy() ?? {};
}

const initial = loadInitial();

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  colorScheme: initial.colorScheme ?? 'dark',
  uiTheme: initial.uiTheme ?? 'liquid-glass',
  material: initial.material ?? DEFAULT_MATERIAL,
  wallpaper: initial.wallpaper ?? DEFAULT_WALLPAPER,

  setColorScheme: (colorScheme) => set({ colorScheme }),
  setUiTheme: (uiTheme) =>
    set({
      uiTheme,
      colorScheme: uiTheme === 'light' ? 'light' : 'dark',
    }),
  setMaterialMode: (mode) => set({ material: { ...get().material, mode } }),
  setMaterialParam: (key, value) => set({ material: { ...get().material, [key]: value } }),
  resetMaterial: () => set({ material: DEFAULT_MATERIAL }),
  setWallpaper: (patch) => set({ wallpaper: { ...get().wallpaper, ...patch } }),
  resetWallpaper: () => set({ wallpaper: DEFAULT_WALLPAPER }),
  toggleGlass: () =>
    set({
      material: {
        ...get().material,
        mode: get().material.mode === 'glass' ? 'opaque' : 'glass',
      },
    }),
  toggleSlideshow: () =>
    set({
      wallpaper: {
        ...get().wallpaper,
        slideshow: !get().wallpaper.slideshow,
      },
    }),
}));

/** 持久化（AppShell 订阅变化时调用） */
export function persistAppearance(state: AppearanceState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore - intentional */
  }
}
