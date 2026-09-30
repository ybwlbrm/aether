/**
 * navigation —— 导航信息架构的公共入口。
 *
 * 消费方（Sidebar、T23 Command Palette）只从这里 import：
 * 表面数据来自 `NavModel`，主导航渲染来自 `NavSurfaceList`。
 */
export {
  NAV_GROUP_IDS,
  NAV_GROUP_LABELS,
  NAV_PRIMARY_GROUP,
  NAV_ROUTE_PATHS,
  NAV_SURFACES,
  findNavSurface,
  findRouteSurfaceByPath,
  getPaletteSurfaces,
  getSecondarySurfaces,
  getSidebarSurfaces,
  getSidebarSurfacesByGroup,
  runNavAction,
  runNavActionById,
  type NavActionSurface,
  type NavGroupId,
  type NavRouteSurface,
  type NavSidebarSurface,
  type NavSurface,
  type NavWorkbenchSurface,
} from './NavModel'

export { NavSurfaceList, type NavSurfaceListProps, type WorkbenchFocus } from './NavSurfaceList'
