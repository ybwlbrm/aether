import { compactRemovedHistory, buildCompactionSystemMessage } from '../../lib/compaction.js';
import { buildChatRequestBody } from '../../lib/stream-translate.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { parseSse, withChunkTimeout } from '../../lib/sse-parser.js';
import { translate } from '../../lib/stream-translate.js';
import { SSE_CHUNK_TIMEOUT_MS } from '../../lib/sse-utils.js';

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
    const summaryReq = buildChatRequestBody({
      model: activeModel,
      messages: [
        ...apiMessages,
        { role: 'user', content: '请基于上面所有工具执行的结果，给出完整的总结与最终答复。如果任务还没完成，请继续说明还需要做什么。' }
      ],
      tools: activeTools,
      tool_choice: 'none',
      deepThinking,
      reasoningEffort,
      supportsThinking,
    });

    const summaryRes = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(summaryReq),
      signal: clientAbortSignal,
    }, sseSend);

    if (!summaryRes.ok) return null;

    const sReader = summaryRes.body!.getReader();
    let summaryText = '';
    try {
      for await (const c of translate(parseSse(withChunkTimeout(sReader, SSE_CHUNK_TIMEOUT_MS, clientAbortSignal)))) {
        if (c.type === 'text-delta') summaryText += c.text;
      }
    } catch {
      // 流式解析失败则用已累积文本
    }

    if (summaryText.trim()) {
      // 流式推送给前端
      sseSend('message', JSON.stringify({ content: summaryText.trim() }));
      eventBus.emit(runContext.sessionId, 'agent.message.delta', {
        taskId: runContext.taskId,
        agentId: runContext.agentId,
        agentType: runContext.agentType,
        content: summaryText.trim(),
      });
      return summaryText.trim();
    }
  } catch {
    // 强制总结失败则回退占位符
  }
  return null;
}