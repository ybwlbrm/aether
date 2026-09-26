/**
 * TaskCompletionEvaluator — W6 Loop 完成判定基础模块。
 *
 * 该模块只负责把当前执行证据转换为结构化 verdict，不负责调用模型、
 * 执行工具或修改消息历史。W4 完成后再由主控注入 execution-loop。
 */

export type CompletionStatus =
  | 'complete'
  | 'continue'
  | 'verify_required'
  | 'needs_correction'

export type CompletionToolCall = {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export type CompletionResponse = {
  readonly content: string
  readonly toolCalls?: readonly CompletionToolCall[]
  readonly finishReason?: string
  readonly interrupted?: boolean
}

export type CompletionMessage = Readonly<Record<string, unknown>>

export type CompletionToolResult = Readonly<Record<string, unknown>>

export interface TaskCompletionEvaluator {
  readonly taskObjective: string
  readonly taskPrompt?: string
  readonly messageHistory: readonly CompletionMessage[]
  readonly completedToolResults: readonly CompletionToolResult[]
  readonly hasError: boolean
  readonly hasExpectedArtifact: boolean
  readonly currentResponse: CompletionResponse
  readonly pendingSteps?: readonly string[]
  readonly pendingTools?: readonly CompletionToolCall[]
  readonly hasPendingWork?: boolean
  readonly objectiveSatisfied?: boolean
}

export interface CompletionVerdict {
  readonly status: CompletionStatus
  readonly reason: string
  readonly suggestedInstruction: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasText(response: CompletionResponse): boolean {
  return response.content.trim().length > 0
}

function hasToolFailure(results: readonly CompletionToolResult[]): boolean {
  return results.some(result => {
    if (!isRecord(result)) return false
    const status = result.status
    const kind = result.kind
    return status === 'failed'
      || status === 'error'
      || kind === 'error'
      || kind === 'timeout'
      || kind === 'cancelled'
      || result.success === false
      || result.validationFailed === true
      || (result.error !== undefined && result.error !== null)
  })
}

function hasPendingToolResult(results: readonly CompletionToolResult[]): boolean {
  return results.some(result => {
    if (!isRecord(result)) return false
    return result.status === 'pending'
      || result.status === 'waiting'
      || result.kind === 'pending-approval'
      || result.kind === 'pending'
  })
}

function hasUnresolvedHistoricalToolCall(messages: readonly CompletionMessage[]): boolean {
  const answeredCallIds = new Set<string>()

  for (const message of messages) {
    if (!isRecord(message)) continue
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      answeredCallIds.add(message.tool_call_id)
    }
  }

  return messages.some(message => {
    if (!isRecord(message) || message.role !== 'assistant') return false
    if (!Array.isArray(message.tool_calls)) return false

    return message.tool_calls.some(toolCall => {
      if (!isRecord(toolCall) || typeof toolCall.id !== 'string') return false
      return !answeredCallIds.has(toolCall.id)
    })
  })
}

function hasResponseError(response: CompletionResponse): boolean {
  return response.interrupted === true
    || response.finishReason === 'error'
    || response.finishReason === 'content_filter'
    || response.finishReason === 'max-tokens'
}

function createVerdict(
  status: CompletionStatus,
  reason: string,
  suggestedInstruction: string,
): CompletionVerdict {
  return { status, reason, suggestedInstruction }
}

export function evaluateTaskCompletion(input: TaskCompletionEvaluator): CompletionVerdict {
  const { currentResponse } = input
  const pendingTools = input.pendingTools ?? []
  const hasPendingWork = input.hasPendingWork === true
    || (input.pendingSteps?.length ?? 0) > 0
    || pendingTools.length > 0
    || (currentResponse.toolCalls?.length ?? 0) > 0
    || hasUnresolvedHistoricalToolCall(input.messageHistory)
    || hasPendingToolResult(input.completedToolResults)

  if (input.hasError || hasToolFailure(input.completedToolResults) || hasResponseError(currentResponse)) {
    return createVerdict(
      'needs_correction',
      '执行过程中出现错误、失败结果或未完成的中断响应',
      '分析错误原因，修正参数或执行策略后重试。',
    )
  }

  if (hasPendingWork) {
    return createVerdict(
      'continue',
      '仍有待执行工具或未完成步骤',
      '继续执行待处理项，并在获得结果后重新评估任务。',
    )
  }

  const objectiveSatisfied = input.objectiveSatisfied ?? input.hasExpectedArtifact
  if (objectiveSatisfied) {
    return createVerdict(
      'complete',
      '任务目标已满足且没有待执行项',
      '任务目标已满足且无待执行项，结束执行并返回最终结果。',
    )
  }

  if (hasText(currentResponse)) {
    return createVerdict(
      'continue',
      '当前只有进度文本，尚未有证据证明任务目标已满足',
      `继续完成“${input.taskObjective}”，不要仅输出进度文本。`,
    )
  }

  return createVerdict(
    'verify_required',
    '当前没有可验证的文本或 artifact，无法确认任务是否完成',
    '执行一次明确的任务验证，并在验证通过后结束执行。',
  )
}
