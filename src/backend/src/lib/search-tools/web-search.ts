import { WEB_SEARCH_TIMEOUT } from './constants.js';
import { decodeHtmlEntities, stripTags } from './html-utils.js';

/**
 * web_search — DuckDuckGo 搜索（免费，无需 API Key）
 * 返回格式化的标题、链接和摘要列表
 */
export async function executeWebSearch(query: string, maxResults?: number): Promise<string> {
  try {
    if (!query || !query.trim()) return '错误: 搜索关键词不能为空';
    const limit = Math.max(1, Math.min(maxResults ?? 5, 10));

    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT),
    });
    if (!res.ok) return `错误: 搜索请求失败 (HTTP ${res.status})`;

    const html = await res.text();
    const blockRegex = /<div class="result[^"]*">[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
    const results: { title: string; url: string; snippet: string }[] = [];
    let match;
    while ((match = blockRegex.exec(html)) !== null && results.length < limit) {
      results.push({
        title: decodeHtmlEntities(stripTags(match[2])).trim(),
        url: match[1].startsWith('http') ? match[1] : `https://duckduckgo.com${match[1]}`,
        snippet: decodeHtmlEntities(stripTags(match[3] || '')).trim(),
      });
    }

    if (results.length === 0) return `未找到与 "${query}" 相关的结果`;

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\n   链接: ${r.url}\n   摘要: ${r.snippet || '（无摘要）'}`)
      .join('\n\n');
    return `搜索 "${query}" 的结果 (${results.length} 条):\n\n${formatted}`;
  } catch (e: unknown) {
    return `工具执行错误: ${(e instanceof Error ? e.message : String(e))}`;
  }
}