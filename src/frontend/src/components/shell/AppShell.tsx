import { useEffect, type ReactNode } from 'react';
import { WallpaperLayer } from './WallpaperLayer';
import { Sidebar } from './Sidebar';
import { ContextBar } from './ContextBar';
import { ConversationsDrawer } from './ConversationsDrawer';
import { CommandPalette } from '../CommandPalette';
import { LiquidGlassFilter } from '../LiquidGlassFilter';
import { requestNotificationPermission } from '../../lib/notification-center';
import { useAppearanceStore, persistAppearance } from '../../store/appearance';
import { useWorkspaceStore, persistWorkspace, type WorkbenchTab } from '../../store/workspace';
import { subscribeAppEvent } from '../../lib/events';

/**
 * AppShell — 全 app **唯一**的 DOM 副作用归属者（T20）。
 *
 * 契约：`document.documentElement` 上 4 类写入只允许出现在本文件，逐字迁移自旧 Layout：
 *   1. colorScheme  → classList.add('dark') / data-theme 映射
 *   2. uiTheme      → setAttribute('data-theme')
 *   3. material     → setAttribute('data-material') + --glass-blur-radius / --glass-saturate / --glass-brightness
 *   4. sidebarMode  → setProperty('--sidebar-width')
 *
 * 其它组件（WallpaperLayer 只写 data-wallpaper / --wallpaper-scrim）不得再碰这些 token。
 *
 * 订阅策略：所有 store 读都走 selector（无裸 `useAppearanceStore()`），
 * 持久化走 `store.subscribe` —— 落盘不触发任何重渲染。
 *
 * 层级：Wallpaper → Liquid Glass 滤镜 → CommandPalette → Sidebar → 主列（ContextBar + children）
 */

/** sidebar 三态对应的 --sidebar-width；compact 与 Sidebar 的 COMPACT_WIDTH(48) 对齐 */
const SIDEBAR_WIDTHS = {
  expanded: '224px',
  compact: '48px',
  hidden: '0px',
} as const;

export function AppShell({ children }: { children: ReactNode }) {
  // ---- selector 订阅（窄切片，避免整 store 重渲染）----
  const colorScheme = useAppearanceStore((s) => s.colorScheme);
  const uiTheme = useAppearanceStore((s) => s.uiTheme);
  const material = useAppearanceStore((s) => s.material);
  const sidebarMode = useWorkspaceStore((s) => s.sidebarMode);

  // 首次访问请求通知权限
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // ============================================================
  // 写入类 1/2/3：colorScheme / uiTheme / material → DOM
  // ============================================================
  useEffect(() => {
    const root = document.documentElement;
    // shadcn 兼容：始终加 .dark class（修复白框历史问题）
    root.classList.add('dark');
    // data-theme：uiTheme 映射（liquid-glass 为默认 dark）
    if (colorScheme === 'light') {
      root.setAttribute('data-theme', 'light');
    } else if (uiTheme !== 'liquid-glass') {
      root.setAttribute('data-theme', uiTheme);
    } else {
      root.removeAttribute('data-theme');
    }
    // 材质开关
    root.setAttribute('data-material', material.mode);
    // Glass 参数（克制默认由 themes.css 保证，滑块可覆盖）
    root.style.setProperty('--glass-blur-radius', `${material.blur}px`);
    root.style.setProperty('--glass-saturate', `${material.saturation}%`);
    // 亮度单一 token：--glass-vibrancy-opacity 不再由运行时写入（见 WallpaperLayer）
    root.style.setProperty('--glass-brightness', String(material.brightness));
  }, [colorScheme, uiTheme, material]);

  // ============================================================
  // 写入类 4：sidebarMode → --sidebar-width
  // ============================================================
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--sidebar-width', SIDEBAR_WIDTHS[sidebarMode]);
  }, [sidebarMode]);

  // ============================================================
  // 持久化：subscribe 而非渲染期读，杜绝「落盘触发重渲染」
  // ============================================================
  useEffect(() => {
    persistAppearance(useAppearanceStore.getState());
    return useAppearanceStore.subscribe((state) => persistAppearance(state));
  }, []);

  useEffect(() => {
    persistWorkspace(useWorkspaceStore.getState());
    return useWorkspaceStore.subscribe((state) => persistWorkspace(state));
  }, []);

  // ============================================================
  // 常驻事件监听：workbench-open / workbench-toggle
  // Workbench 组件按 workbench.open 条件渲染，其内部 useEffect 监听器
  // 在关闭态未挂载 → 事件无人响应。移到 AppShell（常驻挂载）统一注册。
  // ============================================================
  useEffect(() => {
    const offOpen = subscribeAppEvent('workbench-open', (detail) => {
      const tab = (detail ?? {}) as { tab?: WorkbenchTab };
      useWorkspaceStore.getState().openWorkbench(tab.tab);
    });
    const offToggle = subscribeAppEvent('workbench-toggle', () => {
      useWorkspaceStore.getState().toggleWorkbench();
    });
    return () => {
      offOpen();
      offToggle();
    };
  }, []);

  const glassOn = material.mode === 'glass';

  return (
    <div
      className="aether-app min-h-screen"
      style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}
    >
      {/* Level 0 — Environment */}
      <WallpaperLayer />

      {/* Liquid Glass SVG 滤镜（Glass ON 时才挂载） */}
      {glassOn && <LiquidGlassFilter />}

      {/* Level 4 — Overlay */}
      <CommandPalette />

      {/* Level 1 — Shell: Sidebar */}
      {sidebarMode !== 'hidden' && <Sidebar />}

      {/* Level 1 — Shell: 内容区（ContextBar + Workspace） */}
      <div
        className="aether-main-col"
        style={{
          marginLeft: 'var(--sidebar-width)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          zIndex: 1,
          transition: 'margin-left 0.2s var(--anim-ease)',
        }}
      >
        <ContextBar />
        {children}
      </div>

      {/* Level 2 — 对话记录抽屉（全局可用，AppShell 内常驻） */}
      <ConversationsDrawer />
    </div>
  );
}
