import { isSafeFetchUrl } from './safe-fetch.js';

/**
 * 上下文压缩（compaction）— 参考 DeepSeek Harness `packages/compaction`。
 *
 * 现状问题：当前上下文管理用「字符毛估截断」——超预算时直接从最早消息开始丢弃，
 * 丢失信息。compaction 的做法是：被移除的最早历史交给 LLM 生成摘要，作为一条
 * system 级摘要消息注入请求，替代「直接丢弃」，兼顾上下文窗口与信息保真。
 *
 * 本实现为轻量版：
 * - 仅在字符截断「确实移除了消息」时触发一次摘要；
 * - 摘要请求用非流式（stream:false），失败时静默回退到直接丢弃（不阻塞主流程）；
 * - 摘要结果作为 `{role:'system', content:'[对话摘要] ...'}` 插入 apiMessages 开头。
 */

export interface CompactParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 被移除的最早历史消息（raw DB rows） */
  removedHistory: Array<{ role: string; content: string }>;
  /** 本次对话最近内容（给摘要提供主题语境） */
  recentContext: string;
  signal?: AbortSignal;
}

/**
 * 用 LLM 生成历史摘要。失败时返回 null（调用方回退到直接丢弃）。
 */
export async function compactRemovedHistory(
  params: CompactParams,
): Promise<string | null> {
  const { baseUrl, apiKey, model, removedHistory, recentContext, signal } = params;
  if (removedHistory.length === 0) return null;

  const transcript = removedHistory
    .map(m => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '工具'}: ${String(m.content).slice(0, 600)}`)
    .join('\n');
  // 超出 24k 字符的老历史只压缩样本（摘要本身就要受控大小）
  const sample = transcript.length > 24000 ? transcript.slice(-24000) : transcript;

  const reqBody: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'system',
        content: '你是会话压缩器。把以下对话历史压缩成一个简明、信息密度高的中文摘要（保留用户意图、关键决策、重要结论、文件路径与工具结果要点）。输出纯文本摘要，不要加标题框、不要复述原文。',
      },
      {
        role: 'user',
        content: `以下是需要压缩的旧对话历史：\n${sample}\n\n当前对话主题参考：${recentContext.slice(0, 300)}`,
      },
    ],
    stream: false,
    max_tokens: 1500,
    temperature: 0.3,
  };

  let res: Response;
  try {
    // 纵深防御：显式校验 baseUrl（虽受控但防配置篡改/注入）
    if (!isSafeFetchUrl(baseUrl)) return null;
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      signal: signal ?? AbortSignal.timeout(30000),
    });
  } catch {
    return null; // 网络失败静默回退
  }
  if (!res.ok) return null;
  try {
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * 组装摘要 system 消息（供插入 apiMessages）。
 */
export function buildCompactionSystemMessage(summary: string): { role: 'system'; content: string } {
  return { role: 'system', content: `[对话摘要] ${summary}` };
}