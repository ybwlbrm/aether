import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desc, like, eq } from 'drizzle-orm';
import { getDb, saveDb } from '../../db/client.js';
import { searchHistory, messages, conversations } from '../../db/schema/index.js';
import { isPublicFetchUrl } from '../../lib/safe-fetch.js';

/** 扫描目录查找文件名/内容匹配本地文件的简单全文搜索 */
function searchLocalFiles(dir: string, query: string, maxResults = 10): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  const q = query.toLowerCase();
  const walk = (current: string, depth: number) => {
    if (depth > 3 || results.length >= maxResults) return;
    let entries: string[];
    try { entries = readdirSync(current); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'dist') continue;
      const fullPath = resolve(current, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else {
          // 文件名匹配
          if (name.toLowerCase().includes(q)) {
            results.push({ title: name, url: fullPath, snippet: `本地文件（${(stat.size / 1024).toFixed(0)}KB）` });
            if (results.length >= maxResults) return;
            continue;
          }
          // 内容匹配（仅文本文件）
          const ext = name.split('.').pop() || '';
          if (['md', 'txt', 'json', 'csv', 'js', 'ts', 'html', 'css', 'log'].includes(ext) && stat.size < 1024 * 1024) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              const idx = content.toLowerCase().indexOf(q);
              if (idx !== -1) {
                const start = Math.max(0, idx - 50);
                results.push({ title: name, url: fullPath, snippet: content.slice(start, start + 120).replace(/\s+/g, ' ').trim() + '...' });
                if (results.length >= maxResults) return;
              }
            } catch { /* binary or read error */ }
          }
        }
      } catch (_e: unknown) { /* ignore - intentional */ }
    }
  };
  walk(dir, 0);
  return results;
}

/** 简单网页抓取：提取 title 和 meta description */
// Wave0-SS (P0-13): SSRF 校验统一复用 lib/safe-fetch 的 isPublicFetchUrl（公网-only），
// 与 provider/media/下载器共享同一套基础设施 —— 消除本文件第三份独立实现。
// DuckDuckGo 结果 URL 由第三方站点决定，恶意结果页可将请求导向 169.254.169.254
// （云元数据）等内网地址；IPv6 字面量与 DNS rebinding 由 safe-fetch 层统一拦截。

async function fetchWebPage(url: string, query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  // Wave0-SS: 公网-only 校验 — 不安全地址直接跳过，不发出请求
  if (!isPublicFetchUrl(url)) return [];

  let currentUrl = url;
  let redirectCount = 0;
  const MAX_REDIRECTS = 5;

  while (redirectCount <= MAX_REDIRECTS) {
    try {
      const res = await fetch(currentUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
        redirect: 'manual',
      });

      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          // 无 Location 头，视为无重定向
          break;
        }
        // 解析重定向目标 URL（支持相对路径）
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          return [];
        }
        // Wave0-SS: 重定向目标同样走公网-only 校验
        if (!isPublicFetchUrl(nextUrl)) {
          return [];
        }
        currentUrl = nextUrl;
        redirectCount++;
        continue;
      }

      // 非重定向响应，提取内容
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
      const title = titleMatch ? titleMatch[1].trim() : currentUrl;
      let snippet = descMatch ? descMatch[1].trim() : '';
      // 若无 description，尝试提取正文首段文字
      if (!snippet) {
        const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const idx = bodyText.toLowerCase().indexOf(query.toLowerCase());
        snippet = idx !== -1 ? bodyText.slice(idx, idx + 150) : bodyText.slice(0, 150);
      }
      return [{ title, url: currentUrl, snippet }];
    } catch {
      return [];
    }
  }

  // 超过最大重定向次数
  return [];
}

/** 来源权重：本地 > 网页抓取 > DuckDuckGo（本地精确/标题命中更高） */
const SOURCE_WEIGHTS: Record<string, number> = {
  local: 1.0,
  web: 0.8,
  duckduckgo: 0.6,
};

/** 计算单条结果的相关性分数
 *  公式：score = sourceWeight * 0.5 + titleMatch * 0.3 + keywordMatch * 0.15 + recency * 0.05
 *  - sourceWeight: 来源固定权重
 *  - titleMatch: 标题是否包含查询词（大小写不敏感，词边界加分）
 *  - keywordMatch: snippet/内容中查询词出现频次归一化
 *  - recency: 若有 updated_at/date，按天衰减（半衰期 30 天），无日期则 0.5
 */
function computeRelevanceScore(
  result: { title: string; snippet: string; source: string; date?: string; url: string },
  query: string
): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  // 1. 来源权重
  const sourceWeight = SOURCE_WEIGHTS[result.source] ?? 0.5;

  // 2. 标题匹配强度（0-1）
  const titleLower = result.title.toLowerCase();
  let titleMatch = 0;
  if (titleLower.includes(q)) {
    titleMatch = 0.7;
    // 词边界匹配加分：查询词作为独立词出现
    const wordBoundaryRegex = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (wordBoundaryRegex.test(result.title)) titleMatch = 1.0;
    // 标题以查询词开头再加分
    if (titleLower.startsWith(q)) titleMatch = 1.0;
  }

  // 3. 关键词在 snippet 中的匹配强度（0-1）
  const snippetLower = result.snippet.toLowerCase();
  let keywordMatch = 0;
  if (snippetLower.includes(q)) {
    const occurrences = (snippetLower.match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
    keywordMatch = Math.min(occurrences / 5, 1); // 5 次以上封顶
  }

  // 4. 时效性（0-1），半衰期 30 天
  let recency = 0.5;
  if (result.date) {
    try {
      const resultDate = new Date(result.date);
      const now = new Date();
      const daysDiff = (now.getTime() - resultDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff >= 0) {
        recency = Math.exp(-daysDiff / 30); // 30 天半衰期
      }
    } catch {
      recency = 0.5;
    }
  }

  // 加权组合
  const score = sourceWeight * 0.5 + titleMatch * 0.3 + keywordMatch * 0.15 + recency * 0.05;
  return Number(score.toFixed(4));
}

/** 从请求中提取分页参数（支持 body 与 query 双通道） */
function extractPaginationParams(request: { body: unknown; query: unknown }): { page: number; pageSize: number; hasPageParam: boolean } {
  const body = request.body as Record<string, unknown> | undefined;
  const query = request.query as Record<string, unknown> | undefined;

  // 优先 body，其次 query
  const pageRaw = (body?.page ?? query?.page) as string | number | undefined;
  const pageSizeRaw = (body?.pageSize ?? query?.pageSize) as string | number | undefined;

  const hasPageParam = pageRaw !== undefined;

  let page = 1;
  if (pageRaw !== undefined) {
    const parsed = typeof pageRaw === 'string' ? parseInt(pageRaw, 10) : pageRaw;
    page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  let pageSize = 20;
  if (pageSizeRaw !== undefined) {
    const parsed = typeof pageSizeRaw === 'string' ? parseInt(pageSizeRaw, 10) : pageSizeRaw;
    pageSize = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;
  }

  return { page, pageSize, hasPageParam };
}

export function registerSearchRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 搜索接口：聚合多源 + 相关性排序 + 分页
  app.post('/api/search', {
    schema: {
      description: '聚合搜索（DuckDuckGo + 本地文件 + 网页抓取），支持相关性排序与分页',
      tags: ['搜索'],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { query: string; sources?: string[] };
    const sources = body.sources || ['duckduckgo', 'local', 'web'];
    const results: Array<{ title: string; url: string; snippet: string; source: string; date: string; score?: number }> = [];
    const date = new Date().toISOString();

    // DuckDuckGo search (free, no API key needed)
    if (sources.includes('duckduckgo')) {
      try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(body.query)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const html = await res.text();
          const blockRegex = /<div class="result[^"]*">[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
          let match;
          while ((match = blockRegex.exec(html)) !== null && results.length < 10) {
            results.push({
              title: match[2].replace(/<[^>]+>/g, '').trim(),
              url: match[1].startsWith('http') ? match[1] : `https://duckduckgo.com${match[1]}`,
              snippet: (match[3] || '').replace(/<[^>]+>/g, '').trim(),
              source: 'duckduckgo',
              date,
            });
          }
        }
      } catch (e: unknown) {
        console.error('[Search] DuckDuckGo error:', (e instanceof Error ? e.message : String(e)));
      }
    }

    // 本地文件搜索
    if (sources.includes('local')) {
      try {
        const dirs = [resolve(config.dataDir), resolve('./workspace')].filter(d => existsSync(d));
        for (const dir of dirs) {
          for (const f of searchLocalFiles(dir, body.query, 5)) {
            results.push({ ...f, source: 'local', date });
          }
        }
      } catch (e: unknown) {
        console.error('[Search] Local error:', (e instanceof Error ? e.message : String(e)));
      }
    }

    // 网页抓取：用 DuckDuckGo 结果的 URL 抓取正文（增强 snippet）
    if (sources.includes('web')) {
      try {
        const targets = results.filter(r => r.source === 'duckduckgo').slice(0, 3).map(r => r.url);
        if (targets.length === 0) {
          // DuckDuckGo 不可用时，直接抓取一个常见搜索 URL
          targets.push(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(body.query)}`);
        }
        for (const url of targets.slice(0, 2)) {
          for (const page of await fetchWebPage(url, body.query)) {
            results.push({ ...page, source: 'web', date });
          }
        }
      } catch (e: unknown) {
        console.error('[Search] Web error:', (e instanceof Error ? e.message : String(e)));
      }
    }

    // 去重（按 url）
    const seen = new Set<string>();
    const deduped = results.filter(r => {
      const key = r.url || r.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 计算相关性分数并按分数降序排序（同分保持来源内部稳定顺序）
    const scored = deduped.map(r => ({ ...r, score: computeRelevanceScore(r, body.query) }));
    scored.sort((a, b) => {
      // 主键：分数降序
      if (b.score !== a.score) return (b.score ?? 0) - (a.score ?? 0);
      // 次键：来源权重降序（保持来源内部稳定顺序）
      const wa = SOURCE_WEIGHTS[a.source] ?? 0;
      const wb = SOURCE_WEIGHTS[b.source] ?? 0;
      return wb - wa;
    });

    // 分页参数
    const { page, pageSize, hasPageParam } = extractPaginationParams(request);
    const total = scored.length;

    // 无 page 参数时：返回前 20 条 + total（向后兼容，老调用方不破）
    // 有 page 参数时：返回切片 + total/hasMore/page/pageSize
    let pagedResults: typeof scored;
    let hasMore = false;

    if (!hasPageParam) {
      // 兼容模式：只返回前 20 条（与 page=1, pageSize=20 一致），但 total 为全部
      pagedResults = scored.slice(0, 20);
    } else {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      pagedResults = scored.slice(start, end);
      hasMore = end < total;
    }

    // 保存搜索历史
    try {
      const db = getDb();
      db.insert(searchHistory).values({
        id: randomUUID(),
        query: body.query,
        sources: JSON.stringify(sources),
        resultCount: total,
        createdAt: new Date().toISOString(),
      }).run();
      saveDb(config);
    } catch (e: unknown) {
      console.error('[Search] 保存历史失败:', (e instanceof Error ? e.message : String(e)));
    }

    // 响应形状：保留所有现有字段；新增可选字段（total/page/pageSize/hasMore/score）
    const response: {
      results: typeof pagedResults;
      total: number;
      query: string;
      page?: number;
      pageSize?: number;
      hasMore?: boolean;
    } = {
      results: pagedResults,
      total,
      query: body.query,
    };

    if (hasPageParam) {
      response.page = page;
      response.pageSize = pageSize;
      response.hasMore = hasMore;
    }

    return response;
  });

  // 获取搜索历史（最近 50 条）
  app.get('/api/search/history', {
    schema: { description: '获取最近 50 条搜索历史', tags: ['搜索'] },
  }, async () => {
    const db = getDb();
    const history = db.select().from(searchHistory).orderBy(desc(searchHistory.createdAt)).limit(50).all();
    return { history };
  });

  // 清空搜索历史
  app.delete('/api/search/history', {
    schema: { description: '清空全部搜索历史', tags: ['搜索'] },
  }, async () => {
    const db = getDb();
    db.delete(searchHistory).run();
    try { saveDb(config); } catch (e: unknown) { console.error('[Search] 清空历史持久化失败:', (e instanceof Error ? e.message : String(e))); }
    return { success: true };
  });

  // 对话消息搜索：messages.content LIKE 匹配，按对话分组返回
  app.post('/api/search/conversations', {
    schema: {
      description: '搜索对话消息内容（LIKE 匹配，按对话分组）',
      tags: ['搜索'],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { query: string; limit?: number };
    const query = body.query.trim();
    if (!query) return { results: [], total: 0 };
    const limit = Math.min(Math.max(body.limit ?? 20, 1), 100);

    const db = getDb();
    // sql.js 驱动为同步 API；drizzle 的 like() 使用参数绑定，天然防注入
    const rows = db.select({
      messageId: messages.id,
      content: messages.content,
      role: messages.role,
      createdAt: messages.createdAt,
      conversationId: conversations.id,
      conversationTitle: conversations.title,
    })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(like(messages.content, `%${query}%`))
      .limit(limit)
      .all();

    // 按对话分组，并为每条消息生成命中位置附近的 snippet
    const grouped = new Map<string, {
      conversationId: string;
      conversationTitle: string;
      messages: { id: string; content: string; role: string; snippet: string }[];
    }>();
    for (const row of rows) {
      const idx = row.content.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - 40);
      const raw = (idx === -1 ? row.content : row.content.slice(start, start + 120)).replace(/\s+/g, ' ').trim();
      const snippet = idx !== -1 && row.content.length > start + 120 ? raw + '...' : raw;
      const entry = grouped.get(row.conversationId) || {
        conversationId: row.conversationId,
        conversationTitle: row.conversationTitle,
        messages: [],
      };
      entry.messages.push({ id: row.messageId, content: row.content, role: row.role, snippet });
      grouped.set(row.conversationId, entry);
    }

    return { results: [...grouped.values()], total: rows.length, query };
  });

  // 记录搜索历史（供前端本地搜索源使用 — 知识库/媒体库/对话搜索不经过 /api/search）
  app.post('/api/search/record', {
    schema: {
      description: '记录搜索历史（供前端本地搜索源使用）',
      tags: ['搜索'],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          resultCount: { type: 'integer' },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { query: string; sources?: string[]; resultCount?: number };
    try {
      const db = getDb();
      db.insert(searchHistory).values({
        id: randomUUID(),
        query: body.query,
        sources: JSON.stringify(body.sources || ['local']),
        resultCount: body.resultCount || 0,
        createdAt: new Date().toISOString(),
      }).run();
      saveDb(config);
      return { success: true };
    } catch (e: unknown) {
      console.error('[Search] 记录历史失败:', (e instanceof Error ? e.message : String(e)));
      return { success: false, error: '记录失败' };
    }
  });

  // 获取搜索源列表
  app.get('/api/search/sources', {
    schema: { description: '获取可用搜索源列表', tags: ['搜索'] },
  }, async () => ({
    sources: [
      { id: 'duckduckgo', label: 'DuckDuckGo（无广告）', free: true, requiresKey: false },
      { id: 'local', label: '本地文件', free: true, requiresKey: false },
      { id: 'web', label: '网页抓取', free: true, requiresKey: false },
    ],
  }));
}