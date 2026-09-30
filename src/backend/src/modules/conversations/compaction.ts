import { compactRemovedHistory, buildCompactionSystemMessage } from '../../lib/compaction.js';
import { buildChatRequestBody } from '../../lib/stream-translate.js';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';

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

/**
 * 执行强制总结（maxTurns 耗尽后的兜底）
 * 让 AI 基于所有工具结果给出完整答复，而不是填占位符
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