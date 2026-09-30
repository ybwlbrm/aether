import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import * as ChatModule from "./Chat"

type TestFailure = {
  readonly message: string
  readonly retryable: boolean
}

const chatState: { failure: TestFailure | null } = vi.hoisted(() => ({
  failure: null,
}))

vi.mock("../hooks", () => ({
  useConversations: () => ({
    conversations: [],
    convLoading: false,
    load: async () => undefined,
    handleNew: async () => undefined,
    handleSelect: async () => undefined,
    handleDelete: async () => undefined,
    handleRename: async () => undefined,
    setConversations: () => undefined,
  }),
  useStreamSend: () => ({
    handleSend: async () => undefined,
    stopGeneration: () => undefined,
    failure: chatState.failure,
  }),
  useMessagePolling: () => ({
    pollStatus: "idle",
    pollErrorInfo: null,
    retry: () => undefined,
  }),
}))

describe("Chat shared UI integration", () => {
  it("renders the shared page header contract in Chat", () => {
    const markup = renderToStaticMarkup(<ChatModule.Chat />)

    expect(markup).toContain('data-slot="page-header"')
    expect(markup).toContain('data-slot="page-header-title"')
    expect(markup).toContain("对话")
    expect(markup).toContain("与 AI 助手交流，管理多轮对话")
    expect(markup).toContain('data-slot="page-header-actions"')
    expect(markup).toContain("新建对话")
  })

  it("renders a thrown stream failure through ErrorState with a retry placeholder", () => {
    const StreamFailureState = ChatModule.ChatStreamFailure
    expect(StreamFailureState).toBeTypeOf("function")

    if (typeof StreamFailureState !== "function") return

    const markup = renderToStaticMarkup(
      <main>
        <StreamFailureState
          failure={{
            message: "network error: fetch failed",
            retryable: true,
          }}
        />
      </main>
    )

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("network error: fetch failed")
    expect(markup).toContain("重试")
    expect(markup).toContain("disabled")
    expect(markup).not.toContain("data-slot=\"message-bubble\"")
  })
})
