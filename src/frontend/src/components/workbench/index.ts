/**
 * T22 Workbench 面板组件集。
 *
 * `WorkbenchPanel` 是 tab shell（持有激活项与呈现形态），`tabs/*` 是五个**纯展示**
 * 面板：数据经 props 传入，组件内零 hook、零 effect、零内部状态，因此每个状态
 * 分支都能在无 jsdom 的环境下静态渲染断言。
 *
 * 业务模块（`hooks/workbench`、`store/workspace`、`lib/url`）在本目录**只读消费**。
 */
export { WorkbenchPanel } from "./WorkbenchPanel"
export type { WorkbenchPanelProps, WorkbenchVariant } from "./WorkbenchPanel"

export { WORKBENCH_TABS } from "./tabs"
export type { WorkbenchTabDef } from "./tabs"

export { BrowserTab } from "./tabs/BrowserTab"
export type { BrowserTabProps } from "./tabs/BrowserTab"
export { CodeTab } from "./tabs/CodeTab"
export type { CodeTabProps } from "./tabs/CodeTab"
export { FilesTab } from "./tabs/FilesTab"
export type { FilesTabProps } from "./tabs/FilesTab"
export { PreviewTab } from "./tabs/PreviewTab"
export type { PreviewTabProps } from "./tabs/PreviewTab"
export { TerminalTab } from "./tabs/TerminalTab"
export type { TerminalTabProps } from "./tabs/TerminalTab"
