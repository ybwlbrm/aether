import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { StreamFailureState } from "./stream-failure"

function actionSlot(markup: string): string {
  return markup.match(/<div data-slot="error-state-action">([\s\S]*?)<\/div>/)?.[1] ?? ""
}

describe("AEX-P0-013：共享失败态的重试按钮契约", () => {
  it("传入 onRetry 时渲染可点击的重试按钮（不再硬编码 disabled）", () => {
    const onRetry = vi.fn()
    const markup = renderToStaticMarkup(
      <StreamFailureState failure={{ message: "network error: fetch failed", retryable: true }} onRetry={onRetry} />,
    )

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("network error: fetch failed")
    expect(actionSlot(markup)).toContain("重试")
    expect(actionSlot(markup)).not.toContain("disabled")
  })

  it("未接入重试动作时按语义不渲染按钮，绝不留下 disabled 死按钮", () => {
    const markup = renderToStaticMarkup(
      <StreamFailureState failure={{ message: "等待桌面端响应超时", retryable: true }} />,
    )

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("等待桌面端响应超时")
    expect(markup).not.toContain("重试")
    expect(actionSlot(markup)).toBe("")
  })

  it("失败不可重试时即使传入 onRetry 也不渲染重试按钮", () => {
    const markup = renderToStaticMarkup(
      <StreamFailureState failure={{ message: "指令被拒绝", retryable: false }} onRetry={() => undefined} />,
    )

    expect(markup).toContain('data-retryable="false"')
    expect(actionSlot(markup)).toBe("")
  })
})
