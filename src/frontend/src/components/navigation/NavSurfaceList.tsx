/**
 * NavSurfaceList —— NavModel 的主导航渲染器。
 *
 * 本组件不含任何导航数据：分组、标签、icon、keywords 全部来自 `NavModel`。
 * 未来 T23 的 Command Palette 会复用同一份模型（`getPaletteSurfaces()`），
 * 因此「侧栏和面板看到的导航」在任何时刻都是同一个注册表的两个投影。
 *
 * 组标签遵循 T6a 决策：sentence case + 正常字距 + 最弱一级颜色，
 * 不做 `text-transform: uppercase`（`.aether-nav-group-label` 已覆盖结构性样式，
 * 这里只按 spec 覆盖字号与颜色）。
 */
import { NAV_GROUP_IDS, NAV_GROUP_LABELS, NAV_PRIMARY_GROUP, getSidebarSurfacesByGroup, type NavGroupId, type NavSidebarSurface } from './NavModel'
import type { WorkbenchTab } from '../../store/workspace'

/** 导航项 icon 尺寸（spec §11.2） */
const NAV_ICON_SIZE = 16

/** 工作台焦点：判定 workbench 表面是否 active */
export interface WorkbenchFocus {
  readonly open: boolean
  readonly activeTab: WorkbenchTab
}

export interface NavSurfaceListProps {
  /** compact 形态：仅图标，隐藏组标签与文字 */
  readonly compact: boolean
  /** 当前路由 path */
  readonly activePath: string
  readonly workbench: WorkbenchFocus
  /** 点击导航项：由 Sidebar 决定 route 跳转还是 workbench 就地打开 */
  readonly activate: (surface: NavSidebarSurface) => void
  /** 插入到主导航组（`NAV_PRIMARY_GROUP`）首项的实时控件，如 run 切换器 */
  readonly leading?: React.ReactNode
}

/** 组标签：11px / --text-tertiary / 正常字距 / 不大写 */
const groupLabelStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '11px',
  letterSpacing: 'normal',
  color: 'var(--text-tertiary)',
}

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
}

const sectionStyle: React.CSSProperties = { marginBottom: 'var(--space-4)' }

function isActive(surface: NavSidebarSurface, activePath: string, workbench: WorkbenchFocus): boolean {
  // 穷尽匹配：新增 NavSidebarSurface 变体时 tsc 在此报错
  switch (surface.surfaceKind) {
    case 'route':
      return surface.path === activePath
    case 'workbench':
      return workbench.open && workbench.activeTab === surface.workbenchTab
  }
}

/** 一组内的可见表面；空组返回 null（不留空标题） */
function renderGroup(
  group: NavGroupId,
  props: NavSurfaceListProps,
): React.ReactElement | null {
  const surfaces = getSidebarSurfacesByGroup(group)
  const leading = group === NAV_PRIMARY_GROUP ? props.leading : undefined
  if (surfaces.length === 0 && leading === undefined) return null
  const { compact, activePath, workbench, activate } = props
  return (
    <section key={group} style={sectionStyle} data-nav-group={group}>
      {compact ? (
        <div className="aether-nav-group-label" aria-hidden="true" style={groupLabelStyle} />
      ) : (
        <h2 className="aether-nav-group-label" style={groupLabelStyle}>
          {NAV_GROUP_LABELS[group]}
        </h2>
      )}
      <ul style={listStyle}>
        {leading !== undefined && <li data-nav-leading="true">{leading}</li>}
        {surfaces.map((surface) => {
          const Icon = surface.icon
          const active = isActive(surface, activePath, workbench)
          return (
            <li key={surface.id}>
              <button
                type="button"
                onClick={() => activate(surface)}
                data-active={active}
                data-nav-surface={surface.id}
                className="aether-nav-item"
                title={compact ? surface.label : surface.description}
                aria-label={compact ? surface.label : undefined}
                aria-current={active ? 'page' : undefined}
                style={compact ? { justifyContent: 'center', padding: 0 } : undefined}
              >
                <Icon size={NAV_ICON_SIZE} strokeWidth={active ? 2 : 1.75} style={{ flexShrink: 0 }} aria-hidden="true" />
                {!compact && <span className="truncate">{surface.label}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function NavSurfaceList(props: NavSurfaceListProps): React.ReactElement {
  return (
    <nav aria-label="Workspace" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 'var(--space-3) var(--space-2)' }}>
      {NAV_GROUP_IDS.map((group) => renderGroup(group, props))}
    </nav>
  )
}
