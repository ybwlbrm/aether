import { ErrorState } from "../ui/error-state"
import type { StreamFailure } from "../../hooks/useStreamSend"

export interface StreamFailureStateProps {
  readonly failure: StreamFailure
  /**
   * 重试动作：缺省（或失败不可重试）时不渲染按钮 —— 绝不留下 disabled 死按钮。
   * 调用方负责提供语义真实的重试（如重新发送最后一条用户指令）。
   */
  readonly onRetry?: () => void
}

/**
 * 共享流式失败态 —— Chat 与 CodingHome 同一实现。
 * 失败是独立状态（不追加进助手正文），与 ui/error-state 契约一致。
 */
export function StreamFailureState({ failure, onRetry }: StreamFailureStateProps) {
  const retryAction = onRetry && failure.retryable ? (
    <button type="button" className="btn btn-ghost" onClick={onRetry}>
      重试
    </button>
  ) : undefined
  return (
    <ErrorState
      title="回复失败"
      description={failure.message}
      data-retryable={failure.retryable}
      action={retryAction}
    />
  )
}
