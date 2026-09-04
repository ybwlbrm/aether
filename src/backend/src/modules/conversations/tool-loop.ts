import { randomUUID } from 'node:crypto';
import { executeTool } from '../../lib/tool-executor.js';
import { buildToolPayload } from '@pacc/shared';
import { parseToolArgsSafe } from '../../lib/stream-translate.js';
import { createPendingApproval } from '../../lib/approvals-center.js';
import { drainDirectives } from '../../lib/inbox.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { buildChatRequestBody } from '../../lib/stream-translate.js';
import { parseSse, withChunkTimeout } from '../../lib/sse-parser.js';
import { translate } from '../../lib/stream-translate.js';
import { SSE_CHUNK_TIMEOUT_MS } from '../../lib/sse-utils.js';
import { messages } from '../../db/schema/index.js';

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
  } = config;

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

  let maxTurns = configMaxTurns;

  while (maxTurns-- > 0) {
    // inbox 指令（steer/followup）：运行中用户补充的指令 → drain 为 user 消息注入下一轮
    const directives = drainDirectives(conversationId);
    for (const d of directives) {
      apiMessages.push({ role: 'user', content: `[补充指令] ${d.text}` });
    }

    // 流式调用 AI API（带重试）— 请求体用 buildChatRequestBody（thinking/reasoning_effort 门控）
    const reqBody = buildChatRequestBody({
      model: activeModel,
      messages: apiMessages,
      tools: activeTools,
      tool_choice: 'auto',
      deepThinking,
      reasoningEffort,
      supportsThinking,
    });

    const toolCallResponse = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      // BE-05: 传 clientAbort.signal — fetchWithRetry 内部叠加 120s timeout
      signal: clientAbortSignal,
    }, sseSend);

    if (!toolCallResponse.ok) {
      const errText = await toolCallResponse.text();
      throw new Error(`AI API 请求失败 (${toolCallResponse.status}): ${errText.slice(0, 200)}`);
    }

    // 解析流式响应 — translate 统一协议
    const reader = toolCallResponse.body!.getReader();
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let currentToolCalls: any[] = [];
    let hasReasoning = false;
    let turnFinish: 'stop' | 'tool_calls' | 'max-tokens' | 'error' = 'stop';

    try {
      for await (const c of translate(parseSse(withChunkTimeout(reader, SSE_CHUNK_TIMEOUT_MS, clientAbortSignal)))) {
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
      if (e instanceof Error && e.name === 'SseStreamError') {
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
        // PF-02: 工具调用预算检查 — 超过 50 次则优雅终止
        toolCallCount++;
        if (toolCallCount > MAX_TOOL_CALLS_PER_REQUEST) {
          const budgetMsg = `⚠️ 已达到工具调用上限 (${MAX_TOOL_CALLS_PER_REQUEST} 次)，本次请求停止执行。如需继续，请发送新消息。`;
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
          // BE-05: 传递 abort signal 到工具执行，支持客户端断连时取消
          const execResult = await executeTool(funcName, args, {
            mcpTools,
            getMcpServers,
            allowedDirs,
            permissionLevel: settings.permissionLevel ?? 2,
            defaultDir,
            sessionId: conversationId,
            signal: clientAbortSignal,
            onApproval: async (toolName, toolArgs, argsSummary) => {
              // 发起审批挂起：SSE 推送 task.ask-confirm 事件，前端弹窗让用户决定
              const { id: approvalId, promise } = createPendingApproval({
                toolName,
                args: toolArgs,
                conversationId,
                prompt: ({ id: apId, toolName: name, argsSummary: summ }) => {
                  sseSend('ask-confirm', JSON.stringify({ id: apId, toolName: name, argsSummary: summ }));
                  eventBus.emit(runContext.sessionId, 'task.ask-confirm', {
                    taskId: runContext.taskId,
                    agentId: runContext.agentId,
                    agentType: runContext.agentType,
                    content: `需要确认执行工具 ${name}`,
                    metadata: { approvalId: apId, toolName: name, argsSummary: summ },
                  });
                },
              });
              const { approved, decision } = await promise;
              // 决议结果事件
              eventBus.emit(runContext.sessionId, 'task.plan', {
                taskId: runContext.taskId,
                agentId: runContext.agentId,
                agentType: runContext.agentType,
                content: approved
                  ? `用户已批准执行 ${toolName}`
                  : `用户未批准 ${toolName}（${decision === 'timeout' ? '审批超时' : '已拒绝'}）`,
              });
              return { approved, decision };
            },
          });
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
      if (toolCallCount > MAX_TOOL_CALLS_PER_REQUEST) {
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

  return {
    aiContent,
    streamedContent,
    reasoningContent,
    usageTotal,
    lastToolResult,
    endedNormally,
    aiError,
    toolCallCount,
  };
}