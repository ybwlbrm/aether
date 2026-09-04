import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildCompactionSystemMessage, compactRemovedHistory } from './compaction.js';

describe('compaction — 上下文压缩', () => {
  it('buildCompactionSystemMessage 生成 system 摘要消息', () => {
    const msg = buildCompactionSystemMessage('用户要求读取 a.ts 并总结');
    assert.equal(msg.role, 'system');
    assert.ok(msg.content.startsWith('[对话摘要]'));
    assert.ok(msg.content.includes('a.ts'));
  });

  it('空历史返回 null（无需压缩）', async () => {
    const result = await compactRemovedHistory({
      baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm',
      removedHistory: [], recentContext: '',
    });
    assert.equal(result, null);
  });

  it('provider 返回摘要文本', async () => {
    // 本地 mock provider：收到压缩请求，返回固定摘要
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '压缩后的历史摘要。' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await compactRemovedHistory({
        baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm',
        removedHistory: [{ role: 'user', content: '帮我看看 a.ts' }, { role: 'assistant', content: '已查看，结论是X' }],
        recentContext: '当前在分析文件',
      });
      assert.equal(result, '压缩后的历史摘要。');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('provider 失败时返回 null（回退直接丢弃，不阻塞）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await compactRemovedHistory({
        baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm',
        removedHistory: [{ role: 'user', content: 'x' }], recentContext: '',
      });
      assert.equal(result, null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('provider 不可达返回 null（静默回退）', async () => {
    const result = await compactRemovedHistory({
      baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm',
      removedHistory: [{ role: 'user', content: 'x' }], recentContext: '',
    });
    assert.equal(result, null);
  });
});