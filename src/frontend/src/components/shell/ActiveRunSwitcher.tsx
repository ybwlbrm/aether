/**
 * ActiveRunSwitcher —— 侧栏主导航组的**首项**：实时 Run 选择器。
 *
 * 它不是一个静态链接：数据来自 runStore（T8 的权威 Run 状态），
 * 展示当前会话的 Run 列表与各自状态，选择即 `setActiveRun`。
 *
 * compact 形态只有 48px 宽，容纳不了 `<select>`：退化为打开会话抽屉的图标按钮
 * （run 的完整选择在抽屉里完成，该抽屉由 `action:conv-panel` 表面驱动）。
 */
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ListTree } from 'lucide-react';
import { RUN_STATUS_META } from '../../lib/run-status';
import { useRunStore, type RunSnapshot } from '../../store/runStore';
import { useWorkspaceStore } from '../../store/workspace';
import { runNavActionById } from '../navigation';

/** spec §11.2：导航项 icon 尺寸 */
const NAV_ICON_SIZE = 16;

/** 无会话时的空 Run 列表：模块级常量保证引用稳定 */
const NO_RUNS: readonly RunSnapshot[] = Object.freeze([])

const compactButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: 'var(--btn-height)',
  padding: 0,
  border: 'none',
  borderRadius: 'var(--radius-control)',
  background: 'transparent',
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  height: 'var(--btn-height)',
  padding: '0 var(--space-2)',
  border: 'var(--border-width-hairline) solid var(--border-subtle)',
  borderRadius: 'var(--radius-control)',
  background: 'var(--surface-hover)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--font-size-caption)',
}

export function ActiveRunSwitcher({ compact }: { readonly compact: boolean }): React.ReactElement {
  const conversationId = useWorkspaceStore((s) => s.conversationId)
  // 复用 store 唯一的 reader（getRunsForConversation）；useShallow 保证引用稳定，避免 SSR 快照抖动
  const runs = useRunStore(
    useShallow((s) => (conversationId === null ? NO_RUNS : s.getRunsForConversation(conversationId))),
  )
  const activeRunId = useRunStore((s) => s.activeRunId)
  const setActiveRun = useRunStore((s) => s.setActiveRun)
  const activeStatus = useRunStore((s) => {
    const id = s.activeRunId
    return id === null ? null : (s.runsById[id]?.status ?? null)
  })

  const openDrawer = useCallback(() => runNavActionById('action:conv-panel'), [])

  if (compact) {
    return (
      <button
        type="button"
        onClick={openDrawer}
        style={compactButtonStyle}
        title={activeStatus === null ? 'Conversations' : `Conversations · ${RUN_STATUS_META[activeStatus].label}`}
        aria-label="切换会话面板"
      >
        <ListTree size={NAV_ICON_SIZE} strokeWidth={1.75} aria-hidden="true" />
      </button>
    )
  }

  return (
    <select
      aria-label="活动 Run"
      value={activeRunId ?? ''}
      disabled={runs.length === 0}
      onChange={(e) => setActiveRun(e.target.value === '' ? null : e.target.value)}
      style={selectStyle}
    >
      <option value="">{runs.length === 0 ? 'No runs yet' : 'Choose a run'}</option>
      {runs.map((run) => (
        <option key={run.id} value={run.id}>
          {/* run id 只展示前 8 位，切换器宽度有限 */}
          {RUN_STATUS_META[run.status].label} · {run.id.slice(0, 8)}
        </option>
      ))}
    </select>
  )
}
