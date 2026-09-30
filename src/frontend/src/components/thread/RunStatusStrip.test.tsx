import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { RUN_STATUSES, type RunStatus } from "@pacc/shared"
import { RUN_STATUS_META } from "../../lib/run-status"
import { createRunStatusHandlers, RunStatusStrip, type RunStatusStripProps } from "./RunStatusStrip"

function render(props: Partial<RunStatusStripProps> & { status: RunStatus }): string {
  const merged: RunStatusStripProps = { runId: "run-1", ...props }
  return renderToStaticMarkup(<RunStatusStrip {...merged} />)
}

describe("RunStatusStrip：11 态真实状态条", () => {
  it("渲染 T5 的中文标签与语义色调", () => {
    for (const status of RUN_STATUSES) {
      const markup = render({ status })
      expect(markup).toContain(`data-status="${status}"`)
      expect(markup).toContain(`data-tone="${RUN_STATUS_META[status].tone}"`)
      expect(markup).toContain(RUN_STATUS_META[status].label)
    }
  })

  it("每个状态带自己的 --status-* CSS 变量引用（无硬编码色值）", () => {
    for (const status of RUN_STATUSES) {
      const markup = render({ status })
      expect(markup).toContain(`var(${RUN_STATUS_META[status].tokenVar})`)
    }
  })

  it("running：有 cancel 与 pause，无 resume", () => {
    const markup = render({ status: "running" })

    expect(markup).toContain('data-slot="thread-run-cancel"')
    expect(markup).toContain('data-slot="thread-run-pause"')
    expect(markup).not.toContain('data-slot="thread-run-resume"')
  })

  it("waiting：路由层允许 resume，故有 resume 无 pause", () => {
    const markup = render({ status: "waiting" })

    expect(markup).toContain('data-slot="thread-run-resume"')
    expect(markup).not.toContain('data-slot="thread-run-pause"')
  })

  it("retrying：不可 resume（路由层 gap：RunLifecycleManager 允许但 routes 拒绝）", () => {
    const markup = render({ status: "retrying" })

    expect(markup).not.toContain('data-slot="thread-run-resume"')
    expect(markup).toContain('data-slot="thread-run-cancel"')
  })

  it("completed：无任何生命周期动作按钮", () => {
    const markup = render({ status: "completed" })

    expect(markup).not.toContain('data-slot="thread-run-cancel"')
    expect(markup).not.toContain('data-slot="thread-run-pause"')
    expect(markup).not.toContain('data-slot="thread-run-resume"')
  })

  it("终态族（failed/cancelled/interrupted/budget_exceeded）同样无动作按钮", () => {
    for (const status of ["failed", "cancelled", "interrupted", "budget_exceeded"] as const) {
      const markup = render({ status })
      expect(markup).not.toContain('data-slot="thread-run-cancel"')
      expect(markup).not.toContain('data-slot="thread-run-resume"')
    }
  })

  it("动作按钮带语义标签，缺省回调时仍渲染 affordance（由外层接 controller）", () => {
    const markup = render({ status: "running" })

    expect(markup).toContain("暂停")
    expect(markup).toContain("取消")
  })

  it("onPause / onResume / onCancel 透传 runId 给外部 controller", () => {
    const onPause = vi.fn()
    const onCancel = vi.fn()
    const props: RunStatusStripProps = { runId: "run-42", status: "running", onPause, onCancel }

    renderToStaticMarkup(<RunStatusStrip {...props} />)
    onPause("run-42")
    onCancel("run-42")

    expect(onPause).toHaveBeenCalledWith("run-42")
    expect(onCancel).toHaveBeenCalledWith("run-42")
  })

  it("detail 插槽内容原样渲染在状态标签之后", () => {
    const markup = render({ status: "retry_waiting", detail: <span>第 2 次重试</span> })

    expect(markup).toContain("第 2 次重试")
  })
})

describe("createRunStatusHandlers：接 T2 runsApi 的动作工厂", () => {
  it("pause / resume / cancel 分别打到 runsApi 对应端点", async () => {
    const api = await import("../../api/runs")
    const pause = vi.spyOn(api.runsApi, "pauseRun").mockResolvedValue({} as never)
    const resume = vi.spyOn(api.runsApi, "resumeRun").mockResolvedValue({} as never)
    const cancel = vi.spyOn(api.runsApi, "cancelRun").mockResolvedValue({} as never)

    const handlers = createRunStatusHandlers(() => undefined)
    await Promise.all([handlers.onPause("r1"), handlers.onResume("r1"), handlers.onCancel("r1")])

    expect(pause).toHaveBeenCalledWith("r1")
    expect(resume).toHaveBeenCalledWith("r1")
    expect(cancel).toHaveBeenCalledWith("r1")
    pause.mockRestore()
    resume.mockRestore()
    cancel.mockRestore()
  })

  it("端点失败经 onError 上报，不静默吞掉 409", async () => {
    const api = await import("../../api/runs")
    const cancel = vi
      .spyOn(api.runsApi, "cancelRun")
      .mockRejectedValue(new Error("INVALID_TRANSITION"))

    const onError = vi.fn()
    const handlers = createRunStatusHandlers(onError)
    await handlers.onCancel("r1")

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("INVALID_TRANSITION")
    cancel.mockRestore()
  })
})
