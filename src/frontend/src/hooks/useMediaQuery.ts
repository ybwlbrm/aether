import { useCallback, useSyncExternalStore } from 'react';

/**
 * useMediaQuery — SSR 安全的媒体查询订阅（T20 响应式 Shell）。
 *
 * - SSR / Node 测试环境（`typeof window === 'undefined'`）→ 返回 SSR 快照（false），
 *   绝不触碰 `window.matchMedia`，因此 `renderToStaticMarkup` 不会炸。
 * - 浏览器环境 → 订阅 MediaQueryList 的 `change` 事件，视口变化即时更新。
 * - 老 Safari（无 addEventListener 的 MediaQueryList）回落到 addListener/removeListener。
 */

/** SSR 快照：无 window 时一律视为「不匹配」（桌面三栏的桌面态不参与服务端渲染） */
const SSR_SNAPSHOT = false;

/** 当前环境是否可用 matchMedia（SSR 下为 false） */
function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** 订阅指定 query 的匹配状态变化，返回取消订阅函数 */
function subscribeToQuery(query: string, onStoreChange: () => void): () => void {
  if (!canMatch()) return () => undefined;
  const list = window.matchMedia(query);
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onStoreChange);
    return () => list.removeEventListener('change', onStoreChange);
  }
  // 旧版浏览器只有已废弃的 addListener
  list.addListener(onStoreChange);
  return () => list.removeListener(onStoreChange);
}

export function useMediaQuery(query: string): boolean {
  // 只返回 boolean（原始值），因此快照天然稳定，React 不会判定为「每次渲染都变了」
  const getSnapshot = useCallback((): boolean => {
    if (!canMatch()) return SSR_SNAPSHOT;
    return window.matchMedia(query).matches;
  }, [query]);

  const getServerSnapshot = useCallback((): boolean => SSR_SNAPSHOT, []);

  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToQuery(query, onStoreChange),
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 桌面三栏断点：≥1024px 走 Sidebar | Main | Workbench 三栏 */
export const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';
