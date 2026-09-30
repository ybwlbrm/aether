/**
 * T22 `WorkbenchPanel` —— Workbench 的 tab shell。
 *
 * ## 为什么是「connector + 查表」而不是 React.lazy
 * 项目没有 Suspense 边界（`WorkspaceFrame` 直接挂载，没有 fallback 约定），
 * 而 `React.lazy` 必须配 `<Suspense>` 才有意义。因此这里用**查表 + 条件挂载**：
 * `PANELS[activeTab]` 只渲染当前那一个 connector，其余四个组件根本不实例化 ——
 * 效果与懒加载等价（不发请求、不占 DOM），但没有 Suspense 的空档期。
 *
 * ## connector 的意义（也是 hook 唯一被调用的地方）
 * 五个 tab 组件是**纯展示**（D4：零 hook、零 effect、零内部状态），数据全部经
 * props 传入。每个 connector 是一个独立组件，因此它内部可以无条件调用自己的
 * T21 hook（规则不会被违反），而这些 hook 只在该 tab 被激活时才运行：
 *   Browser  → useWorkbenchBrowser   Code    → useWorkbenchCode
 *   Files    → useWorkbenchFiles     Terminal→ useWorkbenchTerminal
 *   Preview  → useWorkbenchPreview
 *
 * ## data-slot 契约
 * 五个 tab 的根节点各自持有 `workbench-browser` / `workbench-code` /
 * `workbench-files` / `workbench-terminal` / `workbench-preview`，
 * 外部选择器与测试依赖这五个值，**不要改名**。
 */
import type { ReactElement } from "react"

import {
  useWorkbenchBrowser,
  useWorkbenchCode,
  useWorkbenchFiles,
  useWorkbenchPreview,
  useWorkbenchTerminal,
} from "../../hooks/workbench"
import { useWorkspaceStore, type WorkbenchTab } from "../../store/workspace"
import { panelRoot } from "./shared"
import { BrowserTab } from "./tabs/BrowserTab"
import { CodeTab } from "./tabs/CodeTab"
import { FilesTab } from "./tabs/FilesTab"
import { PreviewTab } from "./tabs/PreviewTab"
import { TerminalTab } from "./tabs/TerminalTab"

/** 呈现形态：桌面右侧一栏（column）/ 移动端底部抽屉（sheet）。 */
export type WorkbenchVariant = "column" | "sheet"

export interface WorkbenchPanelProps {
  readonly activeTab: WorkbenchTab;
  readonly variant: WorkbenchVariant;
}

function BrowserPanel(): ReactElement {
  return <BrowserTab {...useWorkbenchBrowser()} />
}

function CodePanel(): ReactElement {
  return <CodeTab {...useWorkbenchCode()} />
}

/**
 * Files 行点击 = 切到 Code tab。
 *
 * 具体文件由 `useWorkbenchCode` 内部的选中态持有（未选中时回落到首个文件），
 * 把它提升到 store 才能跨 tab 传递具体路径 —— store 与 hooks 在 T22 是只读的，
 * 因此这里只做「切 tab」，行的真实路径仍写在 `data-path` 上供回调契约使用。
 */
function FilesPanel(): ReactElement {
  const showCodeTab = useWorkspaceStore(state => state.setWorkbenchTab);
  return <FilesTab {...useWorkbenchFiles()} onOpenFile={() => showCodeTab("code")} />;
}

function TerminalPanel(): ReactElement {
  return <TerminalTab {...useWorkbenchTerminal()} />
}

function PreviewPanel(): ReactElement {
  return <PreviewTab {...useWorkbenchPreview()} />
}

/** 查表即穷尽：新增 `WorkbenchTab` 成员时 TS 会在这里报错，不会漏掉一个面板。 */
const PANELS: Record<WorkbenchTab, () => ReactElement> = {
  browser: BrowserPanel,
  code: CodePanel,
  files: FilesPanel,
  terminal: TerminalPanel,
  preview: PreviewPanel,
};

export function WorkbenchPanel({ activeTab, variant }: WorkbenchPanelProps): ReactElement {
  const ActivePanel = PANELS[activeTab];
  return (
    <div
      data-slot="workbench-panel"
      data-active-tab={activeTab}
      data-variant={variant}
      style={panelRoot}
    >
      <ActivePanel />
    </div>
  );
}
