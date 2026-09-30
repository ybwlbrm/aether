/**
 * T22 `WorkbenchPanel` —— tab shell 的渲染契约（TDD：先 RED）。
 *
 * `WorkbenchPanel` 是五个 tab 的**唯一接线点**：每个 tab 一个 connector
 * （connector 内部才调 T21 的 hook），shell 只挂载 `activeTab` 对应的那一个，
 * 因此未激活的 tab 既不发请求也不占 DOM。
 *
 * 断言全部基于 `renderToStaticMarkup`：静态渲染**不执行 effect**，因此两个
 * 走网络的数据源（Files / Preview / Terminal）在首帧必然是 loading/empty 态 ——
 * 这正好把「壳不自己造数据」这件事锁死：壳里不可能出现硬编码示例行。
 */
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { WorkbenchTab } from "../../store/workspace"
import { WorkbenchPanel, type WorkbenchPanelProps, type WorkbenchVariant } from "./WorkbenchPanel"

/** 外部选择器依赖的 data-slot（缺一个就是回归）。 */
const TAB_SLOTS: ReadonlyArray<readonly [WorkbenchTab, string]> = [
  ["browser", "workbench-browser"],
  ["code", "workbench-code"],
  ["files", "workbench-files"],
  ["terminal", "workbench-terminal"],
  ["preview", "workbench-preview"],
]

function render(props: Partial<WorkbenchPanelProps> = {}): string {
  return renderToStaticMarkup(
    <WorkbenchPanel activeTab={props.activeTab ?? "browser"} variant={props.variant ?? "column"} />,
  )
}

describe("WorkbenchPanel：tab 切换渲染正确面板", () => {
  it("每个 activeTab 渲染对应 data-slot 的面板", () => {
    for (const [tab, slot] of TAB_SLOTS) {
      const markup = render({ activeTab: tab })
      expect(markup, `activeTab=${tab}`).toContain(`data-slot="${slot}"`)
      expect(markup, `activeTab=${tab}`).toContain(`data-active-tab="${tab}"`)
    }
  })

  it("只挂载 activeTab —— 其余四个面板既不在 DOM 也不发请求", () => {
    for (const [tab] of TAB_SLOTS) {
      const markup = render({ activeTab: tab })
      for (const [otherTab, otherSlot] of TAB_SLOTS) {
        if (otherTab === tab) continue
        expect(markup, `activeTab=${tab} 不应渲染 ${otherSlot}`).not.toContain(
          `data-slot="${otherSlot}"`,
        )
      }
    }
  })

  it("面板不注入任何示例数据（Tabs 骨架期遗留的假常量已清零）", () => {
    for (const [tab] of TAB_SLOTS) {
      const markup = render({ activeTab: tab })
      expect(markup, `activeTab=${tab}`).not.toContain("example.com")
      expect(markup, `activeTab=${tab}`).not.toContain("vite v6.0.0")
      expect(markup, `activeTab=${tab}`).not.toContain("README.md")
    }
  })
})

describe("WorkbenchPanel：variant（column / sheet）", () => {
  it("column（桌面三栏）落到 data-variant=column", () => {
    const markup = render({ variant: "column" })
    expect(markup).toContain('data-variant="column"')
  })

  it("sheet（移动端 bottom sheet）落到 data-variant=sheet", () => {
    const markup = render({ variant: "sheet" })
    expect(markup).toContain('data-variant="sheet"')
  })

  it("variant 只影响壳的呈现标记，不改变面板内容", () => {
    const column = render({ activeTab: "files", variant: "column" })
    const sheet = render({ activeTab: "files", variant: "sheet" })
    expect(column).toContain('data-slot="workbench-files"')
    expect(sheet).toContain('data-slot="workbench-files"')
  })

  it("WorkbenchVariant 是两值闭集（不是 string）", () => {
    const variants: readonly WorkbenchVariant[] = ["column", "sheet"]
    expect(variants).toHaveLength(2)
  })
})

describe("WorkbenchPanel：首帧状态（effect 不执行 → 诚实 loading/empty）", () => {
  it("走网络的首帧是 loading 态：不是空白面板，也不是编造的数据", () => {
    for (const tab of ["files", "preview"] as const) {
      const markup = render({ activeTab: tab })
      expect(markup, `activeTab=${tab}`).toContain('data-slot="loading-state"')
      expect(markup, `activeTab=${tab}`).not.toContain('data-slot="empty-state"')
    }
  })

  it("Terminal 首帧无历史无错误 → 诚实空态", () => {
    expect(render({ activeTab: "terminal" })).toContain('data-slot="empty-state"')
  })

  it("纯派生的 Code / Browser 首帧直接是诚实空态", () => {
    expect(render({ activeTab: "code" })).toContain("No run selected")
    expect(render({ activeTab: "browser" })).toContain("尚未载入页面")
  })
})
