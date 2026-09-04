/**
 * 上下文窗口管理（W4-2：消除 orchestration / chat-handler 两处重复的 token 预算法截断）
 *
 * AI-007 修正：原实现用「4 字符/token」估算，对中文（1 token ≈ 1-1.5 字）偏差 2-4 倍，
 * 会导致过早截断。改为按内容语言估算单条消息的字符/token 比率：
 *  - 含较多 CJK 字符 → 2 字符/token（更接近中文实际）
 *  - 纯 ASCII → 4 字符/token（英文/代码）
 */

/** CJK 统一表意文字等字符的近似 token 权重（字符/token） */
const CJK_CHARS_PER_TOKEN = 2;
const ASCII_CHARS_PER_TOKEN = 4;

/** 估算一条消息内容的字符数（非字符串按 200 计，与旧实现一致） */
export function contentCharCount(content: unknown): number {
  return typeof content === 'string' ? content.length : 200;
}

/**
 * 估算文本的平均字符/token 比率。
 * 统计 CJK 字符占比，CJK 为主的按 2 字符/token，否则按 4 字符/token。
 */
export function estimateCharsPerToken(text: string): number {
  if (!text) return ASCII_CHARS_PER_TOKEN;
  let cjk = 0;
  for (let i = 0; i < Math.min(text.length, 2000); i++) {
    const code = text.charCodeAt(i);
    // 常用 CJK 区段：中日韩统一表意文字 + 全角标点（0x3000-0x303F）+ 平假名/片假名
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      cjk++;
    }
  }
  if (cjk === 0) return ASCII_CHARS_PER_TOKEN;
  const ratio = cjk / Math.min(text.length, 2000);
  // 中文字符占比越高，每 token 对应字符越少（中文 1 token ≈ 1.5 字符）
  const blended = ASCII_CHARS_PER_TOKEN - (ASCII_CHARS_PER_TOKEN - CJK_CHARS_PER_TOKEN) * Math.min(1, ratio * 1.5);
  return Math.max(CJK_CHARS_PER_TOKEN, Math.round(blended * 10) / 10);
}

/**
 * 按 token 预算从最早消息开始截断历史，保底保留 minKeep 条。
 *
 * @param history  角色/内容消息数组（含 content 字段）
 * @param maxTokenBudget 总 token 预算
 * @param reserveRatio  保留给 system prompt + 工具结果的预算比例（0-1）
 * @param minKeep  最少保留的消息条数（保底）
 * @param getContent 可选内容提取器（默认取 m.content）
 * @returns 截断后的历史（原数组浅拷贝，不修改入参）
 */
export function truncateHistoryByTokenBudget<T extends { content?: unknown }>(
  history: T[],
  maxTokenBudget: number,
  reserveRatio: number,
  minKeep = 5,
  getContent: (m: T) => unknown = (m) => m.content,
): T[] {
  if (history.length === 0) return history;
  // 估算整体平均字符/token（采样全部消息，给出更真实的预算）
  let cjkChars = 0;
  let asciiChars = 0;
  for (const m of history) {
    const c = typeof getContent(m) === 'string' ? (getContent(m) as string) : '';
    for (let i = 0; i < Math.min(c.length, 2000); i++) {
      const code = c.charCodeAt(i);
      if (
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0x3400 && code <= 0x4dbf)
      ) {
        cjkChars++;
      } else if (code < 128) {
        asciiChars++;
      }
    }
  }
  const totalChars = cjkChars + asciiChars;
  const charsPerToken = totalChars > 0 && cjkChars > 0
    ? Math.max(CJK_CHARS_PER_TOKEN, (cjkChars * (1 / CJK_CHARS_PER_TOKEN) + asciiChars * (1 / ASCII_CHARS_PER_TOKEN)) > 0
        ? Math.round((totalChars / (cjkChars / CJK_CHARS_PER_TOKEN + asciiChars / ASCII_CHARS_PER_TOKEN)) * 10) / 10
        : ASCII_CHARS_PER_TOKEN)
    : ASCII_CHARS_PER_TOKEN;
  const charBudget = maxTokenBudget * charsPerToken * reserveRatio;

  const result = history.slice();
  let total = result.reduce((sum, m) => sum + contentCharCount(getContent(m)), 0);
  while (total > charBudget && result.length > minKeep) {
    const removed = result.shift();
    if (removed) total -= contentCharCount(getContent(removed));
  }
  return result;
}