import type { ExecutionLoopResult } from '../../core/runtime/execution-loop.js'

type LoopOutcomeInput = {
  readonly state: ExecutionLoopResult['state']
  readonly content: string
  readonly interrupted?: boolean
  readonly finishReason?: ExecutionLoopResult['finishReason']
  readonly budgetExceeded: ExecutionLoopResult['budgetExceeded']
}

export type RemoteCommandRunOutcome =
  | { readonly kind: 'complete'; readonly endReason: 'completed' }
  | {
      readonly kind: 'fail'
      readonly endReason: 'error' | 'budget_exceeded' | 'interrupted'
      readonly error: string
    }
  | { readonly kind: 'cancel'; readonly endReason: 'aborted'; readonly error: string }

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function assertNever(value: never): never {
  throw new Error(`未知的 ExecutionLoop 状态: ${value}`)
}

function failedOutcome(
  endReason: 'error' | 'budget_exceeded' | 'interrupted',
  result: LoopOutcomeInput,
  errorMessage?: string,
  fallback = 'Execution loop failed',
  includeResultContent = true,
): RemoteCommandRunOutcome {
  return {
    kind: 'fail',
    endReason,
    error: firstNonEmpty(errorMessage, includeResultContent ? result.content : null) ?? fallback,
  }
}

/** 将 ExecutionLoop 的真实终态映射为 Remote Run 终态，禁止失败伪装成完成。 */
export function mapExecutionLoopResult(
  result: LoopOutcomeInput,
  signalAborted: boolean,
  errorMessage?: string,
): RemoteCommandRunOutcome {
  if (signalAborted || result.state === 'cancelled' || result.budgetExceeded === 'cancelled') {
    return {
      kind: 'cancel',
      endReason: 'aborted',
      error: firstNonEmpty(errorMessage, result.content) ?? 'cancelled by user',
    }
  }

  if (result.interrupted === true || result.state === 'interrupted' || result.finishReason === 'max-tokens' || result.finishReason === 'content_filter') {
    return failedOutcome(
      'interrupted',
      result,
      errorMessage,
      'Execution stream interrupted before finish',
      false,
    )
  }

  if (result.finishReason === 'error') {
    return failedOutcome('error', result, errorMessage, 'Model returned finish reason: error')
  }

  switch (result.state) {
    case 'completed':
      return { kind: 'complete', endReason: 'completed' }
    case 'failed':
      return failedOutcome('error', result, errorMessage)
    case 'budget_exceeded':
      return failedOutcome(
        'budget_exceeded',
        result,
        errorMessage,
        `Execution budget exceeded: ${result.budgetExceeded}`,
      )
    case 'idle':
    case 'running':
    case 'waiting_tool':
    case 'verifying':
    case 'continuing':
      return failedOutcome(
        'error',
        result,
        errorMessage,
        `Execution loop ended in state: ${result.state}`,
      )
    default:
      return assertNever(result.state)
  }
}
