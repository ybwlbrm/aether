import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { Code2, Eye, FolderOpen, Globe, Maximize2, Minimize2, Pin, Terminal, X } from 'lucide-react';
import { useWorkspaceStore, type WorkbenchTab } from '../../store/workspace';

/**
 * Workbench — 右侧工作台（spec §16-18/§22-23）。
 *
 *   Main（思考） | Workbench（执行：Browser/Code/Files/Terminal/Preview）
 *
 * 本次仅交付框架（tab bar / 拖拽调宽 / 面板骨架），各面板内容后续填充。
 * 视觉遵循 spec §16.2/§69：安静克制 —— 无渐变、无发光、无 shimmer，
 * 所有颜色走 CSS 变量，字体 13-14px，Tab 高 40px。
 *
 * 层级说明：宽度 / 左边框 / maximized 占位由父组件 WorkspaceFrame 负责，
 * 本组件只负责自身内容与根节点状态标记。
 */

/** Tab 定义：图标 + label + id（顺序即展示顺序） */
const TABS: ReadonlyArray<{ id: WorkbenchTab; label: string; Icon: typeof Globe }> = [
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'code', label: 'Code', Icon: Code2 },
  { id: 'files', label: 'Files', Icon: FolderOpen },
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
  { id: 'preview', label: 'Preview', Icon: Eye },
];

/** 'workbench-open' 事件 detail（Agent 工具调用联动） */
interface WorkbenchOpenDetail {
  readonly tab?: WorkbenchTab;
}

/** Tab bar 高度（spec：40px） */
const TAB_BAR_HEIGHT = 40;

/** 拖拽热区宽度 */
const RESIZE_HANDLE_WIDTH = 4;

/* ============================================================
   共用样式片段（全部走 CSS 变量，无硬编码色值）
   ============================================================ */

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

/** 面板内的弱化说明文字 */
const hintStyle = {
  fontSize: 'var(--font-size-caption)',
  color: 'var(--text-tertiary)',
  lineHeight: 'var(--line-height-body)',
} as const;

/* ============================================================
   Tab 面板占位（本次只做骨架，不调 API）
   ============================================================ */

/** BrowserTab：地址栏 + iframe 占位区 */
function BrowserTab() {
  const [url, setUrl] = useState('https://example.com');

  return (
    <div data-slot="workbench-browser" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* 地址栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flex: '0 0 auto',
          padding: 'var(--space-2)',
          borderBottom: '1px solid var(--border-primary)',
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Enter URL…"
          aria-label="Browser address"
          style={{
            flex: 1,
            minWidth: 0,
            height: 28,
            padding: '0 var(--space-3)',
            border: '1px solid var(--input-border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--input-bg)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-caption)',
            outline: 'none',
          }}
        />
        <button
          type="button"
          style={{
            ...iconBtnStyle,
            width: 'auto',
            height: 28,
            padding: '0 var(--space-3)',
            fontSize: 'var(--font-size-caption)',
            fontWeight: 'var(--font-weight-medium)',
          }}
        >
          Go
        </button>
      </div>

      {/* iframe 占位区 */}
      <div
        data-slot="workbench-browser-viewport"
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-6)',
          background: 'var(--surface-elevated)',
        }}
      >
        <span style={hintStyle}>Browser workspace placeholder</span>
      </div>
    </div>
  );
}

/** CodeTab：左侧文件树占位 + 右侧编辑区占位 */
const CODE_TREE_ROWS: ReadonlyArray<{ name: string; depth: number }> = [
  { name: 'src/', depth: 0 },
  { name: 'components/', depth: 1 },
  { name: 'Workbench.tsx', depth: 2 },
  { name: 'ContextBar.tsx', depth: 2 },
  { name: 'WorkspaceFrame.tsx', depth: 2 },
  { name: 'store/', depth: 1 },
  { name: 'workspace.ts', depth: 2 },
  { name: 'styles/', depth: 1 },
  { name: 'tokens.css', depth: 2 },
];

function CodeTab() {
  return (
    <div data-slot="workbench-code" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* 文件树占位 */}
      <div
        style={{
          flex: '0 0 40%',
          minWidth: 0,
          padding: 'var(--space-2) 0',
          borderRight: '1px solid var(--border-primary)',
          overflowY: 'auto',
        }}
      >
        {CODE_TREE_ROWS.map((row) => (
          <div
            key={row.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 24,
              paddingRight: 'var(--space-3)',
              paddingLeft: `calc(var(--space-3) + ${row.depth} * var(--space-3))`,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--font-size-caption)',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {row.name}
          </div>
        ))}
      </div>

      {/* 编辑区占位 */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          flexDirection: 'column',
          justifyContent: 'center',
          padding: 'var(--space-6)',
          gap: 'var(--space-2)',
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-caption)', color: 'var(--text-secondary)' }}>
          Workbench.tsx
        </span>
        <span style={hintStyle}>Editor placeholder</span>
      </div>
    </div>
  );
}

/** FilesTab：文件列表占位（Name / Type / Updated） */
const FILE_ROWS: ReadonlyArray<{ name: string; type: string; updated: string }> = [
  { name: 'README.md', type: 'Markdown', updated: '2 min ago' },
  { name: 'package.json', type: 'JSON', updated: '18 min ago' },
  { name: 'tokens.css', type: 'CSS', updated: '1 h ago' },
  { name: 'workspace.ts', type: 'TypeScript', updated: '3 h ago' },
  { name: 'output.log', type: 'Log', updated: 'yesterday' },
];

function FilesTab() {
  return (
    <div data-slot="workbench-files" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* 表头 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 88px 96px',
          gap: 'var(--space-3)',
          flex: '0 0 auto',
          alignItems: 'center',
          height: 32,
          padding: '0 var(--space-3)',
          borderBottom: '1px solid var(--border-primary)',
          background: 'var(--surface-shell)',
        }}
      >
        {(['Name', 'Type', 'Updated'] as const).map((label) => (
          <span
            key={label}
            style={{
              fontSize: 'var(--font-size-label)',
              fontWeight: 'var(--font-weight-medium)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
        ))}
      </div>

      {/* 数据行 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {FILE_ROWS.map((row) => (
          <div
            key={row.name}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 88px 96px',
              gap: 'var(--space-3)',
              alignItems: 'center',
              height: 30,
              padding: '0 var(--space-3)',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: 'var(--font-size-caption)',
              color: 'var(--text-secondary)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {row.name}
            </span>
            <span style={{ color: 'var(--text-tertiary)' }}>{row.type}</span>
            <span style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{row.updated}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** TerminalTab：深色终端区占位（$ 提示符 + 假输出） */
const TERMINAL_LINES: ReadonlyArray<{ kind: 'command' | 'output' | 'muted'; text: string }> = [
  { kind: 'command', text: '$ pnpm dev' },
  { kind: 'output', text: '> aether@0.1.0 dev' },
  { kind: 'output', text: '> vite v6.0.0 ready in 412 ms' },
  { kind: 'muted', text: '' },
  { kind: 'command', text: '$ pnpm test' },
  { kind: 'output', text: ' PASS  src/components/shell/workbench.test.tsx' },
  { kind: 'output', text: ' PASS  src/store/workspace.test.ts' },
  { kind: 'muted', text: '' },
  { kind: 'command', text: '$ ▌' },
];

function TerminalTab() {
  return (
    <div
      data-slot="workbench-terminal"
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        flexDirection: 'column',
        padding: 'var(--space-3)',
        gap: '2px',
        overflowY: 'auto',
        background: 'var(--bg-base)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-size-caption)',
        lineHeight: '1.6',
      }}
    >
      {TERMINAL_LINES.map((line, i) => (
        <span
          key={`${line.kind}-${i}`}
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: line.kind === 'command' ? 'var(--text-primary)' : line.kind === 'muted' ? 'transparent' : 'var(--text-secondary)',
          }}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}

/** PreviewTab：空态占位 */
function PreviewTab() {
  return (
    <div
      data-slot="workbench-preview"
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-8)',
        textAlign: 'center',
      }}
    >
      <Eye size={24} aria-hidden="true" style={{ color: 'var(--text-tertiary)', opacity: 0.4 }} />
      <span style={{ fontSize: 'var(--font-size-body-sm)', color: 'var(--text-secondary)' }}>Preview artifacts here</span>
    </div>
  );
}

/** 按 activeTab 渲染对应占位面板 */
const TAB_PANELS: Record<WorkbenchTab, () => ReactElement> = {
  browser: BrowserTab,
  code: CodeTab,
  files: FilesTab,
  terminal: TerminalTab,
  preview: PreviewTab,
};

/* ============================================================
   Workbench
   ============================================================ */

export function Workbench() {
  const workbench = useWorkspaceStore((s) => s.workbench);
  const setWorkbenchTab = useWorkspaceStore((s) => s.setWorkbenchTab);
  const setWorkbenchWidth = useWorkspaceStore((s) => s.setWorkbenchWidth);
  const toggleWorkbenchPin = useWorkspaceStore((s) => s.toggleWorkbenchPin);
  const toggleWorkbenchMaximize = useWorkspaceStore((s) => s.toggleWorkbenchMaximize);
  const closeWorkbench = useWorkspaceStore((s) => s.closeWorkbench);
  const openWorkbench = useWorkspaceStore((s) => s.openWorkbench);
  const toggleWorkbench = useWorkspaceStore((s) => s.toggleWorkbench);

  /* ============================================================
     Agent 工具调用联动：window CustomEvent
     ============================================================ */
  useEffect(() => {
    const openHandler = (e: Event) => {
      const detail = (e as CustomEvent<WorkbenchOpenDetail>).detail;
      openWorkbench(detail?.tab);
    };
    const toggleHandler = () => {
      toggleWorkbench();
    };
    window.addEventListener('workbench-open', openHandler);
    window.addEventListener('workbench-toggle', toggleHandler);
    return () => {
      window.removeEventListener('workbench-open', openHandler);
      window.removeEventListener('workbench-toggle', toggleHandler);
    };
  }, [openWorkbench, toggleWorkbench]);

  /* ============================================================
     拖拽调整宽度：Workbench 贴右边缘，向左拖 = 变宽
     （store 内部已 clamp 到 320-960）
     ============================================================ */
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

  /* ============================================================
     关闭态：由 WorkspaceFrame 控制挂载，这里兜底返回 null
     ============================================================ */
  if (!workbench.open) return null;

  const ActivePanel = TAB_PANELS[workbench.activeTab];

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
        {TABS.map(({ id, label, Icon }) => {
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

      {/* 内容区：surface-content 透明背景 */}
      <div
        role="tabpanel"
        aria-label={workbench.activeTab}
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          background: 'var(--surface-content)',
        }}
      >
        <ActivePanel />
      </div>

      {/* 底部状态条（预留：显示 agent 活动，当前为空） */}
      <div
        data-slot="workbench-statusbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          flex: '0 0 auto',
          gap: 'var(--space-3)',
          height: 26,
          padding: '0 var(--space-3)',
          borderTop: '1px solid var(--border-primary)',
          background: 'var(--surface-shell)',
          fontSize: 'var(--font-size-label)',
          color: 'var(--text-tertiary)',
        }}
      />
    </div>
  );
}
