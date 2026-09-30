/**
 * T21 `useWorkbenchBrowser` —— Browser 面板：地址判定 + 本地导航栈 + iframe 取址。
 *
 * ## 安全不变量（唯一硬约束）
 * `iframeSrc` 只能来自 T4 `lib/url.ts` 的 `normalizeUrl`，它只放行 http/https：
 * `javascript:` / `data:` / `file:` 一律返回 null。因此**无论输入什么，
 * iframe 的 src 都不可能是可执行协议**。被拒的输入不改动 iframeSrc（保留上一张页面），
 * 只把 `blocked` 置位让 UI 提示。
 *
 * ## 为什么拆成 session + hook
 * 本仓库没有 DOM 测试环境，组件测试走 `react-dom/server` 静态渲染（不执行 effect）。
 * 导航栈是有状态的纯逻辑，因此落在一层可独立驱动的 `createBrowserSession` 上，
 * hook 只负责接到 `useSyncExternalStore`。见 useWorkbenchBrowser.test.ts。
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { normalizeUrl } from '../../lib/url';

/** reload 用的缓存破坏参数名（目标站点会看到它 —— 这是强制重载文档的可靠办法）。 */
export const RELOAD_PARAM = '_aetherReload';

export interface BrowserInput {
  /** 可交给 iframe 的 href；非 URL-like（含 javascript:/data:/file:）为 null */
  readonly href: string | null;
  /** 输入非空却不是可加载网址 —— UI 应给提示 */
  readonly blocked: boolean;
}

export interface BrowserSnapshot {
  /** 地址栏草稿（用户原文，未规范化） */
  readonly url: string;
  /** 规范化后的安全 href；尚无可加载页面时为 null */
  readonly iframeSrc: string | null;
  readonly blocked: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface BrowserSession {
  getSnapshot: () => BrowserSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** 提交地址栏输入：URL-like 即导航，否则只置 blocked（不动 iframeSrc） */
  setUrl: (input: string) => void;
  back: () => void;
  forward: () => void;
  /** 重新加载当前文档（改变 iframeSrc 以强制 iframe 重挂） */
  reload: () => void;
}

export interface UseWorkbenchBrowserResult extends BrowserSnapshot {
  setUrl: (input: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
}

/** 会话内部状态（与渲染快照分开：快照是它的纯函数投影）。 */
interface SessionState {
  /** 地址栏草稿 */
  readonly draft: string;
  /** 已导航过的规范化 href（栈底在前） */
  readonly entries: readonly string[];
  /** entries 中的当前位置；-1 = 还没导航过 */
  readonly cursor: number;
  /** reload 计数（0 = 首次加载，href 原样使用） */
  readonly reloadToken: number;
  readonly blocked: boolean;
}

/** 判定完全委托 T4：这里不写任何协议白名单。 */
export function resolveBrowserInput(input: string): BrowserInput {
  const href = normalizeUrl(input);
  if (href !== null) return { href, blocked: false };
  return { href: null, blocked: input.trim() !== '' };
}

/** reload 的 href：首帧原样返回，之后在查询串上追加递增的缓存破坏参数。 */
function withReloadToken(href: string, token: number): string {
  if (token === 0) return href;
  const url = new URL(href);
  url.searchParams.set(RELOAD_PARAM, String(token));
  return url.href;
}

function snapshotOf(state: SessionState): BrowserSnapshot {
  const current = state.entries[state.cursor];
  return {
    url: state.draft,
    iframeSrc: current === undefined ? null : withReloadToken(current, state.reloadToken),
    blocked: state.blocked,
    canGoBack: state.cursor > 0,
    canGoForward: state.cursor >= 0 && state.cursor < state.entries.length - 1,
  };
}

function isSameSnapshot(a: BrowserSnapshot, b: BrowserSnapshot): boolean {
  return (
    a.url === b.url &&
    a.iframeSrc === b.iframeSrc &&
    a.blocked === b.blocked &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward
  );
}

/** 建立一条浏览器会话：导航栈 + reload 计数 + 订阅。`initialUrl` 非 URL-like 时不导航。 */
export function createBrowserSession(initialUrl = ''): BrowserSession {
  const listeners = new Set<() => void>();
  const seed = resolveBrowserInput(initialUrl);
  let state: SessionState = {
    draft: initialUrl,
    entries: seed.href === null ? [] : [seed.href],
    cursor: seed.href === null ? -1 : 0,
    reloadToken: 0,
    blocked: seed.blocked,
  };
  let snapshot = snapshotOf(state);

  /** `useSyncExternalStore` 要求 getSnapshot 引用稳定：值不变就不产生新对象、不通知。 */
  const commit = (next: SessionState): void => {
    const merged = snapshotOf(next);
    if (isSameSnapshot(snapshot, merged)) return;
    state = next;
    snapshot = merged;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,

    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    setUrl: (input: string) => {
      const { href, blocked } = resolveBrowserInput(input);
      if (href === null) {
        // 非 URL-like（含 javascript:）：只提示，不动已加载的页面
        commit({ ...state, draft: input, blocked });
        return;
      }
      if (href === state.entries[state.cursor]) {
        // 同一地址重复提交：不产生历史条目，只把地址栏文案纠正为规范化结果
        commit({ ...state, draft: input, blocked: false });
        return;
      }
      commit({
        ...state,
        draft: input,
        entries: [...state.entries.slice(0, state.cursor + 1), href],
        cursor: state.cursor + 1,
        reloadToken: 0,
        blocked: false,
      });
    },

    back: () => {
      if (state.cursor <= 0) return;
      const cursor = state.cursor - 1;
      commit({ ...state, draft: state.entries[cursor] ?? '', cursor, reloadToken: 0, blocked: false });
    },

    forward: () => {
      if (state.cursor < 0 || state.cursor >= state.entries.length - 1) return;
      const cursor = state.cursor + 1;
      commit({ ...state, draft: state.entries[cursor] ?? '', cursor, reloadToken: 0, blocked: false });
    },

    reload: () => {
      commit({ ...state, reloadToken: state.reloadToken + 1 });
    },
  };
}

/**
 * Browser 面板数据。
 *
 * `initialUrl` 只在**挂载时**生效（缺省为空地址栏，**不预置任何示例站点**）；
 * 运行期换地址请调 `setUrl`。reload 改的是 iframeSrc 上的缓存破坏参数，
 * 因此 iframe 会重新挂载并重取文档。
 */
export function useWorkbenchBrowser(initialUrl = ''): UseWorkbenchBrowserResult {
  const [session] = useState<BrowserSession>(() => createBrowserSession(initialUrl));

  const subscribe = useCallback(
    (listener: () => void): (() => void) => session.subscribe(listener),
    [session],
  );
  const getSnapshot = useCallback((): BrowserSnapshot => session.getSnapshot(), [session]);
  const { url, iframeSrc, blocked, canGoBack, canGoForward } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  return useMemo(
    () => ({
      url,
      iframeSrc,
      blocked,
      canGoBack,
      canGoForward,
      setUrl: session.setUrl,
      back: session.back,
      forward: session.forward,
      reload: session.reload,
    }),
    [url, iframeSrc, blocked, canGoBack, canGoForward, session],
  );
}
