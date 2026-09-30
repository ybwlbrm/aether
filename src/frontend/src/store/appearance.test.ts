import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATERIAL,
  DEFAULT_WALLPAPER,
  STORAGE_KEY,
  mergeAppearanceSnapshot,
  migrateLegacy,
  parseAppearanceSnapshot,
  persistAppearance,
  useAppearanceStore,
} from './appearance';

/**
 * T25b 回归测试：aether.appearance 的加载合并。
 *
 * 三个层面：
 *  1. 纯函数 mergeAppearanceSnapshot —— 锁住「store 默认值必须真正参与深合并」
 *     （修复前 ...parsed 在最后展开，使 L141-142 的深合并成为死代码）
 *  2. parseAppearanceSnapshot —— loadInitial 逐字复用的解析入口
 *  3. persist → parse 真实往返 + migrateLegacy 幂等
 */

function installStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  const stub = {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  return stub;
}

describe('mergeAppearanceSnapshot', () => {
  it('空快照返回完整默认值', () => {
    const merged = mergeAppearanceSnapshot({});
    expect(merged.material).toEqual(DEFAULT_MATERIAL);
    expect(merged.wallpaper).toEqual(DEFAULT_WALLPAPER);
  });

  it('部分 material 子对象仍补齐全部默认字段（修复前这些字段是 undefined）', () => {
    const merged = mergeAppearanceSnapshot({ material: { mode: 'opaque', blur: 22 } });
    expect(merged.material).toEqual({ ...DEFAULT_MATERIAL, mode: 'opaque', blur: 22 });
    expect(merged.material?.saturation).toBe(DEFAULT_MATERIAL.saturation);
    expect(merged.material?.intensity).toBe(DEFAULT_MATERIAL.intensity);
    expect(merged.material?.rim).toBe(DEFAULT_MATERIAL.rim);
    expect(merged.material?.brightness).toBe(DEFAULT_MATERIAL.brightness);
  });

  it('部分 wallpaper 子对象仍补齐全部默认字段', () => {
    const merged = mergeAppearanceSnapshot({ wallpaper: { source: 'upload', path: 'data:image/png;base64,AAAA' } });
    expect(merged.wallpaper).toEqual({
      ...DEFAULT_WALLPAPER,
      source: 'upload',
      path: 'data:image/png;base64,AAAA',
    });
  });

  it('顶层标量字段原样透传', () => {
    const merged = mergeAppearanceSnapshot({ colorScheme: 'light', uiTheme: 'geist' });
    expect(merged.colorScheme).toBe('light');
    expect(merged.uiTheme).toBe('geist');
  });
});

describe('parseAppearanceSnapshot', () => {
  it('key 缺失 / JSON 损坏时返回 null（调用方回退 migrateLegacy）', () => {
    expect(parseAppearanceSnapshot(null)).toBeNull();
    expect(parseAppearanceSnapshot('')).toBeNull();
    expect(parseAppearanceSnapshot('{not json')).toBeNull();
  });
});

describe('aether.appearance persist → 重新加载 往返', () => {
  it('改过 material + wallpaper 后落盘，再加载仍完好', () => {
    const storage = installStorage();

    const store = useAppearanceStore.getState();
    store.setMaterialMode('opaque');
    store.setMaterialParam('blur', 27);
    useAppearanceStore.getState().setColorScheme('light');
    useAppearanceStore.getState().setWallpaper({
      source: 'directory',
      activeItem: 'data:image/png;base64,BBBB',
      slideshow: true,
      interval: 12,
      overlay: 65,
    });
    persistAppearance(useAppearanceStore.getState());

    // 重新加载：走 loadInitial 用的同一个解析入口
    const restored = parseAppearanceSnapshot(storage.getItem(STORAGE_KEY));
    expect(restored).not.toBeNull();
    expect(restored?.colorScheme).toBe('light');
    expect(restored?.material).toEqual({ ...DEFAULT_MATERIAL, mode: 'opaque', blur: 27 });
    expect(restored?.wallpaper).toEqual({
      ...DEFAULT_WALLPAPER,
      source: 'directory',
      activeItem: 'data:image/png;base64,BBBB',
      slideshow: true,
      interval: 12,
      overlay: 65,
    });
  });

  it('历史版本的半截子对象快照不会产生 undefined 字段', () => {
    // 模拟旧版本写下的 aether.appearance：material / wallpaper 只留部分字段
    const raw = JSON.stringify({
      colorScheme: 'dark',
      uiTheme: 'liquid-glass',
      material: { mode: 'glass', blur: 20 },
      wallpaper: { source: 'upload', path: 'data:image/png;base64,CCCC' },
    });
    const restored = parseAppearanceSnapshot(raw);
    expect(restored?.material).toEqual({ ...DEFAULT_MATERIAL, blur: 20 });
    expect(restored?.wallpaper).toEqual({
      ...DEFAULT_WALLPAPER,
      source: 'upload',
      path: 'data:image/png;base64,CCCC',
    });
  });
});

describe('migrateLegacy 幂等性（T25b 未破坏）', () => {
  it('aether.appearance 存在时直接跳过，不读任何 legacy key', () => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify({ colorScheme: 'light', material: { mode: 'opaque' } }),
      glassEnabled: 'false',
      glassEffect: JSON.stringify({ blurRadius: 33, saturate: 155 }),
      customBg: 'data:image/png;base64,LEGACY',
    });
    expect(migrateLegacy()).toBeNull();
  });

  it('aether.appearance 缺失时迁移 legacy glassEffect / glassEnabled / customBg', () => {
    installStorage({
      glassEnabled: 'false',
      glassEffect: JSON.stringify({ blurRadius: 33, saturate: 155 }),
      customBg: 'data:image/png;base64,LEGACY',
    });
    const migrated = migrateLegacy();
    expect(migrated?.material).toEqual({ ...DEFAULT_MATERIAL, mode: 'opaque', blur: 33, saturation: 155 });
    expect(migrated?.wallpaper).toEqual({ ...DEFAULT_WALLPAPER, source: 'upload', path: 'data:image/png;base64,LEGACY' });
  });
});

/**
 * T26：persistAppearance 字段白名单。
 *
 * 修复前是 `JSON.stringify(state)` —— 9 个 action 函数被当作 key 枚举进落盘 JSON。
 * 断言写出的 payload 只含 4 个状态键，且顶层/子对象的键集合与 store 定义**不重叠**，
 * 这样任何人再往 AppearanceState 加 action 都会让本测试失败（防止白名单退化成全量序列化）。
 */
describe('persistAppearance 字段白名单（T26）', () => {
  const ACTION_KEYS = [
    'setColorScheme', 'setUiTheme', 'setMaterialMode', 'setMaterialParam',
    'resetMaterial', 'setWallpaper', 'resetWallpaper', 'toggleGlass', 'toggleSlideshow',
  ];

  it('写出的 payload 顶层键恰为 4 个状态字段，无任何函数键', () => {
    const storage = installStorage();
    persistAppearance(useAppearanceStore.getState());

    const raw = storage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw as string) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(['colorScheme', 'material', 'uiTheme', 'wallpaper']);
    for (const key of ACTION_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
    for (const value of Object.values(payload)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('material / wallpaper 子对象写全字段（不是半个子对象）', () => {
    const storage = installStorage();
    persistAppearance(useAppearanceStore.getState());

    const payload = JSON.parse(storage.getItem(STORAGE_KEY) as string) as {
      material: Record<string, unknown>;
      wallpaper: Record<string, unknown>;
    };
    // 比对键集合而非具体值：store 是模块单例，上面的往返测试已改过它的状态。
    expect(Object.keys(payload.material).sort()).toEqual(Object.keys(DEFAULT_MATERIAL).sort());
    expect(Object.keys(payload.wallpaper).sort()).toEqual(Object.keys(DEFAULT_WALLPAPER).sort());
  });

  it('往 AppearanceState 加 action 后本白名单不会把它们写出去', () => {
    // 直接对「多挂了几个函数的状态对象」调用 persist，锁住白名单是显式列举而非全量序列化
    const storage = installStorage();
    const polluted = {
      ...useAppearanceStore.getState(),
      brandNewAction: () => 'nope',
    };
    persistAppearance(polluted);

    const payload = JSON.parse(storage.getItem(STORAGE_KEY) as string) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('brandNewAction');
    expect(Object.keys(payload).sort()).toEqual(['colorScheme', 'material', 'uiTheme', 'wallpaper']);
  });
});
