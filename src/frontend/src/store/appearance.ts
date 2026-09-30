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

export const STORAGE_KEY = 'aether.appearance';

export const DEFAULT_MATERIAL: MaterialState = {
  mode: 'glass',
  intensity: 60,
  blur: 14,
  saturation: 130,
  brightness: 1.05,
  rim: 40,
};

export const DEFAULT_WALLPAPER: WallpaperState = {
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

/** 从旧 localStorage key 迁移一次（幂等：aether.appearance 已存在则直接返回 null） */
export function migrateLegacy(): Partial<AppearanceState> | null {
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

/**
 * 持久化快照形态：顶层字段可缺，material / wallpaper 子对象**也可缺字段** ——
 * 历史版本写进 localStorage 的 JSON 确实可能是半个子对象。
 */
export type AppearanceSnapshot = Omit<Partial<AppearanceState>, 'material' | 'wallpaper'> & {
  material?: Partial<MaterialState>;
  wallpaper?: Partial<WallpaperState>;
};

/**
 * T25b：把持久化快照与默认值**深合并**。
 *
 * 修复前的写法是
 *   `{ material: {...D, ...parsed.material}, wallpaper: {...D, ...parsed.wallpaper}, ...parsed }`
 * —— `...parsed` 在最后展开，会用快照里的 material / wallpaper 子对象
 * **整体覆盖**上面刚算好的深合并结果，使那两行成为死代码：任何非空快照
 * 都会带来一个字段可能缺失的子对象（例如旧版本只写过 { mode, blur }），
 * 于是 saturation / rim 等字段变成 undefined，CSS var 被写成 "undefined"。
 *
 * 正确顺序：先展开 parsed 铺平顶层标量，再让默认值参与子对象合并。
 */
export function mergeAppearanceSnapshot(parsed: AppearanceSnapshot): Partial<AppearanceState> {
  return {
    ...parsed,
    material: { ...DEFAULT_MATERIAL, ...(parsed.material ?? {}) },
    wallpaper: { ...DEFAULT_WALLPAPER, ...(parsed.wallpaper ?? {}) },
  };
}

/**
 * 解析 aether.appearance 的原始 JSON。抽出成独立函数以便单测直接验证
 * 「落盘 → 重新加载」这条真实加载路径（loadInitial 逐字复用它）。
 * 返回 null 表示该 key 缺失或 JSON 损坏 —— 调用方回退 migrateLegacy。
 */
export function parseAppearanceSnapshot(raw: string | null): Partial<AppearanceState> | null {
  if (!raw) return null;
  try {
    return mergeAppearanceSnapshot(JSON.parse(raw) as AppearanceSnapshot);
  } catch {
    return null;
  }
}

function loadInitial(): Partial<AppearanceState> {
  try {
    const parsed = parseAppearanceSnapshot(localStorage.getItem(STORAGE_KEY));
    if (parsed) return parsed;
  } catch {
    /* ignore - intentional */
  }
  // migrateLegacy 幂等性不变：aether.appearance 存在时已在上面 return，走不到这里
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

/**
 * 持久化（AppShell 订阅变化时调用）—— T26 显式字段白名单：原写法
 * `JSON.stringify(state)` 会把 9 个 action 枚举成 key（值 undefined 被丢弃）。
 * 只写回 loadInitial 会读回的状态字段。
 */
export function persistAppearance(state: AppearanceState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        colorScheme: state.colorScheme,
        uiTheme: state.uiTheme,
        material: { ...state.material },
        wallpaper: { ...state.wallpaper },
      } satisfies AppearanceSnapshot),
    );
  } catch {
    /* ignore - intentional */
  }
}
