/**
 * Auth Guard — 默认拒绝的请求鉴权 hook（整改计划第 1 章，P0）。
 *
 * 原则：所有非 GET/HEAD 路由缺 Bearer 一律 401；健康检查、静态资源、
 * 显式登录/本地 bootstrap 才允许匿名。CSRF X-Requested-With 检查保留，
 * 但不把它当身份验证。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyAuthToken } from './auth-token.js';

/** 公开匿名白名单：GET 精确路径（健康检查 / 本地 bootstrap / 显式登录） */
export const PUBLIC_GET_PATHS = [
  '/api/health',
  '/api/auth/token',
];

/** 公开匿名白名单：静态资源前缀（GET/HEAD） */
export const PUBLIC_STATIC_PREFIXES = [
  '/data/backgrounds/',
  '/data/chat-images/',
  '/docs',
];

/** 敏感读路径：GET 同样需要 token（"GET=安全"假设不成立） */
export const SENSITIVE_READ_PATHS = [
  '/api/export/all',
  '/api/sync/download',
  '/api/sync/config',
  '/api/approvals',
];

export interface AuthGuardOptions {
  publicGetPaths?: string[];
  publicStaticPrefixes?: string[];
  sensitiveReadPaths?: string[];
}

/** 判断 url 是否精确命中或命中前缀。
 *  前缀语义：p 为 `/api/approvals` 或 `/api/approvals/` 时，两者都匹配
 *  `/api/approvals` 与 `/api/approvals/:id`；但 `/api/approvals-other` 不匹配。 */
function matchesPath(list: string[], url: string): boolean {
  return list.some((p) => {
    if (url === p) return true;
    const prefix = p.endsWith('/') ? p : `${p}/`;
    return url.startsWith(prefix);
  });
}

/**
 * 安装默认拒绝鉴权 hook：
 * 1. Swagger UI (/docs) 豁免（含 Try-it-out 的 POST）
 * 2. CSRF 检查：状态变更请求必须带 X-Requested-With（不当作身份验证）
 * 3. OPTIONS（CORS preflight）放行
 * 4. GET/HEAD：公开路径/静态资源匿名；敏感读路径需 token；其余匿名
 * 5. 其余所有方法（POST/PUT/DELETE/PATCH...）：默认拒绝，必须 Bearer
 */
export function installAuthGuard(app: FastifyInstance, opts: AuthGuardOptions = {}): void {
  const publicGet = opts.publicGetPaths ?? PUBLIC_GET_PATHS;
  const publicStatic = opts.publicStaticPrefixes ?? PUBLIC_STATIC_PREFIXES;
  const sensitiveRead = opts.sensitiveReadPaths ?? SENSITIVE_READ_PATHS;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const method = request.method.toUpperCase();
    const url = request.url.split('?')[0];

    // Swagger UI 豁免（与历史行为一致，Try-it-out 需要 POST）
    if (url === '/docs' || url.startsWith('/docs/')) return;

    // CSRF 检查 — 保留，但不作为身份验证
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      const xrw = request.headers['x-requested-with'];
      if (!xrw || xrw !== 'XMLHttpRequest') {
        return reply.code(403).send({ error: { message: 'CSRF check failed: missing X-Requested-With header' } });
      }
    }

    // CORS preflight 放行
    if (method === 'OPTIONS') return;

    // GET/HEAD：公开路径 / 静态资源匿名；敏感读需 token
    if (method === 'GET' || method === 'HEAD') {
      if (publicGet.includes(url)) return;
      if (publicStatic.some((p) => url.startsWith(p))) return;
      if (matchesPath(sensitiveRead, url)) {
        if (!verifyAuthToken(request.headers.authorization)) {
          return reply.code(401).send({ error: { message: 'Unauthorized: invalid or missing auth token' } });
        }
      }
      return;
    }

    // 默认拒绝：所有非 GET/HEAD 必须 Bearer
    if (!verifyAuthToken(request.headers.authorization)) {
      return reply.code(401).send({ error: { message: 'Unauthorized: invalid or missing auth token' } });
    }
  });
}
