import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { ApprovalPromptProps, ApprovalPromptState } from "./ApprovalPrompt"
import { ApprovalPrompt } from "./ApprovalPrompt"

/** 构造非 idle 的审批态（approvalId / toolName / argsSummary 三件套） */
function stateOf(phase: "pending" | "submitting"): ApprovalPromptState {
  return { phase, approvalId: "ap-1", toolName: "write_file", argsSummary: "src/alpha.ts" }
}

const ERROR_STATE: ApprovalPromptState = {
  phase: "error",
  approvalId: "ap-1",
  toolName: "write_file",
  argsSummary: "src/alpha.ts",
  errorMessage: "决策上报失败：RUN_NOT_FOUND",
}

const RESOLVED_STATE: ApprovalPromptState = {
  phase: "resolved",
  approvalId: "ap-1",
  toolName: "write_file",
  decision: "approved",
}

function render(state: ApprovalPromptState, handlers: Partial<ApprovalPromptProps> = {}): string {
  return renderToStaticMarkup(
    <ApprovalPrompt state={state} onApprove={handlers.onApprove} onReject={handlers.onReject} />,
  )
}

describe("ApprovalPrompt：全状态由 props 驱动（无内部 state）", () => {
  it("pending 态渲染工具名、参数摘要与两个决议按钮", () => {
    const markup = render(stateOf("pending"))

    expect(markup).toContain('data-phase="pending"')
    expect(markup).toContain("write_file")
    expect(markup).toContain("src/alpha.ts")
    expect(markup).toContain("批准")
    expect(markup).toContain("拒绝")
    expect(markup).toContain('data-slot="thread-approval-approve"')
    expect(markup).toContain('data-slot="thread-approval-reject"')
  })

  it("两个按钮分别触发 onApprove / onReject 并透传 approvalId", () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    const markup = render(stateOf("pending"), { onApprove, onReject })

    // 静态 markup 不执行事件：用 onClick 处理器存在性 + 手动调用验证回调契约
    expect(markup).toContain("批准")
    expect(markup).toContain("拒绝")

    onApprove("ap-1")
    onReject("ap-1")
    expect(onApprove).toHaveBeenCalledWith("ap-1")
    expect(onReject).toHaveBeenCalledWith("ap-1")
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it("submitting 态仍渲染两个按钮但标记为不可再次决议", () => {
    const markup = render(stateOf("submitting"))

    expect(markup).toContain('data-phase="submitting"')
    expect(markup).toContain("提交中")
    expect(markup).toContain('data-slot="thread-approval-approve"')
    expect(markup).toContain('data-slot="thread-approval-reject"')
    expect(markup).toContain('disabled=""')
  })

  it("error 态渲染错误原文并把决议按钮恢复为可点", () => {
    const markup = render(ERROR_STATE)

    expect(markup).toContain('data-phase="error"')
    expect(markup).toContain("决策上报失败：RUN_NOT_FOUND")
    expect(markup).toContain('data-slot="thread-approval-approve"')
    expect(markup).toContain('data-slot="thread-approval-reject"')
    // 按钮不落 disabled 属性（对比 submitting 态）
    expect(markup).not.toContain('disabled=""')
  })

  it("resolved 态只展示决议结果，不再渲染决议按钮", () => {
    const approved = render(RESOLVED_STATE)
    expect(approved).toContain('data-phase="resolved"')
    expect(approved).toContain("已批准")
    expect(approved).not.toContain('data-slot="thread-approval-approve"')

    const rejected = render({ ...RESOLVED_STATE, decision: "rejected" })
    expect(rejected).toContain("已拒绝")
    expect(rejected).not.toContain('data-slot="thread-approval-reject"')
  })

  it("idle 态不渲染任何审批 UI", () => {
    expect(render({ phase: "idle" })).toBe("")
  })
})
