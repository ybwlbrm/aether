import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { Composer, type ComposerKeyEvent, handleComposerKeyDown } from "./Composer"
import { ComposerToolbar, type ComposerToolbarProps } from "./ComposerToolbar"

function render(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  return renderToStaticMarkup(
    <Composer
      value=""
      onChange={() => undefined}
      onSubmit={() => undefined}
      onStop={() => undefined}
      sending={false}
      disabled={false}
      {...props}
    />,
  )
}

/** 一个键盘事件：只提供决策函数真正读取的字段（key / shiftKey / nativeEvent.isComposing） */
function keyEvent(over: { key: string; shiftKey?: boolean; isComposing?: boolean }): ComposerKeyEvent & {
  preventDefault: () => void
} {
  return {
    key: over.key,
    shiftKey: over.shiftKey ?? false,
    nativeEvent: { isComposing: over.isComposing ?? false },
    preventDefault: vi.fn(),
  }
}

function toolbar(over: Partial<ComposerToolbarProps> = {}): string {
  const props: ComposerToolbarProps = {
    mode: { mode: "normal", onModeChange: () => undefined },
    toggles: {
      deepThinking: false,
      onDeepThinkingToggle: () => undefined,
      webSearch: false,
      onWebSearchToggle: () => undefined,
      loopMode: false,
      onLoopModeToggle: () => undefined,
    },
    ...over,
  }
  return renderToStaticMarkup(<ComposerToolbar {...props} />)
}

describe("T18 Composer：输入表面", () => {
  it("空输入时渲染 send 且 send 为 disabled，不渲染 stop", () => {
    const markup = render({ value: "   " })

    expect(markup).toContain('aria-label="发送"')
    expect(markup).toContain("disabled")
    expect(markup).not.toContain('aria-label="停止生成"')
  })

  it("有输入时 send 可用（不渲染 disabled）", () => {
    const markup = render({ value: "跑一下测试" })

    expect(markup).toContain('aria-label="发送"')
    expect(markup).not.toContain("disabled")
  })

  it("disabled 时整个输入区只读且 send 不可用", () => {
    const markup = render({ value: "跑一下测试", disabled: true })

    expect(markup).toContain('readOnly=""')
    expect(markup).toContain('aria-label="发送"')
    expect(markup).toContain("disabled")
  })

  it("sending（有 run）时以 stop 取代 send，textarea 只读", () => {
    const markup = render({ value: "跑一下测试", sending: true })

    expect(markup).toContain('aria-label="停止生成"')
    expect(markup).not.toContain('aria-label="发送"')
    expect(markup).toContain('readOnly=""')
  })

  it("error 存在时渲染错误提示，不存在时不渲染", () => {
    expect(render({ error: "连接中断" })).toContain("连接中断")
    expect(render()).not.toContain("role=\"alert\"")
  })

  it("自动高度走 field-sizing（零 effect 的 CSS 增高），并夹在 1..8 行之间", () => {
    const markup = render({ value: "a" })

    expect(markup).toContain("field-sizing:content")
    expect(markup).toContain('rows="1"')
  })
})

describe("T18 Composer：键盘提交与 IME 守卫", () => {
  it("Enter 提交并阻止默认换行", () => {
    const onSubmit = vi.fn()
    const event = keyEvent({ key: "Enter" })

    handleComposerKeyDown(event, onSubmit)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it("Shift+Enter 换行，不提交也不阻止默认", () => {
    const onSubmit = vi.fn()
    const event = keyEvent({ key: "Enter", shiftKey: true })

    handleComposerKeyDown(event, onSubmit)

    expect(onSubmit).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it("IME 组合输入期间的 Enter 不提交（中文选词确认）", () => {
    const onSubmit = vi.fn()
    const event = keyEvent({ key: "Enter", isComposing: true })

    handleComposerKeyDown(event, onSubmit)

    expect(onSubmit).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it("其它按键（字符输入）既不提交也不阻止默认", () => {
    const onSubmit = vi.fn()
    const event = keyEvent({ key: "a" })

    handleComposerKeyDown(event, onSubmit)

    expect(onSubmit).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})

describe("T18 ComposerToolbar：紧凑图标行", () => {
  it("五个开关各自带 aria-pressed，按下态由 props 决定（无内部状态）", () => {
    const markup = toolbar({
      mode: { mode: "super", onModeChange: () => undefined },
      toggles: {
        deepThinking: true,
        onDeepThinkingToggle: () => undefined,
        webSearch: false,
        onWebSearchToggle: () => undefined,
        loopMode: true,
        onLoopModeToggle: () => undefined,
      },
    })

    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('aria-pressed="false"')
    // 按下态：super 模式 + 深度思考 + 循环
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(3)
  })

  it("每项都是图标按钮且带中文 aria-label（无文字 chrome）", () => {
    const markup = toolbar()

    for (const label of ["普通模式", "超级模式", "深度思考", "联网搜索", "循环模式"]) {
      expect(markup).toContain(`aria-label="${label}"`)
    }
    // 图标行不出现可见文字标签
    expect(markup).not.toContain("深度思考<")
  })

  it("disabled 时整行按钮不可用", () => {
    const markup = toolbar({ disabled: true })

    expect(markup).toContain("disabled")
    expect(markup).toContain('aria-disabled="true"')
  })
})
