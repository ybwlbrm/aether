/**
 * AEX-P0-016 —— 把「HTTP 客户端断开」翻译成 AbortSignal。
 *
 * POST /api/workflows/:id/run 是长任务：客户端关掉页面 / 断开网络时，
 * Node 的 IncomingMessage 会先发 'aborted'，请求体未读完就 close 时也会 close。
 * 只有「请求体已完整读完（complete=true）后的正常 close」才不是断开。
 *
 * 引擎侧的 abort 与 runCancellationRegistry 汇流：
 * 同一个 AbortController 既被这里驱动，也被 runs/routes.ts 的 cancel() 驱动。
 */

export type AbortableRequest = {
  readonly raw: {
    readonly complete?: boolean
    readonly destroyed?: boolean
    once?: (event: string, listener: () => void) => unknown
    removeListener?: (event: string, listener: () => void) => unknown
    readonly on?: (event: string, listener: () => void) => unknown
    readonly off?: (event: string, listener: () => void) => unknown
  }
}

export type RequestAbortHandle = {
  readonly signal: AbortSignal
  /** 解除监听（路由 handler 收尾时调用，避免 listener 泄漏） */
  readonly dispose: () => void
}

export function createRequestAbortSignal(request: AbortableRequest): RequestAbortHandle {
  const controller = new AbortController()
  const raw = request.raw
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort()
  }
  const onClose = (): void => {
    // 请求体没收完就 close = 客户端中途断开；收完后的 close 是正常生命周期
    if (raw.complete !== true) abort()
  }

  const on = raw.once?.bind(raw) ?? raw.on?.bind(raw)
  const off = raw.removeListener?.bind(raw) ?? raw.off?.bind(raw)
  on?.call(raw, 'aborted', abort)
  on?.call(raw, 'close', onClose)

  if (raw.destroyed === true) abort()

  return {
    signal: controller.signal,
    dispose: () => {
      off?.call(raw, 'aborted', abort)
      off?.call(raw, 'close', onClose)
    },
  }
}
