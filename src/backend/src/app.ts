import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { registerErrorHandler } from './plugins/error-handler.js';
import { loadBackendConfig, type BackendConfig, migratePlaintextApiKeys } from './config/index.js';
import { initDb, markDirty, flushDbSync } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { registerHealthRoutes } from './modules/health/index.js';
import { registerProviderRoutes } from './modules/providers/index.js';
import { registerConversationRoutes } from './modules/conversations/index.js';
import { registerMediaRoutes } from './modules/media/index.js';
import { registerDocumentRoutes } from './modules/documents/index.js';
import { registerDataRoutes } from './modules/data/index.js';
import { registerAgentRoutes } from './modules/agents/index.js';
import { registerWorkspaceRoutes } from './modules/workspace/index.js';
import { registerBackgroundRoutes } from './modules/backgrounds/index.js';
import { registerToolboxRoutes } from './modules/toolbox/index.js';
import { registerSearchRoutes } from './modules/search/index.js';
import { registerExportRoutes } from './modules/export/index.js';
import { registerSyncRoutes } from './modules/sync/index.js';
import { registerPermissionsRoutes } from './modules/permissions/index.js';
import { registerMcpRoutes } from './modules/mcp/index.js';
import { registerMonitoringRoutes } from './modules/monitoring/index.js';
import { registerTestingRoutes } from './modules/testing/index.js';
import { registerSelfCheckRoutes } from './modules/selfcheck/index.js';
import { registerSkillsRoutes } from './modules/skills/index.js';
import { registerMemoryRoutes } from './modules/memory/index.js';
import { registerWorkflowRoutes } from './modules/workflows/index.js';
import { registerKnowledgeRoutes } from './modules/knowledge/index.js';
import { registerTerminalRoutes } from './modules/terminal/index.js';
import { registerApprovalRoutes } from './modules/approvals/index.js';
import { registerAuthRoutes } from './modules/auth/index.js';
import { registerRunRoutes, registerRunEventsRoutes, registerRunStreamRoutes } from './modules/runs/index.js';
import { closeAllMcpClients } from './lib/mcp-client.js';
import { generateLocalAuthToken, verifyAuthToken } from './lib/auth-token.js';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export async function buildApp(config?: BackendConfig) {
  const cfg = config || (await loadBackendConfig());

  const app = Fastify({
    logger: process.env.NODE_ENV === 'production'
      ? true  // 生产环境用默认 logger，不依赖 pino-pretty 导致打包后崩溃
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        },
    bodyLimit: 100 * 1024 * 1024, // 100MB，允许上传大背景图
  });

  await runMigrations(cfg);
  await initDb(cfg);

  // SEC-012: 迁移数据库中存储的明文 API Key 为加密格式（在注册路由前执行，避免解密时抛错）
  await migratePlaintextApiKeys(cfg);

  // 生成本地认证 token（启动时一次，仅内存，不落盘）
  generateLocalAuthToken();

  // P0-2: 全局 CSP 响应头 — 保护浏览器访问版本免受 XSS 注入加载远程脚本
  // 与 Electron 内 onHeadersReceived 注入的 CSP 保持一致
  app.addHook('onSend', async (_request, reply, payload) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: http://127.0.0.1:3000 http://localhost:3000 http://127.0.0.1:5173 http://localhost:5173 ws://127.0.0.1:3000 ws://localhost:3000 ws://127.0.0.1:5173 ws://localhost:5173",
      "media-src 'self' blob: data:",
      "frame-src 'self' https: http://localhost:* http://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // P0-1: CORS 严格白名单 — 反射任意 origin 等价于 *，恶意网页可远程接管本机服务
  // 仅允许配置的本地开发/生产前端 origin（可通过 ALLOWED_ORIGINS 环境变量覆盖，逗号分隔）
  const allowedOriginsSet = new Set(cfg.allowedOrigins);
  await app.register(cors, {
    origin: (origin, cb) => {
      // 同源请求无 Origin 头 → 允许；否则校验白名单
      // P1-2 修复：拒绝时用 cb(null, false)（不设置 CORS 头，浏览器阻止跨域读取），
      // 而非 cb(new Error(...))（会传入 next(error) → 全局错误处理器 → 500 + 错误日志洪泛）
      if (!origin || allowedOriginsSet.has(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Requested-With', 'Authorization'],
  });

  // P0-1: Host 头校验 — 防 DNS rebinding（恶意域名解析到 127.0.0.1 绕过同源）
  // P1-2 修复：Host 校验改为动态匹配 config.port，非 3000 端口启动不再全站 403
  const port = cfg.port;
  const hostPattern = new RegExp(`^127\\.0\\.0\\.1:${port}$|^localhost:${port}$`);
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host || '').toLowerCase();
    if (!hostPattern.test(host)) {
      return reply.code(403).send({ error: { message: 'Forbidden host' } });
    }
    // P0-3 修复：Swagger UI (/docs) 的 POST 请求豁免 CSRF 检查 —
    // 注释原意是 GET 豁免但代码只豁免了方法，导致 /docs 的 Try-it-out 全被 403
    if (request.url.startsWith('/docs') || request.url === '/docs/') return;
    // Oracle-5: CSRF 防护 — 所有状态变更请求必须带 X-Requested-With header
    // 浏览器表单提交无法附带自定义 header（需 CORS preflight），因此可有效防 CSRF
    const method = request.method.toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      const xrw = request.headers['x-requested-with'];
      if (!xrw || xrw !== 'XMLHttpRequest') {
        return reply.code(403).send({ error: { message: 'CSRF check failed: missing X-Requested-With header' } });
      }
    }
    // 本地认证 token 校验 — 敏感端点强制要求 Authorization: Bearer <token>
    // 受保护端点：terminal 执行、安全设置、provider key 读取/删除、导入导出全量、工作流执行、MCP 服务器测试、测试运行
    const sensitivePaths = [
      '/api/terminal/execute',
      '/api/settings/security',
      '/api/providers/',
      '/api/import/all',
      '/api/export/all',
      '/api/workflows/',
      '/api/mcp/servers/',
      '/api/testing/run',
    ];
    const isSensitive = sensitivePaths.some(p =>
      request.url === p || (p.endsWith('/') && request.url.startsWith(p))
    );
    if (isSensitive && method !== 'GET') {
      const authHeader = request.headers.authorization;
      if (!verifyAuthToken(authHeader)) {
        return reply.code(401).send({ error: { message: 'Unauthorized: invalid or missing auth token' } });
      }
    }
  });
  // Swagger UI 仅在非生产环境或显式启用时注册（SEC-020）
  const enableSwagger = process.env.NODE_ENV !== 'production' || cfg.enableSwagger === true;
  if (enableSwagger) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Aether API',
          version: '1.0.0',
          description: '个人 AI 指挥中心 API 文档',
        },
      },
    });
    try {
      await app.register(swaggerUi, { routePrefix: '/docs' });
    } catch (e) {
      console.warn('Swagger UI 注册失败（打包环境下正常）:', (e instanceof Error ? e.message : String(e)));
    }
  } else {
    // 生产环境下 /docs 返回 404
    app.get('/docs', async (_request, reply) => reply.code(404).send({ error: 'Not found' }));
    app.get('/docs/', async (_request, reply) => reply.code(404).send({ error: 'Not found' }));
    app.get('/docs/*', async (_request, reply) => reply.code(404).send({ error: 'Not found' }));
  }

  registerErrorHandler(app);

  // Register routes
  registerHealthRoutes(app);
  registerProviderRoutes(app, cfg);
  registerConversationRoutes(app, cfg);
  registerMediaRoutes(app, cfg);
  registerDocumentRoutes(app, cfg);
  registerDataRoutes(app, cfg);
  registerAgentRoutes(app, cfg);
  registerWorkspaceRoutes(app, cfg);
  registerBackgroundRoutes(app, cfg);
  registerToolboxRoutes(app, cfg);
  registerSearchRoutes(app, cfg);
  registerExportRoutes(app, cfg);
  registerSyncRoutes(app, cfg);
  registerPermissionsRoutes(app, cfg);
  registerMcpRoutes(app, cfg);
  registerMonitoringRoutes(app, cfg);
  registerTestingRoutes(app, cfg);
  registerSelfCheckRoutes(app, cfg);
  registerSkillsRoutes(app, cfg);
  registerMemoryRoutes(app, cfg);
  registerWorkflowRoutes(app, cfg);
  registerKnowledgeRoutes(app, cfg);
  registerTerminalRoutes(app, cfg);
  registerApprovalRoutes(app, cfg);
  registerAuthRoutes(app);
  registerRunRoutes(app, cfg);
  registerRunEventsRoutes(app, cfg);
  registerRunStreamRoutes(app, cfg);

  // 背景图片静态服务
  const bgDir = resolve(cfg.dataDir, 'backgrounds');
  if (!existsSync(bgDir)) mkdirSync(bgDir, { recursive: true });
  await app.register(fastifyStatic, { root: bgDir, prefix: '/data/backgrounds/', decorateReply: false });
  // 聊天图片静态服务（用户上传的图片存为文件后通过此路由访问）
  const chatImagesDir = resolve(cfg.dataDir, 'chat-images');
  if (!existsSync(chatImagesDir)) mkdirSync(chatImagesDir, { recursive: true });
  await app.register(fastifyStatic, { root: chatImagesDir, prefix: '/data/chat-images/', decorateReply: false });

  // P0-2: 改用 debounce dirty-flag，不再每个响应都同步全量导出
  app.addHook('onResponse', () => {
    markDirty(cfg);
  });

  // P2-5: app 关闭时同步落盘 + 清理所有 MCP 客户端连接，防子进程泄漏
  app.addHook('onClose', async () => {
    try { flushDbSync(cfg); } catch (_e: unknown) { /* ignore - intentional */ }
    try { await closeAllMcpClients(); } catch (_e: unknown) { /* ignore - intentional */ }
  });

  return app;
}