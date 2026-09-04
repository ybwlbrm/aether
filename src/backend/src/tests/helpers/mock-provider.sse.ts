/**
 * Mock SSE Provider — 为端点集成测试提供 OpenAI 兼容的 /v1/chat/completions 流式响应。
 *
 * 场景（按请求体最后一条 user 消息关键词路由）：
 * - 默认 / text：纯文本流 + [DONE]
 * - reasoning：thinking + 文本流
 * - tools：tool_calls 两段增量（验证组装）
 * - args-bad：工具调用且 arguments 非 JSON（验证 args 降级路径）
 * - empty：只发 [DONE]（验证 EMPTY_RESPONSE）
 * - truncated：流中途关闭不发 [DONE]（验证 STREAM_CLOSED）
 * - usage-trailing：尾部独立 usage chunk（验证延迟到位）
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encrypt } from '../../lib/crypto.js';
import type { BackendConfig } from '../../config/index.js';

export type MockScenario = 'text' | 'reasoning' | 'tools' | 'args-bad' | 'empty' | 'truncated' | 'usage-trailing';

let server: Server | null = null;

/** 启动 mock provider 服务器，返回 baseUrl */
export function startMockProvider(): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let reqJson: { messages?: Array<{ role?: string; content?: unknown }> } = {};
      try { reqJson = JSON.parse(body || '{}'); } catch { /* ignore */ }
      // 从最后一条 user 消息中探测场景
      const userMsgs = (reqJson.messages || []).filter((m) => m.role === 'user');
      const lastUser = userMsgs.length > 0 ? String(userMsgs[userMsgs.length - 1].content ?? '') : '';
      const scenario: MockScenario = detectScenario(lastUser);

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      writeScenarioStream(res, scenario);
    });
  });

  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}/v1`);
    });
  });
}

/** 按用户消息中的场景标记探测，默认 text */
function detectScenario(msg: string): MockScenario {
  if (msg.includes('[scenario:args-bad]')) return 'args-bad';
  if (msg.includes('[scenario:tools]')) return 'tools';
  if (msg.includes('[scenario:reasoning]')) return 'reasoning';
  if (msg.includes('[scenario:truncated]')) return 'truncated';
  if (msg.includes('[scenario:usage]')) return 'usage-trailing';
  if (msg.includes('[scenario:empty]')) return 'empty';
  return 'text';
}

function chunk(id: string, delta: Record<string, unknown>, finish: string | null = null, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
}

function writeScenarioStream(res: ServerResponse, scenario: MockScenario): void {
  const id = 'chatcmpl-mock-1';
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  switch (scenario) {
    case 'text':
      res.write(chunk(id, { content: '你好，' }));
      res.write(chunk(id, { content: '这是' }));
      res.write(chunk(id, { content: '测试回答。' }));
      res.write(chunk(id, {}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
      done();
      break;
    case 'reasoning':
      res.write(chunk(id, { reasoning_content: '让我' }));
      res.write(chunk(id, { reasoning_content: '思考一下' }));
      res.write(chunk(id, { content: '思考完毕，回答如下。' }));
      res.write(chunk(id, {}, 'stop', { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }));
      done();
      break;
    case 'tools':
      // 两段增量组装 arguments
      res.write(chunk(id, { tool_calls: [
        { index: 0, id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"' } },
        { index: 1, id: 'call_grep', type: 'function', function: { name: 'grep', arguments: '{"pattern":"' } },
      ] }));
      res.write(chunk(id, { tool_calls: [
        { index: 0, function: { arguments: 'a.txt"}' } },
        { index: 1, function: { arguments: 'hello"}' } },
      ] }));
      res.write(chunk(id, {}, 'tool_calls'));
      done();
      break;
    case 'args-bad':
      res.write(chunk(id, { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: 'read_file', arguments: '{not-json' } }] }));
      res.write(chunk(id, {}, 'tool_calls'));
      done();
      break;
    case 'usage-trailing':
      res.write(chunk(id, { content: '尾部' }));
      res.write(chunk(id, {}, null, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }));
      res.write(chunk(id, {}, 'stop'));
      done();
      break;
    case 'empty':
      done();
      break;
case 'truncated':
      res.write(chunk(id, { content: '只说了一半' }));
      // 不发 [DONE]，正常 end() — 模拟"EOF 无 [DONE]"断流（STREAM_CLOSED 语义），
      // 避免 destroy() 触发 fetchWithRetry 连接层退避重试导致测试超时
      res.end();
      break;
  }
}

/** 关闭 mock 服务器 */
export async function stopMockProvider(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
}

/** 直接以 drizzle schema 插入 provider 行（sql.js 内存库） */
export function registerMockProvider(db: { insert: (schema: unknown) => { values: (v: Record<string, unknown>) => { run: () => void } } }, providersSchema: unknown, encryptionKey: string, baseUrl: string): string {
  const id = 'mock-provider-' + Date.now();
  const now = new Date().toISOString();
  db.insert(providersSchema).values({
    id,
    name: 'mock',
    type: 'openai',
    apiKey: encrypt('mock-key', encryptionKey),
    baseUrl,
    models: JSON.stringify(['mock-model']),
    capabilities: JSON.stringify(['text']),
    isDefault: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

/** 测试专用 BackendConfig 构造（端口确定值，与 app.listen 共用，满足 Host 校验） */
export function makeTestConfig(dir: string): BackendConfig {
  const port = 42000 + (new Date().getTime() % 1000);
  return {
    port,
    host: '127.0.0.1',
    dataDir: dir,
    encryptionKey: 'test-encryption-key-000000000000000000000000',
    dbPath: `${dir}/pacc-test.db`,
    allowedDirs: [dir],
  } as unknown as BackendConfig;
}

/** 测试内 app.listen 用的端口规范 */
export async function listenTestApp(app: { listen: (opts: { port: number; host: string }) => Promise<unknown>, server: { address: () => unknown } }, cfg: BackendConfig): Promise<number> {
  await app.listen({ port: cfg.port, host: '127.0.0.1' as string });
  return cfg.port;
}
