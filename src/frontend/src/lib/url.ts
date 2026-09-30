/**
 * 地址栏「网址 vs 搜索词」判定与规范化。
 *
 * 判定完全交给 `URL` 解析器（不手写协议正则），并只放行 http/https：
 * `javascript:` / `data:` / `file:` 等协议一律拒绝，
 * 保证 iframe 的 src 永远拿不到可执行协议。
 */

const HTTP_SCHEMES = new Set(['http:', 'https:']);

/** 裸主机（无协议）被当作网址时允许的公共后缀。
 *  不在表内的点号 token（如 `foo.bar`）交给调用方当搜索词。 */
const KNOWN_TLDS = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int',
  'io', 'ai', 'dev', 'app', 'co', 'me', 'tv', 'cc', 'info', 'biz', 'xyz', 'online', 'site', 'tech',
  'store', 'shop', 'blog', 'news', 'cloud', 'digital', 'design', 'life', 'world', 'today', 'space',
  'fun', 'pro', 'name', 'wiki', 'media', 'studio', 'live', 'link', 'page', 'systems', 'network',
  'us', 'uk', 'ca', 'au', 'nz', 'cn', 'jp', 'kr', 'tw', 'hk', 'sg', 'my', 'th', 'vn', 'id', 'in',
  'de', 'fr', 'es', 'it', 'nl', 'be', 'ch', 'at', 'se', 'no', 'fi', 'dk', 'ie', 'pt', 'pl', 'cz',
  'ru', 'ua', 'tr', 'gr', 'br', 'mx', 'ar', 'cl', 'za', 'il', 'ae', 'sa', 'eu', 'asia',
]);

function tryParse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** 单一事实源：URL-like 输入 → 规范化字符串；否则 null。 */
function toHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '' || /\s/.test(trimmed) || trimmed.startsWith('//')) return null;

  const asIs = tryParse(trimmed);
  if (asIs && HTTP_SCHEMES.has(asIs.protocol)) return asIs.href;

  // 剩余输入按裸主机处理：localhost:3000 / example.com / 192.168.1.5:8080
  if (trimmed.includes('://')) return null;
  const bare = tryParse(`http://${trimmed}`);
  if (!bare) return null;

  // `localhost:3000` 会被解析成 scheme `localhost:` + 路径 `3000`，
  // 这种「看起来像协议」的输入必须确有端口，否则按未知协议拒绝。
  if (asIs && bare.port === '') return null;

  const hasPath = bare.pathname !== '/' || bare.search !== '' || bare.hash !== '';
  const labels = bare.hostname.split('.');
  const looksLikeAddress =
    bare.port !== '' || hasPath || bare.hostname.startsWith('www.') || KNOWN_TLDS.has(labels[labels.length - 1] ?? '');
  return looksLikeAddress ? bare.href : null;
}

/** 判断输入是「网址」还是「搜索关键词」（关键词由调用方回退到 DuckDuckGo）。 */
export function isUrlLike(input: string): boolean {
  return toHref(input) !== null;
}

/** 规范化网址：补全缺省 scheme 后返回标准 URL 字符串；非网址返回 null。 */
export function normalizeUrl(input: string): string | null {
  return toHref(input);
}
