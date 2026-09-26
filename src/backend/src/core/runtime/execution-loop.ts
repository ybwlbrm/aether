/**
 * Unified Execution Loop (P0-01/02/03/04/05/06) — 唯一生产级 Loop Controller
 *
 * 目标：普通 Chat、超级模式、Mobile Remote 全部收敛到同一套执行链：
 *   准备上下文 → 调用 Model → 文本/工具/推理 → 执行工具 → 注入结果
 *   → 判断是否继续 → 再次调用 Model → 判断任务是否完成 → 结束/继续/重试/取消
 *
 * 本模块 transport-agnostic：不依赖 Fastify/SSE/React/Supabase。
 * Model 调用经 ModelRuntime，工具执行经 ToolRuntime，取消经 AbortSignal。
 *
 * 语义（P0-02/03）：
 * - NORMAL：允许 Model→Tool→Tool Result→Model→Final Answer（必要的工具链）。
 *   一旦模型给出最终文本回答即结束 —— 禁止无 Loop 时自动重新问模型。
 * - LOOP：自主执行模式 —— Agent 判断任务是否完成、验证结果、继续执行，
 *   直到 COMPLETED / FAILED / CANCELLED / BUDGET_EXCEEDED。
 *
 * 预算（P0-04/05/06）：ExecutionBudget 由 AgentDefinition/RunPolicy 提供，
 * 每次 Model 调用前 / Tool 调用前 / 新 Turn 开始时检查；
 * 预算耗尽进入 finalization，禁止伪造成功。
 */

import type { ModelRequest, ModelResponse, ModelRuntime } from '../models/model-runtime.js'
import { streamToComplete } from '../models/model-runtime.js'
import type { StreamChunk } from '@pacc/shared'
import { RetryExhaustedError } from '../errors/index.js'
import { CancellationError, isCancellationError } from './cancellation.js'
import {
  ExecutionRetryController,
  ToolRecoveryController,
  type RetryEvent,
  type RetryType,
} from './execution-retry.js'

// ============================================================
// Completion State（P0-03：禁止仅靠"模型有没有输出文字"判断完成）
// ============================================================

export type CompletionState =
  | 'idle'
  | 'running'
  | 'waiting_tool'
  | 'verifying'
  | 'continuing'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded';

/**
 * §3.1 流式路径辅助：遍历 model.stream()，逐 chunk 实时转发给调用方（SSE 输出），
 * 同时用 streamToComplete 聚合出完整 ModelResponse —— 进入统一 Loop 不丢失实时输出。
 */
export async function completeFromStream(
  model: ModelRuntime,
  request: ModelRequest,
  onChunk: (chunk: StreamChunk) => void,
): Promise<ModelResponse> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of model.stream(request)) {
    chunks.push(chunk);
    try { onChunk(chunk); } catch { /* 转发失败不阻塞聚合 */ }
  }
  // 将收集到的 chunk 数组转为 AsyncIterable（streamToComplete 需要异步迭代）
  const asyncIterable: AsyncIterable<StreamChunk> = {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
  return streamToComplete(asyncIterable, {
    provider: request.provider,
    model: request.model,
  });
}

// ============================================================
// Execution Budget（P0-04：统一预算来源，由 AgentDefinition/RunPolicy 提供）
// ============================================================

export interface ExecutionBudget {
  maxTurns: number;         // 最大模型调用轮数（NORMAL 较小，LOOP 较大）
  maxToolCalls: number;     // 最大工具调用次数
  maxTimeMs: number;        // 最大执行时长（0 = 不限）
  maxTokens: number;        // 累计 token 上限（0 = 不限）
  maxCostCny: number;       // 费用上限（0 = 不限）
  /** 无 Provider 价格表时的估算费率（CNY / 百万 token） */
  estimatedCostCnyPerMillionTokens?: number;
}

export type BudgetExceededReason = 'turns' | 'tool_calls' | 'duration' | 'tokens' | 'cost' | 'none' | 'cancelled';

const DEFAULT_ESTIMATED_COST_CNY_PER_MILLION_TOKENS = 1;

/** Normal 模式预算：快速完成单轮请求（P0-07） */
export function normalExecutionBudget(): ExecutionBudget {
  return {
    maxTurns: 8,             // 足够完成必要工具链（Model→Tool→Model→...→Final）
    maxToolCalls: 30,
    maxTimeMs: 5 * 60 * 1000,
    maxTokens: 64_000,
    maxCostCny: 0,
  };
}

/** Loop 模式预算：允许持续执行与验证（P0-07） */
export function loopExecutionBudget(): ExecutionBudget {
  return {
    maxTurns: 30,
    maxToolCalls: 100,
    maxTimeMs: 30 * 60 * 1000,
    maxTokens: 128_000,
    maxCostCny: 0,
  };
}

/**
 * §31 修复：从 AgentDefinition limits 构造 ExecutionBudget。
 * AgentLimits 是配置源（maxTurns/maxToolCalls/maxTimeMs/maxTokens/maxParallelTasks），
 * 生产 ExecutionLoop 必须真正使用这些值，而非散落硬编码（30/50/128000/200）。
 * maxParallelTasks 不直接映射到单次 ExecutionLoop（由上层并发控制）。
 */
export interface AgentLimitsLike {
  maxTurns?: number;
  maxToolCalls?: number;
  maxTimeMs?: number;
  maxTokens?: number;
  maxParallelTasks?: number;
}

export function budgetFromAgentLimits(
  limits: AgentLimitsLike | undefined,
  loop: boolean,
): ExecutionBudget {
  // loop=false（Normal）：以快速完成单轮为目标，使用较小预算
  // loop=true（Loop）：允许持续执行与验证，使用更大预算
  const base = loop ? loopExecutionBudget() : normalExecutionBudget();
  if (!limits) return base;
  return {
    maxTurns: limits.maxTurns ?? base.maxTurns,
    maxToolCalls: limits.maxToolCalls ?? base.maxToolCalls,
    maxTimeMs: limits.maxTimeMs ?? base.maxTimeMs,
    maxTokens: limits.maxTokens ?? base.maxTokens,
    maxCostCny: base.maxCostCny,
  };
}

// ============================================================
// Execution Usage（P0-08：区分 cumulative 与 lastRequest）
// ============================================================

export interface ExecutionUsage {
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeTotalTokens: number;
  lastRequestInputTokens: number;
  lastRequestOutputTokens: number;
  lastRequestTotalTokens: number;
}

export function createExecutionUsage(): ExecutionUsage {
  return {
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeTotalTokens: 0,
    lastRequestInputTokens: 0,
    lastRequestOutputTokens: 0,
    lastRequestTotalTokens: 0,
  };
}

/** 累加一次 Model 调用用量（delta 语义：total = newInput + newOutput） */
export function accumulateUsage(usage: ExecutionUsage, chunkUsage?: { inputTokens?: number; outputTokens?: number }): void {
  const input = chunkUsage?.inputTokens ?? 0;
  const output = chunkUsage?.outputTokens ?? 0;
  usage.lastRequestInputTokens = input;
  usage.lastRequestOutputTokens = output;
  usage.lastRequestTotalTokens = input + output;
  usage.cumulativeInputTokens += input;
  usage.cumulativeOutputTokens += output;
  usage.cumulativeTotalTokens = usage.cumulativeInputTokens + usage.cumulativeOutputTokens;
}

// ============================================================
// Execution Loop Result
// ============================================================

export interface ExecutionLoopResult {
  state: CompletionState;
  content: string;
  reasoningContent?: string;
  toolCallCount: number;
  turnsUsed: number;
  elapsedMs: number;
  budgetExceeded: BudgetExceededReason;
  usage: ExecutionUsage;
  interrupted?: boolean;
  /** 最后一轮 Provider finish reason，供调用方区分正常与异常结束 */
  finishReason?: ModelResponse['finishReason']
  /** 任务级自动重试次数（不占用 turnsUsed） */
  retryCount: number
  /** 重试耗尽标记；state 仍为 failed 以兼容既有终态协议 */
  retryExhausted?: boolean
  /** retry_exhausted 终态标识（不改变既有 failed state 契约） */
  terminalState?: 'retry_exhausted'
}

// ============================================================
// 执行工具接口（由调用方注入 ToolRuntime 适配）
// ============================================================

export interface AssistantToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: string
  readonly reasoning_content?: string
  readonly tool_calls?: readonly AssistantToolCall[]
}

export interface AssistantToolCallMessage extends AssistantMessage {
  readonly tool_calls: readonly AssistantToolCall[]
}

export interface ExecutionTool {
  name: string;
  arguments: string;
  /** 工具调用 ID（tool_call_id，用于将 tool result 关联回模型请求） */
  id: string;
}

export interface ExecutionLoopDeps {
  /** 模型调用（统一经 ModelRuntime → RetryPolicy） */
  model: ModelRuntime;
  /** 构造 ModelRequest（调用方注入当前上下文/消息/Prompt） */
  buildRequest: (messages: Array<Record<string, unknown>>, turn: number) => ModelRequest;
  /** 执行工具并返回结果文本（ToolRuntime 适配） */
  executeTool: (tool: ExecutionTool, turn: number) => Promise<string>;
  /** 是否有工具定义（无工具时模型无法发起 tool_calls） */
  hasTools: boolean
  /** 运行标识，用于 attempt/retry 事件 */
  runId?: string
  /** 任务标识，用于 attempt/retry 事件 */
  taskId?: string
  /** 事件回调（可选，供 Activity/SSE） */
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** assistant tool_calls 持久化回调（可选，工具结果写入前调用） */
  onAssistantToolCalls?: (message: AssistantToolCallMessage, turn: number) => void;
  /**
   * §3.1 流式 chunk 转发（可选）：提供后，Loop 内部优先使用 model.stream() 而非 complete()，
   * 把 text-delta/reasoning-delta/tool-call/usage 等实时 chunk 转发给调用方（SSE 实时输出），
   * 同时内部仍按统一语义聚合出 ModelResponse 驱动完成判断 —— 进入统一 Loop 不丢失实时输出。
   */
  onChunk?: (chunk: StreamChunk) => void;
  /**
   * §3.2 Loop 完成判定钩子（可选）：仅 Loop 模式生效。模型返回"无工具调用"的纯文本后，
   * 调用方用此钩子判断"任务是否真的完成"（而非"有文本就算完成"）。
   * - 返回 true → completed
   * - 返回 false → verifying/continuing，继续下一轮（预算内），实现"执行→验证→继续→完成"
   * 缺省：content 非空即视为完成（与 Normal 一致，保持兼容）。
   */
  isTaskComplete?: (response: ModelResponse, messages: Array<Record<string, unknown>>) => boolean;
}

// ============================================================
// Unified Execution Loop
// ============================================================

export interface ExecutionLoopRetryOptions {
  taskMaxRetries?: number
  toolMaxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: number
  retryType?: RetryType
}

export interface RunExecutionLoopOptions {
  budget?: ExecutionBudget
  loop?: boolean
  signal?: AbortSignal
  runId?: string
  taskId?: string
  retry?: ExecutionLoopRetryOptions
}

/**
 * 统一执行循环（P0-01/02/03）。
 *
 * Normal（loop=false）：
 *   - 允许 Model→Tool→Tool Result→Model 的必要工具链
 *   - 一旦模型给出最终文本（无 tool_calls）即结束
 *
 * Loop（loop=true）：
 *   - 每次 Model 调用后检查：有 tool_calls → 执行并继续；无 tool_calls → 判断完成
 *   - 预算耗尽 → budget_exceeded + finalization
 *   - 取消 → cancelled
 */
type LoopTurnOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'completed'; readonly response: ModelResponse }
  | { readonly kind: 'interrupted'; readonly response: ModelResponse; readonly state: 'failed' | 'interrupted' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget'; readonly reason: BudgetExceededReason }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasToolResultMessage(
  messages: readonly Record<string, unknown>[],
  toolCallId: string,
): boolean {
  return messages.some((message) => message.role === 'tool' && message.tool_call_id === toolCallId)
}

export async function runExecutionLoop(
  deps: ExecutionLoopDeps,
  initialMessages: Array<Record<string, unknown>>,
  opts: RunExecutionLoopOptions = {},
): Promise<ExecutionLoopResult> {
  const budget = opts.budget ?? (opts.loop ? loopExecutionBudget() : normalExecutionBudget())
  const usage = createExecutionUsage()
  const messages = [...initialMessages]
  let turnsUsed = 0
  let toolCallCount = 0
  let retryCount = 0
  let retryExhausted = false
  let terminalState: 'retry_exhausted' | undefined
  let state: CompletionState = 'idle'
  let budgetExceeded: BudgetExceededReason = 'none'
  let content = ''
  let reasoningContent = ''
  let interrupted = false
  let finishReason: ModelResponse['finishReason'] | undefined

  const runId = opts.runId ?? deps.runId ?? 'unknown'
  const taskId = opts.taskId ?? deps.taskId ?? runId
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      deps.onEvent?.(type, payload)
    } catch {
      // Activity observers cannot change execution state.
    }
  }
  const emitRetryEvent = (event: RetryEvent): void => {
    emit(event.type, { ...event.payload })
  }

  const retryOptions = opts.retry ?? {}
  const taskController = new ExecutionRetryController({
    runId,
    taskId,
    maxRetries: retryOptions.taskMaxRetries,
    baseDelayMs: retryOptions.baseDelayMs,
    maxDelayMs: retryOptions.maxDelayMs,
    jitter: retryOptions.jitter,
    retryType: retryOptions.retryType,
    signal: opts.signal,
    onEvent: emitRetryEvent,
  })
  const toolController = new ToolRecoveryController({
    runId,
    taskId,
    maxRetries: retryOptions.toolMaxRetries,
    baseDelayMs: retryOptions.baseDelayMs,
    maxDelayMs: retryOptions.maxDelayMs,
    jitter: retryOptions.jitter,
    retryType: retryOptions.retryType,
    signal: opts.signal,
    onEvent: emitRetryEvent,
    checkpoint: taskController.checkpoint,
  })

  const startedAt = Date.now()
  const checkBudget = (): BudgetExceededReason => {
    const elapsedMs = Date.now() - startedAt
    if (budget.maxTurns > 0 && turnsUsed >= budget.maxTurns) return 'turns'
    if (budget.maxToolCalls > 0 && toolCallCount >= budget.maxToolCalls) return 'tool_calls'
    if (budget.maxTimeMs > 0 && turnsUsed > 0 && elapsedMs >= budget.maxTimeMs) return 'duration'
    if (budget.maxTokens > 0 && usage.cumulativeTotalTokens >= budget.maxTokens) return 'tokens'
    if (budget.maxCostCny > 0) {
      const rate = budget.estimatedCostCnyPerMillionTokens ?? DEFAULT_ESTIMATED_COST_CNY_PER_MILLION_TOKENS
      const estimatedCostCny = usage.cumulativeTotalTokens * rate / 1_000_000
      if (estimatedCostCny > budget.maxCostCny) return 'cost'
    }
    return 'none'
  }

  const executeTurn = async (): Promise<LoopTurnOutcome> => {
    let request: ModelRequest
    try {
      request = deps.buildRequest(messages, turnsUsed)
    } catch (error: unknown) {
      return { kind: 'failed', error }
    }

    let response: ModelResponse
    try {
      response = deps.onChunk
        ? await completeFromStream(deps.model, request, deps.onChunk)
        : await deps.model.complete(request)
    } catch (error: unknown) {
      if (opts.signal?.aborted || isCancellationError(error)) {
        throw new CancellationError('Execution cancelled', error)
      }
      throw error
    }

    accumulateUsage(usage, response.usage)
    finishReason = response.finishReason
    if (opts.signal?.aborted) throw new CancellationError('Execution cancelled', opts.signal.reason)
    if (response.interrupted) return { kind: 'interrupted', response, state: 'failed' }

    const postModelExceeded = checkBudget()
    if (postModelExceeded !== 'none') return { kind: 'budget', reason: postModelExceeded }

    if (response.toolCalls && response.toolCalls.length > 0 && !deps.hasTools) {
      const names = response.toolCalls.map((toolCall) => toolCall.name).join(', ')
      return { kind: 'failed', error: `模型返回了未启用的工具调用: ${names}` }
    }

    const assistantMessage: Record<string, unknown> = {
      role: 'assistant',
      content: response.content,
    }
    if (response.reasoningContent) {
      reasoningContent += response.reasoningContent
      assistantMessage.reasoning_content = response.reasoningContent
    }
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCalls: AssistantToolCall[] = response.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }))
      assistantMessage.tool_calls = toolCalls
      messages.push(assistantMessage)
      try {
        deps.onAssistantToolCalls?.({
          role: 'assistant',
          content: response.content,
          ...(typeof assistantMessage.reasoning_content === 'string'
            ? { reasoning_content: assistantMessage.reasoning_content }
            : {}),
          tool_calls: toolCalls,
        }, turnsUsed)
      } catch (error: unknown) {
        return { kind: 'failed', error }
      }
    } else {
      messages.push(assistantMessage)
    }

    if (response.toolCalls && response.toolCalls.length > 0 && deps.hasTools) {
      emit('execution.tool_calls', { turn: turnsUsed, count: response.toolCalls.length })
      for (const toolCall of response.toolCalls) {
        if (opts.signal?.aborted) throw new CancellationError('Execution cancelled', opts.signal.reason)
        const cachedResult = taskController.getToolResult(toolCall.id, toolCall.arguments)
        if (cachedResult !== undefined) {
          if (!hasToolResultMessage(messages, toolCall.id)) {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: cachedResult })
            content += cachedResult.slice(0, 500)
          }
          emit('execution.tool_completed', {
            turn: turnsUsed,
            tool: toolCall.name,
            status: 'completed',
            checkpoint: true,
          })
          continue
        }

        const toolExceeded = checkBudget()
        if (toolExceeded !== 'none') return { kind: 'budget', reason: toolExceeded }
        toolCallCount++
        emit('execution.tool_started', { turn: turnsUsed, tool: toolCall.name })
        try {
          const result = await toolController.run(
            toolCall.id,
            () => deps.executeTool({
              name: toolCall.name,
              arguments: toolCall.arguments,
              id: toolCall.id,
            }, turnsUsed),
            { arguments: toolCall.arguments, signal: opts.signal },
          )
          taskController.markToolCompleted(toolCall.id, result, toolCall.arguments)
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
          content += result.slice(0, 500)
          emit('execution.tool_completed', {
            turn: turnsUsed,
            tool: toolCall.name,
            status: 'completed',
          })
        } catch (error: unknown) {
          if (opts.signal?.aborted || isCancellationError(error)) {
            throw new CancellationError('Execution cancelled', error)
          }
          const result = `[tool_error] ${errorMessage(error)}`
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
          content += result.slice(0, 500)
          emit('execution.tool_completed', {
            turn: turnsUsed,
            tool: toolCall.name,
            status: 'failed',
          })
          if (error instanceof RetryExhaustedError) throw error
        }
      }
      return { kind: 'continue' }
    }

    if (response.finishReason === 'max-tokens' || response.finishReason === 'content_filter') {
      interrupted = true
      return { kind: 'interrupted', response, state: 'interrupted' }
    }
    if (response.finishReason === 'error') {
      return { kind: 'failed', error: 'Provider returned finish reason: error' }
    }

    if (opts.loop) {
      emit('execution.verifying', { turn: turnsUsed, contentLength: response.content.length })
      let taskComplete: boolean
      try {
        taskComplete = deps.isTaskComplete
          ? deps.isTaskComplete(response, messages)
          : response.content.trim() !== ''
      } catch (error: unknown) {
        return { kind: 'failed', error: `isTaskComplete 抛错: ${errorMessage(error)}` }
      }
      if (taskComplete) return { kind: 'completed', response }
      emit('execution.continuing', { turn: turnsUsed, reason: 'task_incomplete' })
      return { kind: 'continue' }
    }

    return { kind: 'completed', response }
  }

  emit('execution.started', { loop: !!opts.loop, budget, runId, taskId })
  state = 'running'

  try {
    while (true) {
      const exceeded = checkBudget()
      if (exceeded !== 'none') {
        budgetExceeded = exceeded
        state = 'budget_exceeded'
        emit('execution.budget_exceeded', {
          reason: exceeded,
          turnsUsed,
          toolCallCount,
          elapsedMs: Date.now() - startedAt,
        })
        break
      }
      if (opts.signal?.aborted) {
        state = 'cancelled'
        budgetExceeded = 'cancelled'
        emit('execution.cancelled', { turnsUsed, toolCallCount, runId, taskId })
        break
      }

      turnsUsed++
      emit('execution.turn_started', { turn: turnsUsed, runId, taskId })
      let outcome: LoopTurnOutcome
      try {
        outcome = await taskController.run(executeTurn, {
          signal: opts.signal,
          onRetry: (error) => {
            retryCount += 1
            messages.push({
              role: 'system',
              content: `[task_retry] 上一次尝试失败: ${errorMessage(error)}`,
            })
          },
        })
      } catch (error: unknown) {
        if (opts.signal?.aborted || isCancellationError(error)) {
          state = 'cancelled'
          budgetExceeded = 'cancelled'
          emit('execution.cancelled', { turnsUsed, toolCallCount, runId, taskId })
          break
        }
        if (error instanceof RetryExhaustedError) {
          retryExhausted = true
          terminalState = 'retry_exhausted'
          finishReason = 'error'
          state = 'failed'
          content = errorMessage(error)
          emit('execution.retry_exhausted', {
            turn: turnsUsed,
            attempt: error.attempt,
            maxAttempts: error.maxAttempts,
            error: content,
          })
          emit('execution.failed', { turn: turnsUsed, error: content, retryExhausted: true })
          break
        }
        state = 'failed'
        content = errorMessage(error)
        emit('execution.failed', { turn: turnsUsed, error: content })
        break
      }

      taskController.checkpoint.clear()
      const shouldStop = outcome.kind !== 'continue'
      switch (outcome.kind) {
        case 'continue':
          state = 'continuing'
          continue
        case 'completed':
          content = outcome.response.content
          state = 'completed'
          emit('execution.completed', { turn: turnsUsed, contentLength: content.length })
          break
        case 'interrupted':
          interrupted = true
          content = outcome.response.content
          reasoningContent = outcome.response.reasoningContent ?? reasoningContent
          state = outcome.state
          emit('execution.interrupted', { turn: turnsUsed, partialContent: content })
          break
        case 'failed':
          state = 'failed'
          content = errorMessage(outcome.error)
          emit('execution.failed', { turn: turnsUsed, error: content })
          break
        case 'cancelled':
          state = 'cancelled'
          budgetExceeded = 'cancelled'
          emit('execution.cancelled', { turnsUsed, toolCallCount, runId, taskId })
          break
        case 'budget':
          state = 'budget_exceeded'
          budgetExceeded = outcome.reason
          emit('execution.budget_exceeded', {
            reason: outcome.reason,
            turnsUsed,
            toolCallCount,
            elapsedMs: Date.now() - startedAt,
          })
          break
      }
      if (shouldStop) break
    }

    if (state === 'budget_exceeded') {
      const why = finalizeOnBudgetExceeded(budgetExceeded, turnsUsed, toolCallCount)
      content = content.trim() !== '' ? `${content}\n\n---\n${why}` : why
      emit('execution.finalized', { reason: budgetExceeded, content })
    }
  } finally {
    emit('execution.ended', {
      state,
      turnsUsed,
      toolCallCount,
      retryCount,
      elapsedMs: Date.now() - startedAt,
    })
  }

  return {
    state,
    content,
    reasoningContent: reasoningContent || undefined,
    toolCallCount,
    turnsUsed,
    elapsedMs: Date.now() - startedAt,
    budgetExceeded,
    usage,
    retryCount,
    ...(interrupted ? { interrupted: true as const } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(retryExhausted ? { retryExhausted: true as const } : {}),
    ...(terminalState ? { terminalState } : {}),
  }
}

/** P0-06：预算耗尽结构化总结（非伪造成功） */
export function finalizeOnBudgetExceeded(reason: BudgetExceededReason, turnsUsed: number, toolCallCount: number): string {
  const why = reason === 'turns' ? '已达到最大轮数'
    : reason === 'tool_calls' ? '已达到工具调用上限'
    : reason === 'duration' ? '执行时间超限'
    : reason === 'tokens' ? 'Token 预算耗尽'
    : reason === 'cost' ? '费用预算耗尽'
    : '执行预算耗尽';
  return `⚠️ ${why}（已执行 ${turnsUsed} 轮、${toolCallCount} 次工具调用）。任务可能未完全完成，如需继续请再次发送指令。`;
}
