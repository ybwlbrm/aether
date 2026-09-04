/**
 * 工具结果去重（W4-2：消除 agents / conversations / sync 三处完全相同的复制逻辑）
 *
 * 场景：视觉/分析类工具返回 JSON，AI 把这段 JSON 原样复述进回复文本 → 白字+绿框重复显示。
 * 规则：
 *  1. AI 回复与工具结果完全一致 → 替换为简短提示
 *  2. AI 回复包含工具结果前 60 字符（且工具结果 ≥60 字符）→ 替换为"完整结果"提示
 * 返回替换后的文本；若无工具结果或无需替换，返回原文本。
 */

export const DEDUP_EXACT_REPLACEMENT = '✅ 分析完成，结果请查看上方的「工具执行结果」。';
export const DEDUP_PARTIAL_REPLACEMENT = '✅ 分析完成，完整结果请查看上方的「工具执行结果」。';

/**
 * 若 AI 回复复述了工具执行结果，返回应替换的提示文本；否则返回 null（表示不替换）。
 */
export function dedupToolResultReplacement(aiContent: string | null | undefined, lastToolResult: string | null | undefined): string | null {
  if (!lastToolResult) return null;
  const trimmedAi = (aiContent || '').trim();
  if (trimmedAi.length === 0) return null;
  const trimmedTool = lastToolResult.trim();
  if (trimmedAi === trimmedTool) {
    return DEDUP_EXACT_REPLACEMENT;
  }
  if (trimmedTool.length >= 60 && trimmedAi.includes(trimmedTool.slice(0, 60))) {
    return DEDUP_PARTIAL_REPLACEMENT;
  }
  return null;
}

/**
 * 便捷包装：直接返回替换后的文本（未命中则返回原文本）。
 */
export function applyToolResultDedup(aiContent: string, lastToolResult: string | null | undefined): string {
  const replacement = dedupToolResultReplacement(aiContent, lastToolResult);
  return replacement ?? aiContent;
}
