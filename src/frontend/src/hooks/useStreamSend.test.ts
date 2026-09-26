import { describe, expect, it } from "vitest"

import {
  createFailedStream,
  createStreamFailure,
  isStreamAbortError,
} from "./useStreamSend"

describe("useStreamSend failure state", () => {
  it("keeps partial assistant content separate when the stream throws", () => {
    const result = createFailedStream(
      "已经收到的真实回复",
      new TypeError("network error: fetch failed")
    )

    expect(result).toEqual({
      content: "已经收到的真实回复",
      failure: {
        message: "network error: fetch failed",
        retryable: true,
      },
    })
    expect(result.content).not.toContain("network error")
  })

  it("normalizes a truncated stream into an independent retryable failure", () => {
    const failure = createStreamFailure(
      new Error("stream-truncated: 未收到业务终结事件（连接可能中断）")
    )

    expect(failure).toEqual({
      message: "响应流中断（未收到完整结束标记）",
      retryable: true,
    })
  })

  it("distinguishes network TypeErrors from user aborts", () => {
    const networkError = new TypeError("Load failed")
    const abortError = new DOMException("The user aborted a request", "AbortError")

    expect(isStreamAbortError(networkError)).toBe(false)
    expect(isStreamAbortError(abortError)).toBe(true)
  })
})
