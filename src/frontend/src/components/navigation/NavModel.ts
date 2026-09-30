/**
 * NavModel —— 导航信息架构的单一真相源（T19）。
 *
 * ## 不变量
 * 1. **一份注册表**：Sidebar 与 Command Palette（T23）都只从这里取数据渲染，
 *    任何一侧都不得再手写导航数组。
 * 2. **与 App.tsx 一一对应**：20 条具名路由全部注册（NavModel.test.ts 直接解析
 *    App.tsx 源码做双向校验），多一条少一条都编译期/测试期立即失败。
 * 3. **primary / secondary 显式建模**：`hiddenFromSidebar` 的表面从主导航隐藏，
 *    但仍是 palette 可达的合法表面（`/dashboard` 这类 alias 走这条路）。
 * 4. **每个表面带非空 keywords**：palette 搜索的输入契约。
 * 5. **组标签 sentence case**：不做全大写喊话（见 `.aether-nav-group-label` / T6a）。
 *
 * 三种表面形态是**可辨识联合**而非「path? + tab? + action?」：判别字段
 * `surfaceKind` 一变，TypeScript 就知道该不该有 path / tab / run。
 */
import {
  Activity,
  BookOpen,
  Bot,
  Code2,
  Cpu,
  FileText,
  FolderKanban,
  Globe,
  Image,
  LayoutDashboard,
  Library,
  Lock,
  MessageSquare,
  MonitorPlay,
  PanelsTopLeft,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Stethoscope,
  Terminal,
  Wrench,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { dispatchAppEvent } from '../../lib/events';
import { useAppStore } from '../../store/app';
import type { WorkbenchTab } from '../../store/workspace';

/* ------------------------------------------------------------------ *
 * 分组（Codex 风格：5 组，sentence case 标签）
 * ------------------------------------------------------------------ */

/**
 * 侧栏的呈现顺序 —— 同时是分组 id 的唯一真相（无 `as` 断言）。
 *
 * 标签表声明为 `Record<NavGroupId, string>`：少写一个键或写错一个键 tsc 立即失败。
 */
export const NAV_GROUP_IDS = Object.freeze(['work', 'output', 'configure', 'operate', 'tools'] as const)

/** 导航分组 id */
export type NavGroupId = (typeof NAV_GROUP_IDS)[number]

/** 组 id → 展示标签。键集合由 `NavGroupId` 在编译期锁死。 */
export const NAV_GROUP_LABELS: Readonly<Record<NavGroupId, string>> = Object.freeze({
  work: 'Work',
  output: 'Output',
  configure: 'Configure',
  operate: 'Operate',
  tools: 'Tools',
})

/**
 * 主导航组 —— 实时 run 切换器作为该组的**首项**渲染。
 *
 * 「Work 组第一件事是选一个正在跑的 Run」是 IA 决策而非实现细节，
 * 因此组 id 在 NavModel 里声明，渲染侧不硬编码 'work'。
 */
export const NAV_PRIMARY_GROUP: NavGroupId = 'work'

/* ------------------------------------------------------------------ *
 * 表面（surface）类型
 * ------------------------------------------------------------------ */

interface NavSurfaceBase {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly icon: LucideIcon
  readonly group: NavGroupId
  /** palette 搜索词；恒非空 */
  readonly keywords: readonly string[]
  /** true = 不进主导航，仅 palette / “More surfaces” 可达 */
  readonly hiddenFromSidebar?: boolean
  /** 本表面是另一表面的历史别名（仍可路由，但不再独立出现在导航里） */
  readonly aliasOf?: string
}

/** 路由表面：跳转到一条 App.tsx 路由 */
export interface NavRouteSurface extends NavSurfaceBase {
  readonly surfaceKind: 'route'
  readonly path: string
}

/** Workbench 面板表面：就地打开工作台某个 tab，不换路由 */
export interface NavWorkbenchSurface extends NavSurfaceBase {
  readonly surfaceKind: 'workbench'
  readonly workbenchTab: WorkbenchTab
}

/** 动作表面：执行一个 app 级副作用（孤儿事件在此获得 dispatcher） */
export interface NavActionSurface extends NavSurfaceBase {
  readonly surfaceKind: 'action'
  readonly run: () => void
}

/** 全部导航表面 */
export type NavSurface = NavRouteSurface | NavWorkbenchSurface | NavActionSurface

/**
 * 可静态出现在主导航中的表面。
 *
 * action 表面天然没有静态位置（它是一次性副作用，不是可停留的页面），
 * 因此 Sidebar 模型在**类型层**就排除了 action —— 渲染侧无需为此写分支。
 */
export type NavSidebarSurface = NavRouteSurface | NavWorkbenchSurface

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

/**
 * 20 条路由表面 —— 与 App.tsx 的 20 条具名路由一一对应。
 * 顺序即侧栏的呈现顺序（按组内语义排列：先入口、后细节）。
 */
const ROUTE_SURFACES: readonly NavRouteSurface[] = [
  { surfaceKind: 'route', id: 'command-center', path: '/command-center', label: 'Command center', description: '运行、线程与工作区总览', icon: PanelsTopLeft, group: 'work', keywords: ['home', 'thread', 'overview', 'start', '总览', '线程'] },
  { surfaceKind: 'route', id: 'chat', path: '/chat', label: 'Chat', description: '在会话线程上与 Agent 对话', icon: MessageSquare, group: 'work', keywords: ['conversation', 'talk', 'agent', '会话', '对话'] },
  { surfaceKind: 'route', id: 'projects', path: '/projects', label: 'Projects', description: '项目工作区与任务看板', icon: FolderKanban, group: 'work', keywords: ['workspace', 'board', 'repo', '项目', '看板'] },
  { surfaceKind: 'route', id: 'documents', path: '/documents', label: 'Documents', description: '读写工作区文档', icon: FileText, group: 'output', keywords: ['doc', 'file', 'editor', '文档', '编辑'] },
  { surfaceKind: 'route', id: 'media', path: '/media', label: 'Media', description: '图片、音频与生成的素材', icon: Image, group: 'output', keywords: ['image', 'audio', 'asset', '媒体', '素材'] },
  { surfaceKind: 'route', id: 'library', path: '/library', label: 'Library', description: '共享素材与模型库', icon: Library, group: 'output', keywords: ['assets', 'models', 'shared', '库', '共享'] },
  { surfaceKind: 'route', id: 'providers', path: '/providers', label: 'Providers', description: '模型供应商、密钥与路由', icon: Cpu, group: 'configure', keywords: ['model', 'key', 'api', 'llm', '供应商', '密钥'] },
  { surfaceKind: 'route', id: 'agent-settings', path: '/agent-settings', label: 'Agent settings', description: 'Agent、角色与权限配置', icon: Bot, group: 'configure', keywords: ['agent', 'role', 'permission', '代理', '权限'] },
  { surfaceKind: 'route', id: 'mcp', path: '/mcp', label: 'MCP', description: 'Model Context Protocol 服务器', icon: Server, group: 'configure', keywords: ['server', 'tool', 'context protocol', '服务器', '工具'] },
  { surfaceKind: 'route', id: 'workflows', path: '/workflows', label: 'Workflows', description: '可视化编排画布', icon: Workflow, group: 'configure', keywords: ['canvas', 'pipeline', 'automation', '编排', '自动化'] },
  { surfaceKind: 'route', id: 'settings', path: '/settings', label: 'Settings', description: '应用、外观与通用设置', icon: Settings, group: 'configure', keywords: ['preferences', 'appearance', 'config', '设置', '外观'] },
  { surfaceKind: 'route', id: 'monitoring', path: '/monitoring', label: 'Monitoring', description: '运行健康度、延迟与失败', icon: Activity, group: 'operate', keywords: ['health', 'latency', 'metrics', '监控', '指标'] },
  { surfaceKind: 'route', id: 'selfcheck', path: '/selfcheck', label: 'Self check', description: '环境与依赖自检诊断', icon: Stethoscope, group: 'operate', keywords: ['diagnose', 'doctor', 'env', 'dependency', '自检', '诊断'] },
  { surfaceKind: 'route', id: 'knowledge', path: '/knowledge', label: 'Knowledge', description: '资料源、笔记与知识库', icon: BookOpen, group: 'operate', keywords: ['source', 'note', 'wiki', 'rag', '知识', '笔记'] },
  { surfaceKind: 'route', id: 'vault', path: '/vault', label: 'Vault', description: '机密、凭据与密钥保管', icon: Lock, group: 'operate', keywords: ['secret', 'credential', 'key', '机密', '凭据'] },
  { surfaceKind: 'route', id: 'toolbox', path: '/toolbox', label: 'Toolbox', description: '格式转换与常用小工具', icon: Wrench, group: 'tools', keywords: ['convert', 'utility', 'format', '工具', '转换'] },
  { surfaceKind: 'route', id: 'search', path: '/search', label: 'Search', description: '跨工作区数据检索', icon: Search, group: 'tools', keywords: ['find', 'query', 'lookup', '搜索', '检索'] },
  { surfaceKind: 'route', id: 'browser', path: '/browser', label: 'Browser', description: '在工作区内浏览网页', icon: Globe, group: 'tools', keywords: ['web', 'url', 'page', '浏览', '网页'] },
  { surfaceKind: 'route', id: 'terminal', path: '/terminal', label: 'Terminal', description: 'Shell 终端工作区', icon: Terminal, group: 'tools', keywords: ['shell', 'console', 'bash', '终端', '命令行'] },
  // T24：`/dashboard` 不再是 `/command-center` 的别名 —— 路由切换后它是**另一个表面**
  // （旧 dashboard：Recent Work / Quick 入口 / System health），因此摘掉 aliasOf，
  // 让它在 palette 里以自己的名义出现，而不是被当成 Thread 的重复项折叠掉。
  { surfaceKind: 'route', id: 'dashboard', path: '/dashboard', label: 'Dashboard', description: '旧版总览：Recent Work、Quick 入口与 System health', icon: LayoutDashboard, group: 'work', keywords: ['overview', 'summary', 'recent', 'quick', 'health', '总览', '概览', '最近'], hiddenFromSidebar: true },
]

/** Workbench 面板表面：不换路由、就地开面板；默认走 palette 抵达。 */
const WORKBENCH_SURFACES: readonly NavWorkbenchSurface[] = [
  { surfaceKind: 'workbench', id: 'workbench-browser', workbenchTab: 'browser', label: 'Browser pane', description: '在右侧工作台打开浏览器', icon: Globe, group: 'tools', keywords: ['pane', 'side panel', 'web'], hiddenFromSidebar: true },
  { surfaceKind: 'workbench', id: 'workbench-code', workbenchTab: 'code', label: 'Code pane', description: '在右侧工作台打开代码编辑器', icon: Code2, group: 'tools', keywords: ['pane', 'editor', 'source'], hiddenFromSidebar: true },
  { surfaceKind: 'workbench', id: 'workbench-files', workbenchTab: 'files', label: 'Files pane', description: '在右侧工作台打开文件树', icon: FolderKanban, group: 'tools', keywords: ['pane', 'tree', 'explorer'], hiddenFromSidebar: true },
  { surfaceKind: 'workbench', id: 'workbench-terminal', workbenchTab: 'terminal', label: 'Terminal pane', description: '在右侧工作台打开终端', icon: SquareTerminal, group: 'tools', keywords: ['pane', 'shell', 'console'], hiddenFromSidebar: true },
  { surfaceKind: 'workbench', id: 'workbench-preview', workbenchTab: 'preview', label: 'Preview pane', description: '在右侧工作台打开预览', icon: MonitorPlay, group: 'tools', keywords: ['pane', 'render', 'result'], hiddenFromSidebar: true },
]

/**
 * 3 个孤儿事件表面（T1 事件注册表标注为 dispatch-only）。
 *
 * `run` 是它们唯一的执行入口：Sidebar 与 palette 都调 `runNavAction`，
 * 监听端（T20 Layout 抽屉 / T23 审批面板）在自己的任务里补上。
 */
const ACTION_SURFACES: readonly NavActionSurface[] = [
  { surfaceKind: 'action', id: 'action:ui-mode', label: 'Toggle interface mode', description: '在 normal 与 coding 两种界面模式间切换', icon: Code2, group: 'tools', keywords: ['ui', 'mode', 'coding', 'normal', '模式', '布局'], hiddenFromSidebar: true, run: () => { useAppStore.getState().toggleUiMode(); dispatchAppEvent('toggle-ui-mode') } },
  { surfaceKind: 'action', id: 'action:conv-panel', label: 'Conversations', description: '开关会话抽屉', icon: MessageSquare, group: 'work', keywords: ['drawer', 'thread list', 'history', '会话', '历史'], hiddenFromSidebar: true, run: () => dispatchAppEvent('toggle-conv-panel') },
  { surfaceKind: 'action', id: 'action:approvals', label: 'Approval center', description: '打开待审批权限面板', icon: ShieldCheck, group: 'operate', keywords: ['permission', 'review', 'approve', '审批', '权限'], hiddenFromSidebar: true, run: () => dispatchAppEvent('aether-open-approvals') },
]

/** 全部表面（palette 的超集） */
export const NAV_SURFACES: readonly NavSurface[] = Object.freeze([
  ...ROUTE_SURFACES,
  ...WORKBENCH_SURFACES,
  ...ACTION_SURFACES,
])

/** 全部已注册路由 path（测试与 palette 消费；运行时可直接索引） */
export const NAV_ROUTE_PATHS: readonly string[] = Object.freeze(
  ROUTE_SURFACES.map((surface) => surface.path),
)

const BY_ID: ReadonlyMap<string, NavSurface> = new Map(NAV_SURFACES.map((s) => [s.id, s]))
const BY_PATH: ReadonlyMap<string, NavRouteSurface> = new Map(ROUTE_SURFACES.map((s) => [s.path, s]))

/* ------------------------------------------------------------------ *
 * 选择器
 * ------------------------------------------------------------------ */

const SIDEBAR_SURFACES: readonly NavSidebarSurface[] = Object.freeze(
  NAV_SURFACES.filter(
    (surface): surface is NavSidebarSurface =>
      surface.hiddenFromSidebar !== true && surface.surfaceKind !== 'action',
  ),
)
const SECONDARY_SURFACES: readonly NavSurface[] = Object.freeze(
  NAV_SURFACES.filter((surface) => surface.hiddenFromSidebar === true),
)

/** 主导航（Sidebar）渲染源：非 secondary 的可导航表面 */
export function getSidebarSurfaces(): readonly NavSidebarSurface[] {
  return SIDEBAR_SURFACES
}

/** secondary 表面：`/dashboard` alias、workbench 面板与 3 个动作 —— palette 可达 */
export function getSecondarySurfaces(): readonly NavSurface[] {
  return SECONDARY_SURFACES
}

/** palette 渲染源：全部表面 */
export function getPaletteSurfaces(): readonly NavSurface[] {
  return NAV_SURFACES
}

/** 按 id 查表面 */
export function findNavSurface(id: string): NavSurface | undefined {
  return BY_ID.get(id)
}

/** 按路由 path 查表面（Sidebar 判定 active 用） */
export function findRouteSurfaceByPath(path: string): NavRouteSurface | undefined {
  return BY_PATH.get(path)
}

/** 某组下的 sidebar 可见表面，按注册顺序 */
export function getSidebarSurfacesByGroup(group: NavGroupId): readonly NavSidebarSurface[] {
  return SIDEBAR_SURFACES.filter((surface) => surface.group === group)
}

/* ------------------------------------------------------------------ *
 * 动作执行
 * ------------------------------------------------------------------ */

function assertUnreachable(value: never): never {
  throw new Error(`未覆盖的 NavSurface 变体：${JSON.stringify(value)}`)
}

/**
 * 执行一个 action 表面。
 *
 * 返回 true = 副作用已发生；false = 该表面由调用方的导航上下文（route / workbench）处理。
 * 判别联合穷尽收窄：新增 `surfaceKind` 变体时 tsc 在此报错，不会静默漏执行。
 */
export function runNavAction(surface: NavSurface): boolean {
  switch (surface.surfaceKind) {
    case 'action':
      surface.run()
      return true
    case 'route':
    case 'workbench':
      return false
    default:
      assertUnreachable(surface)
  }
}

/**
 * 按 id 执行一个 action 表面 —— 视图层触发动作的唯一入口。
 *
 * 把「查表 + 判空」收在这里，调用点就不必各自写一遍 `findNavSurface` + `if`。
 * id 不存在或指向 route / workbench 表面时返回 false（无副作用）。
 */
export function runNavActionById(id: string): boolean {
  const surface = BY_ID.get(id)
  return surface === undefined ? false : runNavAction(surface)
}
