import { useLocation } from 'react-router-dom';
import { Command, PanelRightOpen, PanelRightClose, Sun, Moon } from 'lucide-react';
import { useWorkspaceStore } from '../../store/workspace';
import { useAppearanceStore } from '../../store/appearance';

/**
 * ContextBar — 顶部上下文栏（spec §12/§58）。
 *
 * 不是 Navbar，而是"当前工作上下文"：
 *   左：Project / Conversation    中：run 状态    右：Workbench / Command / 主题
 * 保留拖拽区域（app-drag-region 在 App.tsx），交互控制需可点击（-webkit-app-region: no-drag）。
 */

const ROUTE_LABELS: Record<string, string> = {
  '/command-center': 'Home',
  '/dashboard': 'Home',
  '/chat': 'Chat',
  '/media': 'Media',
  '/documents': 'Documents',
  '/projects': 'Projects',
  '/library': 'Library',
  '/browser': 'Browser',
  '/settings': 'Settings',
  '/agent-settings': 'Agent',
  '/toolbox': 'Toolbox',
  '/search': 'Search',
  '/knowledge': 'Knowledge',
  '/vault': 'Vault',
  '/mcp': 'MCP',
  '/monitoring': 'Monitoring',
  '/selfcheck': 'Self Check',
  '/workflows': 'Workflows',
  '/terminal': 'Terminal',
  '/providers': 'Models',
};

export function ContextBar() {
  const location = useLocation();
  const workbench = useWorkspaceStore((s) => s.workbench);
  const toggleWorkbench = useWorkspaceStore((s) => s.toggleWorkbench);
  const openWorkbench = useWorkspaceStore((s) => s.openWorkbench);
  const colorScheme = useAppearanceStore((s) => s.colorScheme);
  const setColorScheme = useAppearanceStore((s) => s.setColorScheme);

  const label = ROUTE_LABELS[location.pathname] ?? 'Aether';

  const openPalette = () => {
    window.dispatchEvent(new CustomEvent('toggle-command-palette'));
  };

  const toggleTheme = () => {
    setColorScheme(colorScheme === 'dark' ? 'light' : 'dark');
  };

  // Electron 无边框窗口拖拽区域（React 19 类型未收录，Electron 专有属性豁免）
  const dragRegion = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragRegion = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  return (
    <header
      className="aether-context-bar"
      style={{
        ...dragRegion,
        height: 36,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        borderBottom: '1px solid var(--border-primary)',
        background: 'var(--surface-shell)',
        backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
        WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
        position: 'relative',
        zIndex: 30,
        userSelect: 'none',
      }}
    >
      {/* 左：当前工作上下文 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '0 1 auto', ...dragRegion }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </span>
        {workbench.open && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            · {workbench.activeTab}
          </span>
        )}
      </div>

      {/* 中：run 状态占位（由 Run 展示系统填充） */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
        <span
          data-testid="context-run-state"
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            whiteSpace: 'nowrap',
          }}
        >
          Ready
        </span>
      </div>

      {/* 右：操作 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...noDragRegion }}>
        {!workbench.open && (
          <button
            onClick={() => openWorkbench('browser')}
            title="Open Workbench"
            aria-label="Open Workbench"
            className="aether-ctx-btn"
          >
            <PanelRightOpen size={15} />
          </button>
        )}
        {workbench.open && (
          <button
            onClick={toggleWorkbench}
            title={workbench.open ? 'Close Workbench' : 'Open Workbench'}
            aria-label="Close Workbench"
            className="aether-ctx-btn"
          >
            <PanelRightClose size={15} />
          </button>
        )}
        <button onClick={openPalette} title="Command Palette (⌘K)" aria-label="Command Palette" className="aether-ctx-btn">
          <Command size={15} />
        </button>
        <button onClick={toggleTheme} title="Toggle Theme" aria-label="Toggle Theme" className="aether-ctx-btn">
          {colorScheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}
