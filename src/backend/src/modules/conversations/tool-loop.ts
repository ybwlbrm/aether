import { buildToolPayload } from '@pacc/shared';
import { parseToolArgsSafe, buildChatRequestBody } from '../../lib/stream-translate.js';
import { drainDirectives } from '../../lib/inbox.js';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';
// P0-01 收口：统一生产工具执行器（Agent → ToolRuntime → PolicyEngine → Approval → ToolExecutor）
import { createProductionToolExecutor, type ProductionToolExecutor } from '../../lib/production-tool-executor.js';
// §30/§31 收口：预算统一来源 —— AgentDefinition limits → budgetFromAgentLimits（禁止 30/50/128000 散落硬编码）
import { budgetFromAgentLimits, type AgentLimitsLike } from '../../core/runtime/execution-loop.js';
// 统一 ExecutionLoop：唯一生产循环控制器（第四部分：ToolLoop 收口为薄 wrapper，无第二套循环）
import { runExecutionLoop, type ExecutionLoopDeps, type ExecutionBudget, type AssistantToolCallMessage } from '../../core/runtime/execution-loop.js';
import { persistAssistantToolCallMessage, persistToolResultMessage } from '../../lib/message-history.js';
import type { EventBus } from '../../lib/event-bus/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../../db/schema/index.js';
import type { StreamChunk } from '@pacc/shared';

type Db = SQLJsDatabase<typeof schema>

export interface ToolLoopConfig {
  apiMessages: Array<Record<string, unknown>>;
  baseUrl: string;
  apiKey: string;
  activeModel: string;
  activeTools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  maxTurns: number;
  clientAbortSignal: AbortSignal;
  sseSend: (event: string, data: string) => void;
  eventBus: EventBus;
  runContext: {
    sessionId: string
    taskId: string
    agentId: string
    agentType: string
  };
  conversationId: string;
  mcpTools: Array<{ name: string; description?: string; inputSchema?: unknown; serverName?: string }>;
  getMcpServers: () => Array<{
    id: string
    name: string
    type: 'local' | 'remote'
    command: string | null
    cwd: string | null
    environment: string | null
    url: string | null
    enabled: boolean
    timeout: number
    headers: string | null
  }>;
  allowedDirs: string[];
  permissionLevel: number;
  defaultDir: string;
  settings: { permissionLevel?: number };
  deepThinking: boolean | undefined;
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  supportsThinking: boolean;
  db: Db;
  body: { readonly loop?: boolean };
  /** 整改计划第 5 章（P1）：循环预算（缺省用 defaultLoopBudget(maxTurns)） */
  budget?: LoopBudget;
}

export interface ToolLoopResult {
  aiContent: string;
  streamedContent: string;
  reasoningContent: string;
  usageTotal: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  lastToolResult: string;
  endedNormally: boolean;
  endReason: 'completed' | 'interrupted' | 'error' | 'cancelled';
  aiError: string | null;
  toolCallCount: number;
  /** 整改计划第 5 章（P1）：预算耗尽原因（'turns' | 'duration' | 'tokens' | 'tool_calls' | 'cost' | null） */
  budgetExceeded: 'turns' | 'duration' | 'tokens' | 'tool_calls' | 'cost' | null;
  /** 已用轮数（前端循环 UI 显示） */
  turnsUsed: number;
  /** 已用时长 ms（前端循环 UI 显示） */
  elapsedMs: number;
}

/** 整改计划第 5 章（P1）：循环预算对象 —— 超过任一预算即停止并写 budget_exceeded */
export interface LoopBudget {
  /** 最大轮数（默认 30；循环模式同值，防失控） */
  maxTurns: number;
  /** 最大总时长 ms（0=不限） */
  maxDurationMs: number;
  /** 最大总 token（0=不限） */
  maxTokens: number;
  /** 最大工具调用数（0=不限；内部仍有硬上限 50） */
  maxToolCalls: number;
  /** 最大估算费用元（0=不限） */
  maxCostCny: number;
}

/** 构造默认预算（可在 chat-handler 中覆盖）—— 统一来源 budgetFromAgentLimits（§30/§31） */
export function defaultLoopBudget(maxTurns: number, agentLimits?: AgentLimitsLike): LoopBudget {
  // 统一预算：AgentDefinition limits 优先，缺省走 execution-loop 的 Normal/Loop 基线预算
  const unified = budgetFromAgentLimits(agentLimits, maxTurns > 8);
  return {
    maxTurns: maxTurns > 0 ? maxTurns : unified.maxTurns,
    maxDurationMs: unified.maxTimeMs,     // 默认按统一预算（loop 30min / normal 5min）
    maxTokens: unified.maxTokens,         // 默认按统一预算（loop 128k / normal 64k）
    maxToolCalls: unified.maxToolCalls,   // 统一预算（loop 100 / normal 30）
    maxCostCny: unified.maxCostCny,       // 默认不限费用
  };
}

/** LoopBudget → ExecutionBudget（统一预算对象，供 runExecutionLoop 消费） */
function toExecutionBudget(budget: LoopBudget): ExecutionBudget {
  return {
    maxTurns: budget.maxTurns,
    maxToolCalls: budget.maxToolCalls,
    maxTimeMs: budget.maxDurationMs,
    maxTokens: budget.maxTokens,
    maxCostCny: budget.maxCostCny,
  };
}

/**
 * 执行工具调用循环（Function Calling Loop）。
 *
 * 第四部分收口：本函数已改造为**薄 wrapper** —— 不再自建 while 循环，
 * 统一委托 core/runtime/execution-loop.ts::runExecutionLoop 作为唯一生产循环控制器。
 * SSE 实时输出 / 事件总线 / DB 写入等副作用经 ExecutionLoopDeps 回调转发，语义保持不变。
 *
 * PF-02: 工具调用总预算由统一 budget（budgetFromAgentLimits 派生）控制，防止失控成本
 * BE-05: 传递 abort signal 到工具执行，支持客户端断连时取消
 */
export async function executeToolLoop(
  config: ToolLoopConfig
): Promise<ToolLoopResult> {
  const {
    apiMessages,
    baseUrl,
    apiKey,
    activeModel,
    activeTools,
    maxTurns: configMaxTurns,
    clientAbortSignal,
    sseSend,
    eventBus,
    runContext,
    conversationId,
    mcpTools,
    getMcpServers,
    allowedDirs,
    permissionLevel,
    defaultDir,
    settings,
    deepThinking,
    reasoningEffort,
    supportsThinking,
    db,
    body,
    budget: budgetOverride,
  } = config;

  // 整改计划第 5 章（P1）：循环预算 —— 超过轮数/时长/token/工具调用/费用任一预算即停止
  const budget = budgetOverride ?? defaultLoopBudget(configMaxTurns);
  const loopStartedAt = Date.now();
  let lastToolResult = '';

  // P0-01 收口：统一生产工具执行器（循环外构建一次，循环内复用）
  const productionExecutor: ProductionToolExecutor = createProductionToolExecutor({
    mcpTools,
    getMcpServers,
    allowedDirs,
    permissionLevel: settings.permissionLevel ?? 2,
    defaultDir,
    sessionId: conversationId,
    runId: runContext.taskId,
    taskId: runContext.taskId,
    agentId: runContext.agentId,
    signal: clientAbortSignal,
    onApprovalPrompt: ({ id, toolName, argsSummary }) => {
      sseSend('ask-confirm', JSON.stringify({ id, toolName, argsSummary }));
      eventBus.emit(runContext.sessionId, 'task.ask-confirm', {
        taskId: runContext.taskId,
        agentId: runContext.agentId,
        agentType: runContext.agentType,
        content: `需要确认执行工具 ${toolName}`,
        metadata: { approvalId: id, toolName, argsSummary, runId: runContext.taskId, agentId: runContext.agentId },
      });
    },
  });

  // 构建 ModelRuntime（统一经 ModelRuntime → ProviderAdapter → RetryPolicy）
  const providerConfig = {
    id: 'conversation',
    name: 'conversation',
    type: 'openai',
    apiKey,
    baseUrl,
    defaultModel: activeModel,
    models: [activeModel],
    capabilities: ['text', 'tool_calling'],
  };
  const runtime = buildModelRuntime(providerConfig);

  // ExecutionLoopDeps：唯一循环控制器的依赖注入（第四部分收口）
  const deps: ExecutionLoopDeps = {
    onAssistantToolCalls: (message: AssistantToolCallMessage) => {
      persistAssistantToolCallMessage(db, conversationId, message)
    },
    model: runtime,
    hasTools: activeTools.length > 0,
    buildRequest: (msgs, _turn): ModelRequest => ({
      provider: providerConfig.id,
      model: activeModel,
      messages: msgs,
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
    }),
    executeTool: async (tool, _turn): Promise<string> => {
      // 工具执行副作用：SSE tool-call/tool-result、eventBus tool.started/completed、DB 写入
      const funcName = tool.name;
      const parsed = parseToolArgsSafe(tool.arguments);
      const args = parsed.args;
      if (!parsed.ok) {
        const errMsg = `工具参数不是合法 JSON: ${String(tool.arguments || '').slice(0, 500)}`;
        sseSend('tool-call', JSON.stringify({ name: funcName, arguments: {}, id: tool.id }));
        sseSend('tool-result', JSON.stringify({ name: funcName, result: errMsg, id: tool.id, arguments: {}, error: true }));
        eventBus.emit(runContext.sessionId, 'tool.completed', {
          taskId: runContext.taskId,
          agentId: runContext.agentId,
          agentType: runContext.agentType,
          status: 'error',
          content: errMsg,
          tool: { ...buildToolPayload(funcName, {}), error: { message: errMsg }, toolOutput: undefined },
          parentEventId: undefined,
        });
        lastToolResult = errMsg;
        persistToolResultMessage(db, conversationId, tool.id, funcName, String(tool.arguments || ''), errMsg)
        return errMsg;
      }
      sseSend('tool-call', JSON.stringify({ name: funcName, arguments: args, id: tool.id }));
      // 统一协议事件：tool.started（紧凑载荷 + 完整详情可展开）
      const toolStarted = eventBus.emit(runContext.sessionId, 'tool.started', {
        taskId: runContext.taskId,
        agentId: runContext.agentId,
        agentType: runContext.agentType,
        status: 'started',
        tool: buildToolPayload(funcName, args),
      });

      let result: string;
      try {
        // P0-01 收口：统一生产执行器（PolicyEngine 唯一裁决 + Approval + Timeout + Cancel）
        // 审批在 executor 内部完整处理（onApprovalPrompt 回调推送 ask-confirm）
        const execResult = await productionExecutor.execute(funcName, args);
        result = execResult.result;
        if (execResult.error) throw new Error(execResult.error);
      } catch (e: unknown) {
        // 工具执行异常 → tool.error（不再吞掉错误；旧协议仍发 tool-result 带错误文本）
        const errMsg = (e instanceof Error ? e.message : String(e)) || '工具执行失败';
        sseSend('tool-result', JSON.stringify({ name: funcName, result: `错误: ${errMsg}`, id: tool.id, arguments: args, error: true }));
        eventBus.emit(runContext.sessionId, 'tool.error', {
          taskId: runContext.taskId,
          agentId: runContext.agentId,
          agentType: runContext.agentType,
          status: 'error',
          content: errMsg,
          tool: { ...buildToolPayload(funcName, args), error: { message: errMsg }, toolOutput: undefined },
          parentEventId: toolStarted.eventId,
        });
        lastToolResult = `错误: ${errMsg}`;
        persistToolResultMessage(db, conversationId, tool.id, funcName, tool.arguments, `错误: ${errMsg}`)
        return `错误: ${errMsg}`;
      }

      // 旧协议：截断 3000（兼容旧前端）；统一协议：完整结果进入 envelope（前端控制展示）
      sseSend('tool-result', JSON.stringify({ name: funcName, result: result.slice(0, 3000), id: tool.id, arguments: args }));
      eventBus.emit(runContext.sessionId, 'tool.completed', {
        taskId: runContext.taskId,
        agentId: runContext.agentId,
        agentType: runContext.agentType,
        status: 'completed',
        tool: buildToolPayload(funcName, args, result),
        parentEventId: toolStarted.eventId,
      });
      // 记录最近一次工具结果（用于下方重复检测）
      lastToolResult = result;
      // 保存工具执行结果到 DB
      persistToolResultMessage(db, conversationId, tool.id, funcName, tool.arguments, result)
      // L5: 统一截断策略 — API 上下文截断 50000 字符（足够容纳普通文件全文）
      return result.slice(0, 50000);
    },
    // 流式 chunk 转发：SSE 实时输出 + 事件总线（进入统一 Loop 不丢失实时输出）
    onChunk: (chunk: StreamChunk) => {
      switch (chunk.type) {
        case 'reasoning-delta': {
          sseSend('reasoning', JSON.stringify({ content: chunk.text }));
          eventBus.emit(runContext.sessionId, 'agent.reasoning.delta', {
            taskId: runContext.taskId,
            agentId: runContext.agentId,
            agentType: runContext.agentType,
            content: chunk.text,
          });
          break;
        }
        case 'text-delta': {
          sseSend('message', JSON.stringify({ content: chunk.text }));
          eventBus.emit(runContext.sessionId, 'agent.message.delta', {
            taskId: runContext.taskId,
            agentId: runContext.agentId,
            agentType: runContext.agentType,
            content: chunk.text,
          });
          break;
        }
        default: break;
      }
    },
    // 完成判定：缺省有文本即完成（与 Normal 一致）；上层可通过 isTaskComplete 覆盖 Loop 语义
    isTaskComplete: (resp) => resp.content.trim() !== '',
  };

  // inbox 指令（steer/followup）：运行中用户补充的指令 → 注入为初始消息尾部（Loop 启动前读取一次）
  const directives = drainDirectives(conversationId);
  for (const d of directives) {
    apiMessages.push({ role: 'user', content: `[补充指令] ${d.text}` });
  }

  // 唯一生产循环控制器（第四部分：ToolLoop 收口）
  const result = await runExecutionLoop(deps, apiMessages, {
    loop: !!body.loop,
    budget: toExecutionBudget(budget),
    signal: clientAbortSignal,
  });

  // 轮数自然耗尽且未正常结束 → 视为轮数预算耗尽（与 execution-loop budget_exceeded 语义对齐）
  let budgetExceeded: ToolLoopResult['budgetExceeded'] = null;
  if (result.budgetExceeded !== 'none' && result.budgetExceeded !== 'cancelled') {
    budgetExceeded = result.budgetExceeded;
  }
  const interrupted = result.state === 'interrupted'
    || (result.interrupted === true && result.finishReason !== 'error')
  const failed = result.state === 'failed' || result.finishReason === 'error'
  const failureMessage = interrupted
    ? (result.content || '回答被截断')
    : failed
      ? (result.content || 'AI 执行失败')
      : null
  const endReason = result.state === 'cancelled'
    ? 'cancelled'
    : interrupted
      ? 'interrupted'
      : failed
        ? 'error'
        : 'completed'

  return {
    aiContent: result.content,
    streamedContent: result.content,
    reasoningContent: result.reasoningContent ?? '',
    usageTotal: {
      prompt_tokens: result.usage.cumulativeInputTokens,
      completion_tokens: result.usage.cumulativeOutputTokens,
      total_tokens: result.usage.cumulativeTotalTokens,
    },
    lastToolResult,
    endedNormally: result.state === 'completed' && !interrupted && !failed,
    endReason,
    aiError: failureMessage,
    toolCallCount: result.toolCallCount,
    budgetExceeded,
    turnsUsed: result.turnsUsed,
    elapsedMs: Date.now() - loopStartedAt,
  };
}
