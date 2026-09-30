/**
 * Sidebar —— Codex 式桌面工作空间主导航（T19）。
 *
 * 导航数据**全部**来自 `components/navigation`（NavModel 单一注册表）：
 * 本文件不含任何分组 / 标签 / 路由表，只负责壳层几何、模式切换与底部动作。
 *
 * 设计契约（spec §11.2）：无卡片、无大圆角、无 blur、无发光、无厚 border。
 * 视觉值取自 styles/tokens.css + styles/themes.css 的语义 token；
 * 只有 spec 指定但 token 层未收录的尺寸以命名常量收敛。
 *
 * 三种模式（useWorkspaceStore.sidebarMode，由 AppShell 统一持久化）：
 *   expanded — 完整形态，宽度 var(--sidebar-width)
 *   compact  — 仅图标，宽度 COMPACT_WIDTH
 *   hidden   — 本组件不渲染
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Code2,
  Command,
  Diamond,
  ListTree,
  Maximize2,
  Minimize2,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';
import { NavSurfaceList, runNavActionById, type NavSidebarSurface } from '../navigation';
import { ActiveRunSwitcher } from './ActiveRunSwitcher';
import { dispatchAppEvent } from '../../lib/events';
import { useWorkspaceStore } from '../../store/workspace';

/* ------------------------------------------------------------------ *
 * Spec 尺寸常量（tokens.css 尚未收录，命名收敛避免散落魔法值）
 * ------------------------------------------------------------------ */

/** spec §11.2：品牌区高度，与窗口拖拽区（titlebar）对齐 */
const BRAND_BAR_HEIGHT = 72;
/** spec §11.2：compact 模式栏宽（--sidebar-width 仅描述 expanded） */
const COMPACT_WIDTH = 48;
/** spec §11.2：导航项 icon 尺寸 */
const NAV_ICON_SIZE = 16;

/* ------------------------------------------------------------------ *
 * 局部样式（全部由 token 驱动，无硬编码色值）
 * ------------------------------------------------------------------ */

const asideStyle: React.CSSProperties = {
  position: 'fixed',
  left: 0,
  top: 0,
  bottom: 0,
  zIndex: 'var(--z-sidebar)',
  display: 'flex',
  flexDirection: 'column',
  // Codex 式实底，不使用 .sidebar-glass（无 backdrop-filter）
  background: 'var(--sidebar-bg)',
  borderRight: 'var(--border-width-hairline) solid var(--border-subtle)',
  transition: 'width var(--anim-duration) var(--anim-ease)',
};

const brandBarStyle: React.CSSProperties = {
  height: BRAND_BAR_HEIGHT,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  padding: '0 var(--space-4)',
  borderBottom: 'var(--border-width-hairline) solid var(--border-subtle)',
};

const brandNameStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-caption)',
  fontWeight: 'var(--font-weight-semibold)',
  lineHeight: 'var(--line-height-tight)',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const footerStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  padding: 'var(--space-2)',
  borderTop: 'var(--border-width-hairline) solid var(--border-subtle)',
};

const kbdStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-label)',
  lineHeight: 1,
  color: 'var(--text-tertiary)',
  background: 'var(--surface-hover)',
  border: 'var(--border-width-hairline) solid var(--border-subtle)',
  borderRadius: 'var(--radius-subtle)',
  padding: '3px 5px',
  fontFamily: 'var(--font-family-mono)',
};

/** 底部低调图标按钮：与导航项同一几何，仅去文字 */
const utilityButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: 'var(--btn-height)',
  gap: 'var(--space-3)',
  padding: 0,
  border: 'none',
  borderRadius: 'var(--radius-control)',
  background: 'transparent',
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
  fontSize: 'var(--font-size-caption)',
  transition: 'background var(--anim-duration-fast) var(--anim-ease), color var(--anim-duration-fast) var(--anim-ease)',
};

/* ------------------------------------------------------------------ *
 * 底部动作按钮
 * ------------------------------------------------------------------ */

interface FooterActionProps {
  readonly icon: LucideIcon
  readonly label: string
  readonly compact: boolean
  readonly onClick: () => void
  readonly trailing?: React.ReactNode
}

function FooterAction({ icon: Icon, label, compact, onClick, trailing }: FooterActionProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={compact ? { ...utilityButtonStyle, justifyContent: 'center' } : utilityButtonStyle}
      title={label}
      aria-label={label}
    >
      <Icon size={NAV_ICON_SIZE} strokeWidth={1.75} style={{ flexShrink: 0 }} aria-hidden="true" />
      {!compact && <span className="truncate">{label}</span>}
      {!compact && trailing}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export function Sidebar(): React.ReactElement | null {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const sidebarMode = useWorkspaceStore((s) => s.sidebarMode);
  const setSidebarMode = useWorkspaceStore((s) => s.setSidebarMode);
  const workbench = useWorkspaceStore((s) => s.workbench);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const compact = sidebarMode === 'compact';

  const activate = useCallback(
    (surface: NavSidebarSurface) => {
      // 穷尽匹配：NavSidebarSurface 新增变体时 tsc 在此报错
      switch (surface.surfaceKind) {
        case 'route':
          navigate(surface.path);
          return;
        case 'workbench':
          useWorkspaceStore.getState().openWorkbench(surface.workbenchTab);
      }
    },
    [navigate],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }, []);

  // ⌘K 与「More surfaces」都开 Command Palette；后者面向 secondary 表面（getSecondarySurfaces）
  const openPalette = useCallback(() => dispatchAppEvent('toggle-command-palette'), []);

  // 真实 setter 接线：app store 的 toggleUiMode（normal ⇄ coding，并写 localStorage）
  const toggleUiMode = useCallback(() => runNavActionById('action:ui-mode'), []);

  // hidden：整栏不渲染（AppShell 负责其余布局与内容区偏移）
  if (sidebarMode === 'hidden') return null;

  return (
    <aside
      data-sidebar-mode={sidebarMode}
      aria-label="Primary"
      style={{ ...asideStyle, width: compact ? COMPACT_WIDTH : 'var(--sidebar-width)' }}
    >
      {/* ---------- 品牌区 ---------- */}
      <div style={brandBarStyle}>
        <Diamond
          size={compact ? NAV_ICON_SIZE : NAV_ICON_SIZE + 2}
          strokeWidth={1.75}
          style={{ color: 'var(--accent-brand)', flexShrink: 0, margin: compact ? '0 auto' : undefined }}
          aria-hidden="true"
        />
        {!compact && <span style={brandNameStyle}>Aether</span>}
      </div>

      {/* ---------- 导航（数据源：NavModel）---------- */}
      <NavSurfaceList
        compact={compact}
        activePath={pathname}
        workbench={{ open: workbench.open, activeTab: workbench.activeTab }}
        activate={activate}
        leading={<ActiveRunSwitcher compact={compact} />}
      />

      {/* ---------- 底部工具区 ---------- */}
      <div style={footerStyle}>
        <FooterAction
          icon={Command}
          label="Search commands"
          compact={compact}
          onClick={openPalette}
          trailing={<kbd style={kbdStyle}>⌘K</kbd>}
        />
        <FooterAction icon={ListTree} label="More surfaces" compact={compact} onClick={openPalette} />
        {compact && (
          <FooterAction icon={PanelLeftOpen} label="展开侧边栏" compact onClick={() => setSidebarMode('expanded')} />
        )}
        <FooterAction icon={Code2} label="切换界面模式" compact={compact} onClick={toggleUiMode} />
        <FooterAction
          icon={isFullscreen ? Minimize2 : Maximize2}
          label={isFullscreen ? '退出全屏' : '全屏'}
          compact={compact}
          onClick={toggleFullscreen}
        />
      </div>
    </aside>
  );
}
