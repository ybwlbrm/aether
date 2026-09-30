import { useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { Maximize2, Minimize2, Pin, X } from 'lucide-react';
import { WORKBENCH_TABS } from '../workbench/tabs';
import { WorkbenchPanel } from '../workbench/WorkbenchPanel';
import { DESKTOP_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useWorkspaceStore, type WorkbenchTab } from '../../store/workspace';

/**
 * Workbench — 右侧工作台的**外壳**（spec §16-18/§22-23）。
 * Main（思考） | Workbench（执行：Browser/Code/Files/Terminal/Preview）
 *
 * 本文件只负责外壳：拖拽调宽、tab bar、pin / maximize / close、状态条、window 事件
 * 联动。五个面板的内容已迁到 `components/workbench/`（`WorkbenchPanel` + `tabs/*`），
 * 那里消费 T21 的真实数据 hook —— 本文件不再持有任何面板骨架或示例数据。
 * 视觉遵循 spec §16.2/§69（无渐变/发光/shimmer，颜色全走 CSS 变量）；宽度与 maximized
 * 占位由 WorkspaceFrame 负责。
 */

/** Tab bar 高度（spec：40px）与拖拽热区宽度 */
const TAB_BAR_HEIGHT = 40;
const RESIZE_HANDLE_WIDTH = 4;

/** 通用小图标按钮（tab bar 右侧操作区） */
const iconBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  padding: 0,
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  transition: 'background var(--anim-duration-fast) var(--anim-ease), color var(--anim-duration-fast) var(--anim-ease)',
} as const;

export function Workbench() {
  const workbench = useWorkspaceStore((s) => s.workbench);
  const setWorkbenchTab = useWorkspaceStore((s) => s.setWorkbenchTab);
  const setWorkbenchWidth = useWorkspaceStore((s) => s.setWorkbenchWidth);
  const toggleWorkbenchPin = useWorkspaceStore((s) => s.toggleWorkbenchPin);
  const toggleWorkbenchMaximize = useWorkspaceStore((s) => s.toggleWorkbenchMaximize);
  const closeWorkbench = useWorkspaceStore((s) => s.closeWorkbench);
  // 桌面走右侧一栏，窄屏由 WorkspaceFrame 渲染成底部 sheet —— 面板据此选呈现形态
  const isDesktop = useMediaQuery(DESKTOP_MEDIA_QUERY);

  /* 拖拽调整宽度：Workbench 贴右边缘，向左拖 = 变宽（store 内部已 clamp 到 320-960） */
  const startResize = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = workbench.width;

      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        setWorkbenchWidth(startWidth + delta);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      // 拖拽期间锁定光标与文本选中，避免误选内容
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [workbench.width, setWorkbenchWidth],
  );

  // 关闭态：由 WorkspaceFrame 控制挂载，这里兜底返回 null
  if (!workbench.open) return null;

  return (
    <div
      className="aether-workbench"
      data-active-tab={workbench.activeTab}
      data-maximized={workbench.maximized || undefined}
      data-pinned={workbench.pinned || undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        background: 'var(--surface-shell)',
        borderLeft: '1px solid var(--border-primary)',
        fontSize: 'var(--font-size-caption)',
        color: 'var(--text-primary)',
      }}
    >
      {/* 左侧拖拽热区（col-resize） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workbench"
        onMouseDown={startResize}
        style={{
          position: 'absolute',
          left: -RESIZE_HANDLE_WIDTH / 2,
          top: 0,
          bottom: 0,
          width: RESIZE_HANDLE_WIDTH,
          cursor: 'col-resize',
          zIndex: 2,
          background: 'transparent',
          transition: 'background var(--anim-duration-fast) var(--anim-ease)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-accent)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      />

      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Workbench tabs"
        style={{
          display: 'flex',
          alignItems: 'stretch',
          flex: '0 0 auto',
          height: TAB_BAR_HEIGHT,
          borderBottom: '1px solid var(--border-primary)',
          background: 'var(--surface-shell)',
        }}
      >
        {WORKBENCH_TABS.map(({ id, label, Icon }) => {
          const active = workbench.activeTab === id;
          return (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={active}
              title={label}
              onClick={() => setWorkbenchTab(id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                height: '100%',
                padding: '0 var(--space-3)',
                border: 'none',
                borderBottom: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
                background: active ? 'var(--sidebar-item-active)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 'var(--font-size-caption)',
                fontWeight: active ? 'var(--font-weight-medium)' : 'var(--font-weight-normal)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'background var(--anim-duration-fast) var(--anim-ease), color var(--anim-duration-fast) var(--anim-ease)',
              }}
            >
              <Icon size={14} aria-hidden="true" style={{ flex: '0 0 auto' }} />
              {label}
            </button>
          );
        })}

        {/* 右侧：Pin / Maximize / Close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto', paddingRight: 'var(--space-2)' }}>
          <button
            type="button"
            onClick={toggleWorkbenchPin}
            title={workbench.pinned ? 'Unpin Workbench' : 'Pin Workbench'}
            aria-label={workbench.pinned ? 'Unpin Workbench' : 'Pin Workbench'}
            aria-pressed={workbench.pinned}
            style={{ ...iconBtnStyle, color: workbench.pinned ? 'var(--color-accent)' : 'var(--text-secondary)' }}
          >
            <Pin size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={toggleWorkbenchMaximize}
            title={workbench.maximized ? 'Restore Workbench' : 'Maximize Workbench'}
            aria-label={workbench.maximized ? 'Restore Workbench' : 'Maximize Workbench'}
            style={iconBtnStyle}
          >
            {workbench.maximized ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={closeWorkbench}
            title="Close Workbench"
            aria-label="Close Workbench"
            style={iconBtnStyle}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* 内容区：surface-content 透明背景，面板内容由 components/workbench 负责 */}
      <div
        role="tabpanel"
        aria-label={workbench.activeTab}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
          background: 'var(--surface-content)' }}
      >
        <WorkbenchPanel activeTab={workbench.activeTab} variant={isDesktop ? 'column' : 'sheet'} />
      </div>

      {/* 底部状态条（预留：显示 agent 活动，当前为空） */}
      <div
        data-slot="workbench-statusbar"
        style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto', gap: 'var(--space-3)',
          height: 26, padding: '0 var(--space-3)', borderTop: '1px solid var(--border-primary)',
          background: 'var(--surface-shell)', fontSize: 'var(--font-size-label)', color: 'var(--text-tertiary)' }}
      />
    </div>
  );
}
