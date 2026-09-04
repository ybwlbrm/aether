import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB_FETCH_TIMEOUT, WEB_FETCH_MAX_OUTPUT } from './constants.js';
import { isPathSafe, resolveSearchPath } from './path-utils.js';
import { isSafeFetchUrl } from './ssrf.js';
import { decodeHtmlEntities, stripTags } from './html-utils.js';

/**
 * web_fetch — 获取公网网页内容并转换为纯文本/markdown
 * 带 SSRF 防护：禁止访问本地/内网/云元数据地址
 */
export async function executeWebFetch(
  url: string,
  format?: string,
  allowedDirs?: string[],
  permissionLevel?: number,
  defaultDir?: string,
): Promise<string> {
  try {
    if (!url || !url.trim()) return '错误: 请提供网页 URL';

    // 支持 file:// 协议：读取本地文件（带安全校验）
    if (url.startsWith('file://')) {
      try {
        const { fileURLToPath } = await import('node:url');
        const resolvedPath = resolve(fileURLToPath(url));
        const check = isPathSafe(resolvedPath, allowedDirs, permissionLevel);
        if (!check.ok) return `错误: ${check.error}`;
        if (!existsSync(resolvedPath)) return `错误: 本地文件不存在: ${resolvedPath}`;
        const stat = statSync(resolvedPath);
        if (!stat.isFile()) return `错误: 不是文件: ${resolvedPath}`;
        if (stat.size > 1024 * 1024) return `错误: 文件过大（>1MB），无法读取`;
        const content = readFileSync(resolvedPath, 'utf-8');
        const preview = content.length > WEB_FETCH_MAX_OUTPUT ? content.slice(0, WEB_FETCH_MAX_OUTPUT) + '\n...(内容已截断)' : content;
        return `本地文件内容 (${resolvedPath}):\n${preview}`;
      } catch (e: unknown) {
        return `错误: 无法读取本地文件: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // P0：SSRF 校验 — 不安全地址直接拒绝，不发出请求
    if (!isSafeFetchUrl(url)) {
      return `错误: 不允许访问该 URL（仅支持公网 http/https 地址）: ${url}`;
    }

    let currentUrl = url;
    let redirectCount = 0;
    const MAX_REDIRECTS = 3;
    let res: Response;

    while (redirectCount <= MAX_REDIRECTS) {
      res = await fetch(currentUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT),
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
          return `错误: 重定向 URL 解析失败: ${location}`;
        }
        // 校验重定向目标
        if (!isSafeFetchUrl(nextUrl)) {
          return `错误: 重定向目标不安全（SSRF 防护）: ${nextUrl}`;
        }
        currentUrl = nextUrl;
        redirectCount++;
        continue;
      }

      // 非重定向响应，跳出循环处理内容
      break;
    }

    if (redirectCount > MAX_REDIRECTS) {
      return `错误: 重定向次数过多（超过 ${MAX_REDIRECTS} 次）`;
    }

    if (!res!.ok) return `错误: 请求失败 (HTTP ${res!.status})`;

    const contentType = res!.headers.get('content-type') || '';
    const raw = await res!.text();

    // 非 HTML/XML 内容（纯文本/JSON 等）直接返回原文
    const looksLikeHtml = contentType.includes('html') || contentType.includes('xml')
      || /<html[\s>]|<!doctype\s+html/i.test(raw.slice(0, 1000));
    if (!looksLikeHtml) {
      const body = raw.length > WEB_FETCH_MAX_OUTPUT
        ? raw.slice(0, WEB_FETCH_MAX_OUTPUT) + '\n...(内容已截断)'
        : raw;
      return `URL 内容 (${url}):\n${body}`;
    }

    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(stripTags(titleMatch[1])).trim() : '';

    // 移除非正文标签与注释
    let processed = raw
      .replace(/<(script|style|noscript|svg|iframe|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    if (format === 'markdown') {
      // 轻量 markdown 转换：保留标题层级与超链接
      processed = processed
        .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n`)
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner).trim()}`)
        .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `[${stripTags(inner).trim()}](${href})`);
    }

    // 块级标签转换行，再剥离剩余标签
    let text = processed
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

    text = decodeHtmlEntities(text)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();

    if (!text) return `错误: 未能从页面提取到文本内容: ${url}`;

    const header = title ? `标题: ${title}\n\n` : '';
    const truncated = text.length > WEB_FETCH_MAX_OUTPUT;
    const body = truncated ? text.slice(0, WEB_FETCH_MAX_OUTPUT) + '\n...(内容已截断)' : text;
    const formatLabel = format === 'markdown' ? ' [markdown]' : '';
    return `网页内容${formatLabel} (${url}):\n${header}${body}`;
  } catch (e: unknown) {
    return `工具执行错误: ${(e instanceof Error ? e.message : String(e))}`;
  }
}