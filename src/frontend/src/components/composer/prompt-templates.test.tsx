import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PromptTemplates } from "./PromptTemplates"

function render(props: Partial<Parameters<typeof PromptTemplates>[0]> = {}): string {
  return renderToStaticMarkup(
    <PromptTemplates open={false} onOpenChange={() => undefined} onSelect={() => undefined} {...props} />,
  )
}

describe("T18 PromptTemplates：既有模板选择器的受控外壳", () => {
  // 既有选择器是 client-only 的 portal 组件（createPortal → document.body），
  // renderToStaticMarkup 渲染不了 open=true 分支（"Target container is not a DOM element"）。
  // 因此这里只断言 SSR 可见的契约：关闭态的外壳形态与门控；开合由 onOpenChange 全权下发。
  it("渲染一个低调的模板触发按钮，并把关闭态透出为 aria-expanded=false", () => {
    const markup = render()

    expect(markup).toContain('aria-label="提示词模板"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('data-slot="composer-templates"')
  })

  it("capability 关（enabled=false）时不产生任何 DOM", () => {
    expect(render({ enabled: false })).toBe("")
  })

  it("关闭时外壳只有一个触发按钮：既有选择器（portal + 模板列表）零 DOM", () => {
    const markup = render()

    expect(markup.startsWith("<button")).toBe(true)
    expect(markup.endsWith("</button>")).toBe(true)
    expect(markup).not.toContain("fixed inset-0")
    expect(markup).not.toContain("保存当前输入为模板")
    expect(markup).not.toContain("暂无模板")
  })

  it("disabled 时触发按钮不可用", () => {
    expect(render({ disabled: true })).toContain("disabled")
  })

  it("当前输入不被外壳写进 DOM（只作为 currentInput 下发给既有选择器）", () => {
    const markup = render({ currentInput: "SENTINEL-当前输入" })

    expect(markup).not.toContain("SENTINEL-当前输入")
    expect(markup).toContain('aria-label="提示词模板"')
  })
})
