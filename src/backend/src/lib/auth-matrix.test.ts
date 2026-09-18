/**
 * 鉴权矩阵测试（整改计划第 1 章，P0）— 默认拒绝 + 公开例外。
 *
 * 规则：
 * - 所有非 GET/HEAD 路由（conversations/agents/projects-exec/media/documents/toolbox/
 *   skills/runs/selfcheck/export/sync/backgrounds/knowledge/terminal/testing/mcp/
 *   permissions/providers/settings/approvals）缺 Bearer 一律 401
 * - 健康检查、静态资源、显式登录/本地 bootstrap（/api/auth/token）允许匿名
 * - 敏感读路径（export/all、sync/download、approvals）GET 也需 token
 * - CSRF 检查保留（状态变更缺 X-Requested-With → 403）
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { installAuthGuard, PUBLIC_GET_PATHS, PUBLIC_STATIC_PREFIXES, SENSITIVE_READ_PATHS } from './auth-guard.js';
import { generateLocalAuthToken } from './auth-token.js';
import { registerErrorHandler } from '../plugins/error-handler.js';

let app: FastifyInstance;
let token: string;

/** 所有非 GET/HEAD 写路由分类（对照整改文档第 1 章清单） */
const WRITE_ROUTES: Array<{ method: 'POST' | 'PUT' | 'DELETE' | 'PATCH'; url: string }> = [
  // conversations
  { method: 'POST', url: '/api/conversations' },
  { method: 'POST', url: '/api/conversations/conv-1/messages' },
  { method: 'PUT', url: '/api/conversations/conv-1' },
  { method: 'DELETE', url: '/api/conversations/conv-1' },
  { method: 'POST', url: '/api/conversations/conv-1/cancel' },
  { method: 'POST', url: '/api/conversations/conv-1/directive' },
  // agents
  { method: 'POST', url: '/api/agents/orchestrate' },
  { method: 'POST', url: '/api/agents/cancel' },
  { method: 'POST', url: '/api/agents/sisyphus' },
  { method: 'PUT', url: '/api/agents/config/agent-1' },
  // projects/exec
  { method: 'POST', url: '/api/projects/exec' },
  { method: 'POST', url: '/api/projects' },
  { method: 'PUT', url: '/api/projects/proj-1' },
  { method: 'DELETE', url: '/api/projects/proj-1' },
  // media
  { method: 'POST', url: '/api/media/generate' },
  { method: 'PUT', url: '/api/media/media-1' },
  { method: 'DELETE', url: '/api/media/media-1' },
  { method: 'POST', url: '/api/media/batch-delete' },
  // documents
  { method: 'POST', url: '/api/documents/ppt' },
  { method: 'POST', url: '/api/documents/doc' },
  { method: 'PUT', url: '/api/documents/doc-1' },
  { method: 'DELETE', url: '/api/documents/doc-1' },
  // toolbox
  { method: 'POST', url: '/api/toolbox/convert' },
  { method: 'POST', url: '/api/toolbox/pdf-operate' },
  { method: 'POST', url: '/api/toolbox/utility' },
  { method: 'POST', url: '/api/toolbox/pdf-read' },
  { method: 'POST', url: '/api/toolbox/pdf-to-docx' },
  // skills
  { method: 'POST', url: '/api/skills/skill-1/install' },
  { method: 'DELETE', url: '/api/skills/skill-1' },
  { method: 'PUT', url: '/api/skills/skill-1/toggle' },
  // runs
  { method: 'POST', url: '/api/runs' },
  { method: 'POST', url: '/api/runs/recover' },
  { method: 'POST', url: '/api/runs/run-1/start' },
  { method: 'POST', url: '/api/runs/run-1/cancel' },
  // selfcheck
  { method: 'POST', url: '/api/selfcheck/verify' },
  { method: 'POST', url: '/api/selfcheck/correct' },
  // export
  { method: 'POST', url: '/api/export' },
  // sync
  { method: 'POST', url: '/api/sync/config' },
  { method: 'POST', url: '/api/sync/upload' },
  { method: 'POST', url: '/api/sync/now' },
  { method: 'POST', url: '/api/sync/disconnect' },
  { method: 'POST', url: '/api/sync/delete-conversation' },
  // backgrounds
  { method: 'POST', url: '/api/backgrounds/upload' },
  { method: 'POST', url: '/api/backgrounds/source' },
  { method: 'POST', url: '/api/backgrounds/interval' },
  { method: 'POST', url: '/api/backgrounds/clear' },
  // knowledge
  { method: 'POST', url: '/api/knowledge/wiki' },
  { method: 'PUT', url: '/api/knowledge/wiki/wiki-1' },
  { method: 'DELETE', url: '/api/knowledge/wiki/wiki-1' },
  { method: 'POST', url: '/api/knowledge/templates' },
  // terminal / testing / mcp / permissions / providers / settings / approvals
  { method: 'POST', url: '/api/terminal/execute' },
  { method: 'POST', url: '/api/testing/run' },
  { method: 'POST', url: '/api/mcp/servers' },
  { method: 'PUT', url: '/api/mcp/servers/srv-1' },
  { method: 'DELETE', url: '/api/mcp/servers/srv-1' },
  { method: 'POST', url: '/api/mcp/servers/srv-1/test' },
  { method: 'POST', url: '/api/mcp/import' },
  { method: 'POST', url: '/api/permissions' },
  { method: 'POST', url: '/api/providers' },
  { method: 'PUT', url: '/api/providers/prov-1' },
  { method: 'DELETE', url: '/api/providers/prov-1' },
  { method: 'POST', url: '/api/providers/prov-1/apikey' },
  { method: 'POST', url: '/api/providers/prov-1/test' },
  { method: 'POST', url: '/api/settings' },
  { method: 'POST', url: '/api/settings/security' },
  { method: 'POST', url: '/api/settings/default-providers' },
  { method: 'POST', url: '/api/import/all' },
  { method: 'POST', url: '/api/approvals/apr-1/decide' },
];

/** 允许匿名的公开端点（健康检查 / 本地 bootstrap） */
const ANON_GET_ROUTES = [
  '/api/health',
  '/api/auth/token',
];

/** 敏感读路径：GET 也需 token */
const SENSITIVE_READ_GET_ROUTES = SENSITIVE_READ_PATHS;

before(async () => {
  token = generateLocalAuthToken();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  installAuthGuard(app);

  // 注册一个匿名 GET 路由代表健康检查（真实 /api/health 由 health 模块提供）
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/auth/token', async () => ({ token }));
  app.get('/api/export/all', async () => ({ data: [] }));
  app.get('/api/sync/download', async () => ({ data: [] }));
  app.get('/api/sync/config', async () => ({ configured: true }));
  app.get('/api/approvals', async () => ({ approvals: [] }));
  // 任意公开读路由（非敏感 GET 应匿名可访问）
  app.get('/api/conversations', async () => ({ conversations: [] }));
  // 静态资源前缀
  app.get('/data/backgrounds/test.png', async () => 'png');
  // 任意写路由（用于"带 token 通过"用例；真实路由由各模块注册）
  app.post('/api/conversations', async () => ({ id: 'conv-1' }));
});

after(async () => {
  if (app) await app.close();
});

type TestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

function inject(method: TestMethod, url: string, withToken = false): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
  if (withToken) headers['Authorization'] = `Bearer ${token}`;
  return app.inject({ method, url, headers });
}

describe('鉴权矩阵 — 默认拒绝（P0 整改第 1 章）', () => {
  it('全部非 GET/HEAD 路由缺 Bearer → 401（含 conversations/agents/exec/media/documents/toolbox/skills/runs/selfcheck/export/sync/backgrounds/knowledge）', async () => {
    for (const r of WRITE_ROUTES) {
      const res = await inject(r.method, r.url);
      assert.equal(res.statusCode, 401, `${r.method} ${r.url} 缺 Bearer 应 401，实际 ${res.statusCode} body=${res.body}`);
    }
  });

  it('全部非 GET/HEAD 路由带有效 Bearer → 通过（非 401/403）', async () => {
    for (const r of WRITE_ROUTES) {
      const res = await inject(r.method, r.url, true);
      assert.ok(res.statusCode !== 401 && res.statusCode !== 403, `${r.method} ${r.url} 带 Bearer 不应 401/403，实际 ${res.statusCode}`);
    }
  });

  it('健康检查 / 本地 bootstrap 允许匿名（GET 200）', async () => {
    for (const url of ANON_GET_ROUTES) {
      const res = await inject('GET', url);
      assert.equal(res.statusCode, 200, `GET ${url} 匿名应 200，实际 ${res.statusCode}`);
    }
  });

  it('敏感读路径（export/all、sync/download、approvals）GET 缺 token → 401', async () => {
    for (const url of SENSITIVE_READ_GET_ROUTES) {
      const res = await inject('GET', url);
      assert.equal(res.statusCode, 401, `GET ${url} 缺 Bearer 应 401，实际 ${res.statusCode}`);
    }
  });

  it('敏感读路径带 token → 通过', async () => {
    for (const url of SENSITIVE_READ_GET_ROUTES) {
      const res = await inject('GET', url, true);
      assert.equal(res.statusCode, 200, `GET ${url} 带 Bearer 应 200，实际 ${res.statusCode}`);
    }
  });

  it('静态资源前缀允许匿名（/data/backgrounds/...）', async () => {
    for (const prefix of PUBLIC_STATIC_PREFIXES) {
      const res = await inject('GET', `${prefix}some-file.png`);
      assert.ok(res.statusCode !== 401, `GET ${prefix}some-file.png 匿名不应 401，实际 ${res.statusCode}`);
    }
  });

  it('普通非敏感 GET 允许匿名', async () => {
    const res = await inject('GET', '/api/conversations');
    assert.equal(res.statusCode, 200, 'GET /api/conversations 匿名应 200（普通读）');
  });

  it('CSRF 检查保留：写请求缺 X-Requested-With → 403（即使带 token）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { Authorization: `Bearer ${token}` }, // 无 X-Requested-With
    });
    assert.equal(res.statusCode, 403, '缺 X-Requested-With 的 POST 应 403');
  });

  it('CSRF 检查保留：GET 不受影响（无 X-Requested-With 也可读）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200, 'GET 无需 X-Requested-With');
  });

  it('无效 token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Authorization: 'Bearer wrong-token-1234567890abcdef' },
    });
    assert.equal(res.statusCode, 401, '错误 Bearer 应 401');
  });
});
