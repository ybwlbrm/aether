import { compactRemovedHistory, buildCompactionSystemMessage } from '../../lib/compaction.js';
import { buildChatRequestBody } from '../../lib/stream-translate.js';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';
import type { BudgetExceededReason } from '../../core/runtime/execution-loop.js';

export interface CompactionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  removedHistory: Array<{ role: string; content: string }>;
  recentContext: string;
  signal: AbortSignal;
  sseSend?: (event: string, data: string) => void;
  deepThinking?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  supportsThinking?: boolean;
  activeTools?: any[];
}

/**
 * 处理历史溢出压缩：被移除的最早历史交给 LLM 生成摘要注入
 * 失败时静默回退到直接丢弃，不阻塞主流程
 */
export async function processCompaction(
  config: CompactionConfig
): Promise<{ role: 'system'; content: string } | null> {
  if (config.removedHistory.length === 0 || !config.apiKey) {
    return null;
  }

  try {
    const summary = await compactRemovedHistory({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      removedHistory: config.removedHistory,
      recentContext: config.recentContext,
      signal: config.signal,
    });

    if (summary) {
      return buildCompactionSystemMessage(summary);
    }
  } catch {
    // compaction 失败静默回退：不影响主流程
  }
  return null;
}

/** 预算耗尽的具体类型（剔除 execution-loop 的 'none' / 'cancelled' 哨兵值） */
export type BudgetExceededKind = Exclude<BudgetExceededReason, 'none' | 'cancelled'>;

/** 工具循环结束后的补文本策略（唯一事实源，见 resolveTextFallback） */
export type TextFallbackPolicy =
  /** 允许发起一次强制总结模型调用（仅限正常执行但无文本） */
  | 'force-summary'
  /** 允许填预算耗尽说明（不得伪造成功） */
  | 'budget-notice'
  /** 不得补任何文本（已有文本 / 已完成 / 已取消 / 已有真实错误） */
  | 'none';

export interface TextFallbackInput {
  /** 执行循环是否正常收尾 */
  readonly endedNormally: boolean;
  /** 执行循环终态原因 */
  readonly executionEndReason: 'completed' | 'interrupted' | 'error' | 'cancelled';
  /** 预算耗尽类型（非空即已耗尽） */
  readonly budgetExceeded: BudgetExceededKind | null;
  /** 已有回复文本 */
  readonly aiContent: string;
  /** 真实错误信息 */
  readonly aiError: string | null;
}

/**
 * 决定工具循环结束后「补不补文本 / 补什么」的唯一入口。
 *
 * AEX-P0-003：预算耗尽（budgetExceeded）是一种**用户已主动终止**的终态，
 * 此时发起 executeForceSummary 属于规范未授权的隐藏模型调用（用户以为停了，
 * 系统却继续烧 token），且任何「处理完成」文案都是伪造成功。因此：
 * - budgetExceeded → 'budget-notice'（只允许说清为什么停），永不 force-summary
 * - aiError / cancelled / 已有文本 → 'none'（真实错误与真实文本优先，不覆盖）
 * - 正常执行但无文本无错误 → 'force-summary'（补一次真实总结）
 */
export function resolveTextFallback(input: TextFallbackInput): TextFallbackPolicy {
  if (input.aiError !== null) return 'none';
  if (input.executionEndReason === 'cancelled') return 'none';
  if (input.aiContent !== '') return 'none';
  if (input.budgetExceeded !== null) return 'budget-notice';
  if (input.endedNormally) return 'none';
  return 'force-summary';
}

/**
 * 执行强制总结 —— **仅限正常执行但模型没给文本的兜底**。
 *
 * 调用点必须先过 resolveTextFallback() === 'force-summary'：
 * 预算耗尽 / 已取消 / 已有错误 / 已有文本 一律不得进入本函数（那会是隐藏模型调用）。
 */
export async function executeForceSummary(
  apiMessages: any[],
  activeModel: string,
  baseUrl: string,
  apiKey: string,
  activeTools: any[],
  deepThinking: boolean | undefined,
  reasoningEffort: 'low' | 'medium' | 'high' | undefined,
  supportsThinking: boolean,
  clientAbortSignal: AbortSignal,
  sseSend: (event: string, data: string) => void,
  eventBus: any,
  runContext: any
): Promise<string | null> {
  try {
    const providerConfig = {
      id: 'compaction',
      name: 'compaction',
      type: 'openai',
      apiKey,
      baseUrl,
      defaultModel: activeModel,
      models: [activeModel],
      capabilities: ['text', 'tool_calling'],
    };
    const runtime = buildModelRuntime(providerConfig);

    const request: ModelRequest = {
      provider: providerConfig.id,
      model: activeModel,
      messages: [
        ...apiMessages,
        { role: 'user', content: '请基于上面所有工具执行的结果，给出完整的总结与最终答复。如果任务还没完成，请继续说明还需要做什么。' }
      ],
      tools: activeTools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      })),
      maxTokens: 4096,
      signal: clientAbortSignal,
    };

    let summaryText = '';
    for await (const c of runtime.stream(request)) {
      if (c.type === 'text-delta') {
        summaryText += c.text;
        // 流式推送给前端
        sseSend('message', JSON.stringify({ content: c.text }));
        eventBus.emit(runContext.sessionId, 'agent.message.delta', {
          taskId: runContext.taskId,
          agentId: runContext.agentId,
          agentType: runContext.agentType,
          content: c.text,
        });
      }
    }

    if (summaryText.trim()) {
      return summaryText.trim();
    }
  } catch {
    // 强制总结失败则回退占位符
  }
  return null;
}