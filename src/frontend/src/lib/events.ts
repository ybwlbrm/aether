import type { WorkbenchTab } from '../store/workspace'

/**
 * app 级 CustomEvent 契约注册表。
 *
 * 职责：冻结「事件名 → detail 载荷 → 单向性」的唯一事实源，
 * 并提供 typed 的 dispatch / subscribe 入口。
 * 本文件只描述契约，不迁移任何既有 dispatch / addEventListener 调用点 ——
 * 现有调用点仍用 `new CustomEvent(...)` 派发，行为完全不变。
 */

/** 远程指令载荷（契约源头；routes/CodingHome.tsx 从此处 re-export） */
export interface RemoteCommandPayload {
  readonly content?: string
  readonly conversationId?: string
  readonly commandId?: string
  readonly id?: string
  readonly receivedAt?: number
}

/** 事件的单向性：live = 派发与监听两端齐备；另两者表示有一端缺失（孤儿事件） */
export type AppEventOrphan = 'live' | 'dispatch-only' | 'listen-only'

/** 全部 app 级事件名：运行时冻结数组 + 编译期字面量联合同源 */
export const APP_EVENT_NAMES = Object.freeze([
  'aether-open-approvals',
  'bg-slideshow-start',
  'bg-slideshow-stop',
  'bg-slideshow-clear',
  'bg-slideshow-interval',
  'conversations-changed',
  'custombg-change',
  'remote-command',
  'select-conversation',
  'sync-data-changed',
  'toggle-command-palette',
  'toggle-conv-panel',
  'toggle-ui-mode',
  'workbench-open',
  'workbench-toggle',
] as const)

/** 事件名的编译期联合 */
export type AppEventName = (typeof APP_EVENT_NAMES)[number]

/** 事件名 → detail 载荷的穷尽映射：key 集合必须与 AppEventName 完全一致 */
interface AppEventDetailByName {
  readonly 'aether-open-approvals': undefined
  readonly 'bg-slideshow-start': { readonly images: readonly string[]; readonly interval: number }
  readonly 'bg-slideshow-stop': undefined
  readonly 'bg-slideshow-clear': undefined
  readonly 'bg-slideshow-interval': { readonly interval: number }
  readonly 'conversations-changed': undefined
  readonly 'custombg-change': string | null
  readonly 'remote-command': RemoteCommandPayload
  readonly 'select-conversation': { readonly conversationId: string }
  readonly 'sync-data-changed': { readonly time: number }
  readonly 'toggle-command-palette': undefined
  readonly 'toggle-conv-panel': undefined
  readonly 'toggle-ui-mode': undefined
  /** 现有 listener 读 `detail?.tab`，故不传 detail 时（CustomEvent 存为 null）也合法 */
  readonly 'workbench-open': { readonly tab?: WorkbenchTab } | null
  readonly 'workbench-toggle': undefined
}

/** 事件 K 的 detail 载荷类型；K 缺省为全部事件名的联合 */
export type AppEventDetail<K extends AppEventName = AppEventName> = AppEventDetailByName[K]

/** detail 契约为 undefined 的事件名（由类型映射推导，因此不会与契约漂移） */
type DetaillessName = {
  [K in AppEventName]: AppEventDetail<K> extends undefined ? K : never
}[AppEventName]

/**
 * 无载荷事件名 —— CustomEvent 在 detail 缺省时按 WebIDL 存为 null，
 * 订阅端需还原成 undefined，否则「无载荷」契约在运行时会说谎。
 */
const DETAIL_LESS_EVENTS = Object.freeze([
  'aether-open-approvals',
  'bg-slideshow-stop',
  'bg-slideshow-clear',
  'conversations-changed',
  'toggle-command-palette',
  'toggle-conv-panel',
  'toggle-ui-mode',
  'workbench-toggle',
] satisfies readonly DetaillessName[])

const DETAIL_LESS_LOOKUP: ReadonlySet<string> = new Set(DETAIL_LESS_EVENTS)

/** 双向相等断言：映射少一个 key → AppEventName 不再 extends keyof（得到 never）；多一个 key → 违反 B 约束 */
type AssertExactNames<A extends AppEventName, B extends AppEventName> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never
const _detailKeysMatchAppEventNames: AssertExactNames<AppEventName, keyof AppEventDetailByName> = true
void _detailKeysMatchAppEventNames

/** 单个事件的注册信息 */
export interface AppEventDescriptor {
  /** 事件是否单向（有一端缺失）以及缺失的方向 */
  readonly orphan: AppEventOrphan
  /** 该事件承载什么语义 */
  readonly summary: string
}

/** 冻结的事件注册表：15 个事件名一一对应，`satisfies` 保证不多不少 */
export const APP_EVENT_REGISTRY: Readonly<Record<AppEventName, AppEventDescriptor>> = Object.freeze({
  'aether-open-approvals': { orphan: 'dispatch-only', summary: '打开审批中心（NavModel action:approvals 派发，无监听端）' },
  'bg-slideshow-start': { orphan: 'live', summary: '以目录图片列表启动壁纸轮播' },
  'bg-slideshow-stop': { orphan: 'live', summary: '停止壁纸轮播并清空目录图片' },
  'bg-slideshow-clear': { orphan: 'live', summary: '清空壁纸轮播状态' },
  'bg-slideshow-interval': { orphan: 'live', summary: '调整壁纸轮播间隔（秒）' },
  'conversations-changed': { orphan: 'live', summary: '会话列表变更，驱动侧栏刷新' },
  'custombg-change': { orphan: 'live', summary: '自定义壁纸变更，detail 为 dataURL 或 null（清除）' },
  'remote-command': { orphan: 'live', summary: '桌面端远程指令载荷，交给远程命令宿主' },
  'select-conversation': { orphan: 'live', summary: '从记录面板选中会话，页面据此加载' },
  'sync-data-changed': { orphan: 'live', summary: '云同步数据变更，通知各页面重新拉取（DataManage 派发 → Knowledge 监听）' },
  'toggle-command-palette': { orphan: 'live', summary: '开关命令面板' },
  'toggle-conv-panel': { orphan: 'live', summary: '开关会话面板（NavModel action:conv-panel 派发 → ConversationsDrawer 监听）' },
  'toggle-ui-mode': { orphan: 'dispatch-only', summary: '切换 UI 模式（NavModel action:ui-mode 派发，无监听端）' },
  'workbench-open': { orphan: 'live', summary: '打开工作台，可指定目标 tab（CommandPalette 派发 → AppShell 监听）' },
  'workbench-toggle': { orphan: 'listen-only', summary: '折叠 / 展开工作台（仅 AppShell 监听，当前无派发点）' },
} satisfies Record<AppEventName, AppEventDescriptor>)

/** 事件宿主能力：浏览器里是 window，SSR / Node 测试环境退回模块级 EventTarget */
type AppEventHost = Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>

const SSR_EVENT_HOST: EventTarget = new EventTarget()

function resolveHost(): AppEventHost {
  return typeof window === 'undefined' ? SSR_EVENT_HOST : window
}

/** 派发一个已注册事件；detail 类型由事件名唯一决定 */
export function dispatchAppEvent<K extends AppEventName>(name: K, detail?: AppEventDetail<K>): void {
  resolveHost().dispatchEvent(new CustomEvent<AppEventDetail<K>>(name, { detail }))
}

/**
 * 订阅一个已注册事件，返回取消订阅函数。
 * 回调收到的 detail 已是该事件名对应的契约类型。
 */
export function subscribeAppEvent<K extends AppEventName>(
  name: K,
  handler: (detail: AppEventDetail<K>) => void,
): () => void {
  const host = resolveHost()
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return
    // lib.dom 的 EventListener 只能拿到 Event（detail 退化为 any），此处收窄回契约类型
    const raw: unknown = (event as CustomEvent<unknown>).detail
    handler((raw === null && DETAIL_LESS_LOOKUP.has(name) ? undefined : raw) as AppEventDetail<K>)
  }
  host.addEventListener(name, listener)
  return () => { host.removeEventListener(name, listener) }
}
