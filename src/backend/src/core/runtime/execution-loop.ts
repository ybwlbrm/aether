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

import type { ModelRequest, ModelResponse, ModelRuntime } from '../models/model-runtime.js';
import { streamToComplete } from '../models/model-runtime.js';
import type { StreamChunk } from '@pacc/shared';

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
}

export type BudgetExceededReason = 'turns' | 'tool_calls' | 'duration' | 'tokens' | 'cost' | 'none' | 'cancelled';

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
}

// ============================================================
// 执行工具接口（由调用方注入 ToolRuntime 适配）
// ============================================================

export interface ExecutionTool {
  name: string;
  arguments: string;
  /** 工具调用 ID（tool_call_id，用于将 tool result 关联回模型请求） */
  id?: string;
}

export interface ExecutionLoopDeps {
  /** 模型调用（统一经 ModelRuntime → RetryPolicy） */
  model: ModelRuntime;
  /** 构造 ModelRequest（调用方注入当前上下文/消息/Prompt） */
  buildRequest: (messages: Array<Record<string, unknown>>, turn: number) => ModelRequest;
  /** 执行工具并返回结果文本（ToolRuntime 适配） */
  executeTool: (tool: ExecutionTool, turn: number) => Promise<string>;
  /** 是否有工具定义（无工具时模型无法发起 tool_calls） */
  hasTools: boolean;
  /** 事件回调（可选，供 Activity/SSE） */
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
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

export interface RunExecutionLoopOptions {
  budget?: ExecutionBudget;
  loop?: boolean;              // true = 自主 Loop，false = Normal（完成必要工具链后结束）
  signal?: AbortSignal;
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
export async function runExecutionLoop(
  deps: ExecutionLoopDeps,
  initialMessages: Array<Record<string, unknown>>,
  opts: RunExecutionLoopOptions = {},
): Promise<ExecutionLoopResult> {
  const budget = opts.budget ?? (opts.loop ? loopExecutionBudget() : normalExecutionBudget());
  const startedAt = Date.now();
  const usage = createExecutionUsage();
  let messages = [...initialMessages];
  let turnsUsed = 0;
  let toolCallCount = 0;
  let state: CompletionState = 'idle';
  let budgetExceeded: BudgetExceededReason = 'none';
  let content = '';
  let reasoningContent = '';
  let interrupted = false;

  const emit = (type: string, payload: Record<string, unknown>): void => {
    try { deps.onEvent?.(type, payload); } catch { /* ignore */ }
  };

  const checkBudget = (): BudgetExceededReason => {
    const elapsedMs = Date.now() - startedAt;
    if (budget.maxTurns > 0 && turnsUsed >= budget.maxTurns) return 'turns';
    if (budget.maxToolCalls > 0 && toolCallCount >= budget.maxToolCalls) return 'tool_calls';
    if (budget.maxTimeMs > 0 && elapsedMs >= budget.maxTimeMs) return 'duration';
    if (budget.maxTokens > 0 && usage.cumulativeTotalTokens >= budget.maxTokens) return 'tokens';
    if (budget.maxCostCny > 0) return 'cost';
    return 'none';
  };

  emit('execution.started', { loop: !!opts.loop, budget });
  state = 'running';

  try {
    while (true) {
      // 预算检查（P0-05：每次 Model 调用前 / 新 Turn 开始时）
      const exceeded = checkBudget();
      if (exceeded !== 'none') {
        budgetExceeded = exceeded;
        state = 'budget_exceeded';
        emit('execution.budget_exceeded', { reason: exceeded, turnsUsed, toolCallCount, elapsedMs: Date.now() - startedAt });
        break;
      }

      // 取消检查
      if (opts.signal?.aborted) {
        state = 'cancelled';
        budgetExceeded = 'cancelled';
        emit('execution.cancelled', { turnsUsed, toolCallCount });
        break;
      }

      // 调用 Model（统一经 ModelRuntime → RetryPolicy；业务层不再手写 retry）
      turnsUsed++;
      emit('execution.turn_started', { turn: turnsUsed });
      const request = deps.buildRequest(messages, turnsUsed);
      let response: ModelResponse;
      try {
        // §3.1 流式路径：deps.onChunk 提供时优先 stream()，实时转发 chunk 且内部聚合出
        // 完整 ModelResponse（统一完成判断）。未提供 onChunk 时回退 complete()（保持兼容）。
        response = deps.onChunk
          ? await completeFromStream(deps.model, request, deps.onChunk)
          : await deps.model.complete(request);
      } catch (e: unknown) {
        // AbortError → cancelled；其余 → failed
        if (opts.signal?.aborted) {
          state = 'cancelled';
          budgetExceeded = 'cancelled';
          break;
        }
        state = 'failed';
        emit('execution.failed', { turn: turnsUsed, error: e instanceof Error ? e.message : String(e) });
        break;
      }

      // 用量累计
      accumulateUsage(usage, response.usage);

      // §17：流中断（interrupted）→ failed/interrupted 语义
      if ((response as ModelResponse & { interrupted?: boolean }).interrupted) {
        interrupted = true;
        state = 'failed';
        content = response.content;
        reasoningContent = response.reasoningContent ?? '';
        emit('execution.interrupted', { turn: turnsUsed, partialContent: content });
        break;
      }

      // §3.2 时长预算复核：模型调用可能跨越长时间，完成后复核执行时长
      // （P0-05：每次 Model 调用前/后都检查预算；超时必须在任何完成判定之前拦截）
      const postModelExceeded = checkBudget();
      if (postModelExceeded !== 'none') {
        budgetExceeded = postModelExceeded;
        state = 'budget_exceeded';
        emit('execution.budget_exceeded', { reason: postModelExceeded, turnsUsed, toolCallCount, elapsedMs: Date.now() - startedAt });
        break;
      }

      // 组装消息（保留模型回复到历史）
      if (response.reasoningContent) {
        reasoningContent += response.reasoningContent;
        messages.push({ role: 'assistant', content: response.content, reasoning_content: response.reasoningContent });
      } else {
        messages.push({ role: 'assistant', content: response.content });
      }

      // 处理工具调用
      if (response.toolCalls && response.toolCalls.length > 0 && deps.hasTools) {
        state = 'waiting_tool';
        emit('execution.tool_calls', { turn: turnsUsed, count: response.toolCalls.length });
        for (const tc of response.toolCalls) {
          // 预算检查（每次 Tool 调用前，P0-05）
          const toolExceeded = checkBudget();
          if (toolExceeded !== 'none') {
            budgetExceeded = toolExceeded;
            state = 'budget_exceeded';
            break;
          }
          if (opts.signal?.aborted) {
            state = 'cancelled';
            budgetExceeded = 'cancelled';
            break;
          }
          toolCallCount++;
          emit('execution.tool_started', { turn: turnsUsed, tool: tc.name });
          let result: string;
          try {
            result = await deps.executeTool({ name: tc.name, arguments: tc.arguments }, turnsUsed);
          } catch (e: unknown) {
            // 工具失败：不静默重试（Tool Retry 与 Model Retry 分开，§19）
            // 返回错误给 Agent，由 Agent 判断是否换参数重试（Loop 语义）
            result = `[tool_error] ${e instanceof Error ? e.message : String(e)}`;
          }
          emit('execution.tool_completed', { turn: turnsUsed, tool: tc.name, status: 'completed' });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          content += result.slice(0, 500); // 部分内容供 finalization 参考
        }
        // 工具执行后 → Loop 模式继续；Normal 模式也允许必要工具链后再次调用 Model
        state = 'continuing';
        continue;
      }

      // 无工具调用 → 最终文本回答。
      // §3.2 Loop 真实语义：Loop 模式进入 verifying —— 用 isTaskComplete 判断"任务是否真的完成"，
      // 而非"有文本就算完成"；未完成 → continuing 继续下一轮（预算内），直到完成/停止/预算耗尽。
      if (opts.loop) {
        state = 'verifying';
        emit('execution.verifying', { turn: turnsUsed, contentLength: response.content.length });
        const taskComplete = deps.isTaskComplete
          ? deps.isTaskComplete(response, messages)
          : response.content.trim() !== ''; // 缺省：有文本即完成（兼容 Normal 语义）
        if (taskComplete) {
          content = response.content;
          state = 'completed';
          emit('execution.completed', { turn: turnsUsed, contentLength: content.length });
          break;
        }
        // 任务未完成 → 继续（模型/上层可注入更多指令或工具结果到 messages）
        state = 'continuing';
        emit('execution.continuing', { turn: turnsUsed, reason: 'task_incomplete' });
        continue;
      }

      // Normal（loop=false）：完成必要工具链后得到最终答案 → 立即结束（不无意义继续）
      content = response.content;
      state = 'completed';
      emit('execution.completed', { turn: turnsUsed, contentLength: content.length });
      break;
    }

    // P0-06：预算耗尽 finalization —— 不伪造成功。
    // 预算耗尽意味着任务未正常完成：无论是否已有工具结果累积，
    // 都必须给出结构化总结（已完成什么 / 尚未完成 / 为什么停止），
    // 禁止把工具结果碎片直接当作最终回答。
    if (state === 'budget_exceeded') {
      const why = finalizeOnBudgetExceeded(budgetExceeded, turnsUsed, toolCallCount);
      content = content.trim() !== ''
        ? `${content}\n\n---\n${why}`
        : why;
      emit('execution.finalized', { reason: budgetExceeded, content });
    }
  } finally {
    emit('execution.ended', { state, turnsUsed, toolCallCount, elapsedMs: Date.now() - startedAt });
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
    ...(interrupted ? { interrupted: true as const } : {}),
  };
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
