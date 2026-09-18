import { randomUUID } from 'node:crypto';
import { buildToolPayload } from '@pacc/shared';
import { parseToolArgsSafe, buildChatRequestBody } from '../../lib/stream-translate.js';
import { drainDirectives } from '../../lib/inbox.js';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';
import { messages } from '../../db/schema/index.js';
// P0-01 收口：统一生产工具执行器（Agent → ToolRuntime → PolicyEngine → Approval → ToolExecutor）
import { createProductionToolExecutor, type ProductionToolExecutor } from '../../lib/production-tool-executor.js';

export interface ToolLoopConfig {
  apiMessages: any[];
  baseUrl: string;
  apiKey: string;
  activeModel: string;
  activeTools: any[];
  maxTurns: number;
  clientAbortSignal: AbortSignal;
  sseSend: (event: string, data: string) => void;
  eventBus: any;
  runContext: any;
  conversationId: string;
  mcpTools: any[];
  getMcpServers: () => any[];
  allowedDirs: string[];
  permissionLevel: number;
  defaultDir: string;
  settings: any;
  deepThinking: boolean | undefined;
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  supportsThinking: boolean;
  db: any;
  body: any;
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

/** 构造默认预算（可在 chat-handler 中覆盖） */
export function defaultLoopBudget(maxTurns: number): LoopBudget {
  return {
    maxTurns,
    maxDurationMs: 0,     // 默认不限时长
    maxTokens: 0,         // 默认不限 token
    maxToolCalls: 50,     // 与 MAX_TOOL_CALLS_PER_REQUEST 对齐
    maxCostCny: 0,        // 默认不限费用
  };
}

/**
 * 执行工具调用循环（Function Calling Loop）
 * PF-02: 硬性工具调用总预算 MAX_TOOL_CALLS_PER_REQUEST = 50，防止失控成本
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
  let turnsUsed = 0;

  // PF-02: 硬性工具调用总预算，防止失控成本
  const MAX_TOOL_CALLS_PER_REQUEST = 50;
  let toolCallCount = 0;

  let aiContent = '';
  let streamedContent = '';
  let reasoningContent = '';
  let usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let lastToolResult = '';
  let endedNormally = false;
  let aiError: string | null = null;
  // 整改计划第 5 章（P1）：预算耗尽原因（null=未耗尽）
  let budgetExceeded: ToolLoopResult['budgetExceeded'] = null;

  let maxTurns = configMaxTurns;

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

  while (maxTurns-- > 0) {
    turnsUsed++;
    // 整改计划第 5 章（P1）：轮数预算 —— 超过即停止（不再请求模型）
    if (budget.maxTurns > 0 && turnsUsed > budget.maxTurns) {
      budgetExceeded = 'turns';
      aiContent = `⚠️ 已达到轮数上限（${budget.maxTurns} 轮），本次请求停止执行。`;
      endedNormally = false;
      break;
    }
    // 时长预算
    if (budget.maxDurationMs > 0 && Date.now() - loopStartedAt > budget.maxDurationMs) {
      budgetExceeded = 'duration';
      aiContent = `⚠️ 已达到时长预算（${(budget.maxDurationMs / 1000).toFixed(0)} 秒），本次请求停止执行。`;
      endedNormally = false;
      break;
    }
    // token 预算（每轮模型调用前检查累计 usage）
    if (budget.maxTokens > 0 && usageTotal.total_tokens > budget.maxTokens) {
      budgetExceeded = 'tokens';
      aiContent = `⚠️ 已达到 token 预算（${budget.maxTokens.toLocaleString()}），本次请求停止执行。`;
      endedNormally = false;
      break;
    }

    // inbox 指令（steer/followup）：运行中用户补充的指令 → drain 为 user 消息注入下一轮
    const directives = drainDirectives(conversationId);
    for (const d of directives) {
      apiMessages.push({ role: 'user', content: `[补充指令] ${d.text}` });
    }

    // Build ModelRuntime from config
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

    const request: ModelRequest = {
      provider: providerConfig.id,
      model: activeModel,
      messages: apiMessages,
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

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let currentToolCalls: any[] = [];
    let hasReasoning = false;
    let turnFinish: 'stop' | 'tool_calls' | 'max-tokens' | 'error' = 'stop';

    try {
      for await (const c of runtime.stream(request)) {
        switch (c.type) {
          case 'reasoning-delta': {
            hasReasoning = true;
            reasoningContent += c.text;
            accumulatedReasoning += c.text;
            sseSend('reasoning', JSON.stringify({ content: c.text }));
            eventBus.emit(runContext.sessionId, 'agent.reasoning.delta', {
              taskId: runContext.taskId,
              agentId: runContext.agentId,
              agentType: runContext.agentType,
              content: c.text,
            });
            break;
          }
          case 'text-delta': {
            accumulatedContent += c.text;
            sseSend('message', JSON.stringify({ content: c.text }));
            eventBus.emit(runContext.sessionId, 'agent.message.delta', {
              taskId: runContext.taskId,
              agentId: runContext.agentId,
              agentType: runContext.agentType,
              content: c.text,
            });
            break;
          }
          case 'block-end': {
            if (c.block.kind === 'tool-call') {
              currentToolCalls.push({ id: c.block.id, function: { name: c.block.name, arguments: c.block.arguments }, index: currentToolCalls.length });
            }
            break;
          }
          case 'usage': {
            // A3 修正：不累加 prompt（会随 fc 循环重复计入同一上下文导致虚高），
            // completion 每轮都是新生成，累加；prompt 取最后一次轮的最终上下文大小
            usageTotal.completion_tokens += c.usage.outputTokens;
            usageTotal.prompt_tokens = c.usage.inputTokens;
            usageTotal.total_tokens = usageTotal.completion_tokens + usageTotal.prompt_tokens;
            break;
          }
          case 'finish': {
            if (c.reason.kind === 'error') {
              throw new Error(c.reason.message || 'AI 流式响应错误');
            }
            turnFinish = c.reason.kind;
            break;
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'StreamError') {
        sseSend('error', JSON.stringify({ message: `AI 响应流中断: ${e.message}` }));
      }
      throw e;
    }

    // 发送推理结束标记（如果收到了推理内容）
    if (hasReasoning) {
      sseSend('reasoning-end', JSON.stringify({}));
    }

    // 处理工具调用或最终回复
    if (currentToolCalls.length > 0) {
      // 有工具调用 — 对齐 harness：纯工具轮 content 发空串（非 null），reasoning_content 必须回传防会话"砖化"
      const assistantMsg: any = {
        role: 'assistant',
        content: accumulatedContent || '',
        tool_calls: currentToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments }
        })),
        ...(accumulatedReasoning ? { reasoning_content: accumulatedReasoning } : {}),
      };
      apiMessages.push(assistantMsg);

      // 执行每个工具
      for (const tc of currentToolCalls) {
        // PF-02: 工具调用预算检查 — 超过上限则优雅终止
        toolCallCount++;
        // 整改计划第 5 章（P1）：工具调用预算 —— 统一使用 budget.maxToolCalls（默认 50）
        const toolBudgetLimit = budget.maxToolCalls > 0 ? budget.maxToolCalls : MAX_TOOL_CALLS_PER_REQUEST;
        if (toolCallCount > toolBudgetLimit) {
          budgetExceeded = 'tool_calls';
          const budgetMsg = `⚠️ 已达到工具调用上限 (${toolBudgetLimit} 次)，本次请求停止执行。如需继续，请发送新消息。`;
          sseSend('message', JSON.stringify({ content: budgetMsg }));
          eventBus.emit(runContext.sessionId, 'agent.message.delta', {
            taskId: runContext.taskId,
            agentId: runContext.agentId,
            agentType: runContext.agentType,
            content: budgetMsg,
          });
          aiContent = budgetMsg;
          endedNormally = false; // 标记为非正常结束（预算耗尽）
          break;
        }

        const funcName = tc.function?.name || '';
        // parseToolArgsSafe：非法 JSON 降级为 {ok:false}，工具不炸流
        const parsed = parseToolArgsSafe(tc.function?.arguments);
        let args: any = parsed.args;
        if (!parsed.ok) {
          const errMsg = `工具参数不是合法 JSON: ${String(tc.function?.arguments || '').slice(0, 500)}`;
          sseSend('tool-call', JSON.stringify({ name: funcName, arguments: {}, id: tc.id }));
          sseSend('tool-result', JSON.stringify({ name: funcName, result: errMsg, id: tc.id, arguments: {}, error: true }));
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
          const toolMsgId = randomUUID();
          db.insert(messages).values({
            id: toolMsgId, conversationId: conversationId, role: 'tool', content: errMsg,
            toolCalls: JSON.stringify({ id: tc.id, function: { name: funcName, arguments: String(tc.function?.arguments || '') } }), createdAt: new Date().toISOString(),
          }).run();
          apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          continue;
        }
        sseSend('tool-call', JSON.stringify({ name: funcName, arguments: args, id: tc.id }));
        // 统一协议事件：tool.started（紧凑载荷 + 完整详情可展开）
        const toolStarted = eventBus.emit(runContext.sessionId, 'tool.started', {
          taskId: runContext.taskId,
          agentId: runContext.agentId,
          agentType: runContext.agentType,
          status: 'started',
          tool: buildToolPayload(funcName, args),
        });

        // 判断是文件工具还是 MCP 工具（MCP 工具名格式: {serverName}_{toolName}）
        const mcpTool = mcpTools.find(t => t.name === funcName);
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
          sseSend('tool-result', JSON.stringify({ name: funcName, result: `错误: ${errMsg}`, id: tc.id, arguments: args, error: true }));
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
          // 保存错误结果（保持 DB 消息链路完整）
          const toolMsgId = randomUUID();
          db.insert(messages).values({
            id: toolMsgId, conversationId: conversationId, role: 'tool', content: `错误: ${errMsg}`,
            toolCalls: JSON.stringify(tc), createdAt: new Date().toISOString(),
          }).run();
          apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `错误: ${errMsg}` });
          continue;
        }

        // 旧协议：截断 3000（兼容旧前端）；统一协议：完整结果进入 envelope（前端控制展示）
        sseSend('tool-result', JSON.stringify({ name: funcName, result: result.slice(0, 3000), id: tc.id, arguments: args }));
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
        const toolMsgId = randomUUID();
        db.insert(messages).values({
          id: toolMsgId, conversationId: conversationId, role: 'tool', content: result,
          toolCalls: JSON.stringify(tc), createdAt: new Date().toISOString(),
        }).run();
        // L5: 统一截断策略 — API 上下文截断 50000 字符（足够容纳普通文件全文）
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 50000) });
      }

      // PF-02: 若工具调用预算耗尽，跳出外层 while 循环
      const toolBudgetLimit = budget.maxToolCalls > 0 ? budget.maxToolCalls : MAX_TOOL_CALLS_PER_REQUEST;
      if (toolCallCount > toolBudgetLimit) {
        budgetExceeded = 'tool_calls';
        break;
      }
    } else {
      // 没有工具调用，这是最终文本回复 → 回合正常结束
      aiContent = accumulatedContent || '';
      streamedContent = accumulatedContent || '';
      endedNormally = true;
      break;
    }
  }

  // 轮数自然耗尽（maxTurns 递减到 0 且未正常结束）→ 视为轮数预算耗尽
  if (!endedNormally && !budgetExceeded && turnsUsed >= budget.maxTurns) {
    budgetExceeded = 'turns';
  }

  return {
    aiContent,
    streamedContent,
    reasoningContent,
    usageTotal,
    lastToolResult,
    endedNormally,
    aiError,
    toolCallCount,
    budgetExceeded,
    turnsUsed,
    elapsedMs: Date.now() - loopStartedAt,
  };
}