/**
 * Sidebar — Codex 式桌面工作空间主导航（spec §10 / §11 / §88）。
 *
 * 设计契约（spec §11.2）：无卡片、无大圆角、无大面积 blur、无发光、无厚 border。
 * 一切视觉值均取自 styles/tokens.css + styles/themes.css 的语义 token，
 * 本文件不出现硬编码色值；仅有 4 个 spec 指定但 token 层尚未收录的尺寸以命名常量收敛。
 *
 * 状态来自 useWorkspaceStore.sidebarMode（由 AppShell 统一持久化）：
 *   expanded — 完整形态，宽度取 var(--sidebar-width)
 *   compact  — 仅图标，宽度 COMPACT_WIDTH
 *   hidden   — 本组件不渲染，由父组件决定挂载
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Code2,
  Command,
  Cpu,
  Diamond,
  Files,
  FolderKanban,
  Globe,
  House,
  Library,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelsTopLeft,
  PanelLeftOpen,
  Server,
  Settings,
  Terminal,
  Wrench,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useWorkspaceStore, type WorkbenchTab } from '../../store/workspace';

/* ------------------------------------------------------------------ *
 * Spec 尺寸常量（tokens.css 尚未收录，命名收敛避免散落魔法值）
 * ------------------------------------------------------------------ */

/** spec §11.2：品牌区高度，与窗口拖拽区（titlebar）对齐 */
const BRAND_BAR_HEIGHT = 72;
/** spec §11.2：compact 模式栏宽（--sidebar-width 仅描述 expanded） */
const COMPACT_WIDTH = 48;
/** spec §11.2：导航项 icon 尺寸 */
const NAV_ICON_SIZE = 16;
/** spec §11.2：active 态左侧 accent 竖条宽度 */
const ACTIVE_BAR_WIDTH = 2;
/** spec §11.2：分组标题大写字距 */
const GROUP_HEADER_TRACKING = '0.04em';

/* ------------------------------------------------------------------ *
 * 导航数据模型
 * ------------------------------------------------------------------ */

/**
 * 导航目标：路由跳转，或在当前页就地打开 Workbench 某个 tab（不换路由）。
 * 用可辨识联合而非 `path?` + `tab?`，让"到底跳不跳转"在类型层就是确定的。
 */
type NavTarget =
  | { readonly type: 'route'; readonly path: string }
  | { readonly type: 'workbench'; readonly tab: WorkbenchTab };

interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly target: NavTarget;
}

interface NavGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavItem[];
}

/** 6 个空间：HOME / RESOURCES / TOOLS / SYSTEM / SETTINGS（spec §10） */
const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'home',
    label: 'Home',
    items: [
      { id: 'home', label: 'Home', icon: House, target: { type: 'route', path: '/command-center' } },
      { id: 'chat', label: 'Chat', icon: MessageSquare, target: { type: 'route', path: '/chat' } },
      { id: 'work', label: 'Work', icon: PanelsTopLeft, target: { type: 'workbench', tab: 'browser' } },
    ],
  },
  {
    id: 'resources',
    label: 'Resources',
    items: [
      { id: 'projects', label: 'Projects', icon: FolderKanban, target: { type: 'route', path: '/projects' } },
      { id: 'files', label: 'Files', icon: Files, target: { type: 'workbench', tab: 'files' } },
      { id: 'knowledge', label: 'Knowledge', icon: BookOpen, target: { type: 'route', path: '/knowledge' } },
      { id: 'library', label: 'Library', icon: Library, target: { type: 'route', path: '/library' } },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    items: [
      { id: 'browser', label: 'Browser', icon: Globe, target: { type: 'route', path: '/browser' } },
      { id: 'terminal', label: 'Terminal', icon: Terminal, target: { type: 'route', path: '/terminal' } },
      { id: 'toolbox', label: 'Toolbox', icon: Wrench, target: { type: 'route', path: '/toolbox' } },
      { id: 'workflows', label: 'Workflows', icon: Workflow, target: { type: 'route', path: '/workflows' } },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'models', label: 'Models', icon: Cpu, target: { type: 'route', path: '/providers' } },
      { id: 'mcp', label: 'MCP', icon: Server, target: { type: 'route', path: '/mcp' } },
      { id: 'monitoring', label: 'Monitoring', icon: Activity, target: { type: 'route', path: '/monitoring' } },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      { id: 'settings', label: 'Settings', icon: Settings, target: { type: 'route', path: '/settings' } },
    ],
  },
];

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
  // 1px 发丝分隔线，非"厚 border"
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

const navStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  paddingTop: 'var(--space-3)',
  paddingBottom: 'var(--space-3)',
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-label)',
  fontWeight: 'var(--font-weight-medium)',
  lineHeight: 'var(--line-height-tight)',
  letterSpacing: GROUP_HEADER_TRACKING,
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
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
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: 'var(--btn-height)',
  padding: 0,
  border: 'none',
  borderRadius: 'var(--radius-control)',
  background: 'transparent',
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
  transition: 'background var(--anim-duration-fast) var(--anim-ease), color var(--anim-duration-fast) var(--anim-ease)',
};

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export function Sidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const sidebarMode = useWorkspaceStore((s) => s.sidebarMode);
  const setSidebarMode = useWorkspaceStore((s) => s.setSidebarMode);
  const workbenchOpen = useWorkspaceStore((s) => s.workbench.open);
  const workbenchTab = useWorkspaceStore((s) => s.workbench.activeTab);

  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }, []);

  const handleItemClick = useCallback(
    (item: NavItem) => {
      if (item.target.type === 'workbench') {
        // Work / Files：在当前页就地打开 Workbench，不换路由
        useWorkspaceStore.getState().openWorkbench(item.target.tab);
        return;
      }
      navigate(item.target.path);
    },
    [navigate],
  );

  const isItemActive = useCallback(
    (item: NavItem): boolean => {
      if (item.target.type === 'workbench') {
        return workbenchOpen && workbenchTab === item.target.tab;
      }
      return pathname === item.target.path;
    },
    [pathname, workbenchOpen, workbenchTab],
  );

  // hidden：整栏不渲染（AppShell 负责其余布局与内容区偏移）
  if (sidebarMode === 'hidden') return null;

  const compact = sidebarMode === 'compact';

  return (
    <aside
      data-sidebar-mode={sidebarMode}
      aria-label="Primary"
      style={{
        ...asideStyle,
        width: compact ? COMPACT_WIDTH : 'var(--sidebar-width)',
      }}
    >
      {/* ---------- 品牌区 ---------- */}
      <div style={brandBarStyle}>
        {compact ? (
          <Diamond
            size={NAV_ICON_SIZE}
            strokeWidth={1.75}
            style={{ color: 'var(--accent-brand)', margin: '0 auto', flexShrink: 0 }}
            aria-label="Aether"
          />
        ) : (
          <>
            <Diamond
              size={NAV_ICON_SIZE + 2}
              strokeWidth={1.75}
              style={{ color: 'var(--accent-brand)', flexShrink: 0 }}
              aria-hidden="true"
            />
            <span
              style={{
                fontSize: 'var(--font-size-caption)',
                fontWeight: 'var(--font-weight-semibold)',
                lineHeight: 'var(--line-height-tight)',
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              Aether
            </span>
          </>
        )}
      </div>

      {/* ---------- 导航 ---------- */}
      <nav style={navStyle} aria-label="Workspace">
        {NAV_GROUPS.map((group) => (
          <section
            key={group.id}
            style={{ padding: '0 var(--space-2)', marginBottom: 'var(--space-4)' }}
          >
            {/* spec §11.2：分组标题常驻展开，无 chevron 折叠 */}
            {compact ? (
              <div
                aria-hidden="true"
                style={{
                  ...groupLabelStyle,
                  height: 'var(--space-4)',
                  marginBottom: 'var(--space-1)',
                }}
              />
            ) : (
              <h2
                style={{
                  ...groupLabelStyle,
                  margin: 0,
                  padding: '0 var(--space-3)',
                  marginBottom: 'var(--space-2)',
                }}
              >
                {group.label}
              </h2>
            )}

            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: compact ? '2px' : 'var(--space-1)',
              }}
            >
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isItemActive(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => handleItemClick(item)}
                      title={compact ? item.label : undefined}
                      aria-label={compact ? item.label : undefined}
                      aria-current={active ? 'page' : undefined}
                      className="nav-item"
                      style={{
                        justifyContent: compact ? 'center' : 'flex-start',
                        padding: compact ? 0 : '0 var(--space-3)',
                        fontSize: 'var(--font-size-caption)',
                        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontWeight: active ? 'var(--font-weight-medium)' : 'var(--font-weight-normal)',
                        background: active ? 'var(--sidebar-item-active)' : 'transparent',
                        // active 态左侧 2px accent 竖条（inset box-shadow，不额外占位）
                        boxShadow: active
                          ? `inset ${ACTIVE_BAR_WIDTH}px 0 0 var(--color-accent)`
                          : 'none',
                      }}
                    >
                      <Icon
                        size={NAV_ICON_SIZE}
                        strokeWidth={active ? 2 : 1.75}
                        style={{ flexShrink: 0 }}
                        aria-hidden="true"
                      />
                      {!compact && <span className="truncate">{item.label}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>

      {/* ---------- 底部工具区 ---------- */}
      <div style={footerStyle}>
        {/* ⌘K —— CommandPalette 改为受控，改为事件触发 */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('toggle-command-palette'))}
          className="nav-item"
          title={compact ? 'Command palette' : undefined}
          aria-label="打开命令面板"
          style={{
            justifyContent: compact ? 'center' : 'flex-start',
            padding: compact ? 0 : '0 var(--space-3)',
            fontSize: 'var(--font-size-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          <Command size={NAV_ICON_SIZE} strokeWidth={1.75} style={{ flexShrink: 0 }} aria-hidden="true" />
          {!compact && (
            <>
              <span className="truncate" style={{ flex: 1, textAlign: 'left' }}>
                Search commands
              </span>
              <kbd style={kbdStyle}>⌘K</kbd>
            </>
          )}
        </button>

        {compact && (
          <button
            type="button"
            onClick={() => setSidebarMode('expanded')}
            style={utilityButtonStyle}
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            <PanelLeftOpen size={NAV_ICON_SIZE} strokeWidth={1.75} style={{ margin: '0 auto' }} aria-hidden="true" />
          </button>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            marginTop: 'var(--space-1)',
          }}
        >
          {/* UI 模式切换：去掉视觉强调，仅留低调 Code2 图标 */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('toggle-ui-mode'))}
            style={utilityButtonStyle}
            title="切换界面模式"
            aria-label="切换界面模式"
          >
            <Code2
              size={NAV_ICON_SIZE}
              strokeWidth={1.75}
              style={{ margin: compact ? '0 auto' : 0, flexShrink: 0 }}
              aria-hidden="true"
            />
            {!compact && (
              <span
                className="truncate"
                style={{ marginLeft: 'var(--space-3)', fontSize: 'var(--font-size-caption)' }}
              >
                Mode
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            style={{ ...utilityButtonStyle, width: 'auto', flex: 1, paddingInline: compact ? 0 : 'var(--space-3)' }}
            title={isFullscreen ? '退出全屏' : '全屏'}
            aria-label={isFullscreen ? '退出全屏' : '全屏'}
          >
            {isFullscreen ? (
              <Minimize2 size={NAV_ICON_SIZE} strokeWidth={1.75} style={{ flexShrink: 0 }} aria-hidden="true" />
            ) : (
              <Maximize2 size={NAV_ICON_SIZE} strokeWidth={1.75} style={{ flexShrink: 0 }} aria-hidden="true" />
            )}
            {!compact && (
              <span
                className="truncate"
                style={{ marginLeft: 'var(--space-3)', fontSize: 'var(--font-size-caption)' }}
              >
                {isFullscreen ? '退出全屏' : '全屏'}
              </span>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
