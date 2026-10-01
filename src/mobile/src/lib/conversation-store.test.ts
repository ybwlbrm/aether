/**
 * conversation-store 单元测试（T5 新建对话落库 / T9 App.tsx 接入基座）
 * 覆盖：insert payload 列完整性 / id 生成双路径 / 队列幂等 / 上限 / 超期 / flush 三态 / 防重入
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONVERSATION_TITLE,
  CONVERSATION_QUEUE_MAX_AGE_MS,
  CONVERSATION_QUEUE_MAX_RETRY,
  CONVERSATION_QUEUE_MAX_SIZE,
  PendingConversationQueue,
  buildConversationInsert,
  newConversationId,
  type ConversationQueueStorage,
  type PendingConversation,
} from './conversation-store.ts';

/** 内存 storage，模拟 localStorage（参考 offline-queue.test.ts） */
function memStorage(): ConversationQueueStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

function entry(partial: Partial<PendingConversation> & { id: string }): PendingConversation {
  return {
    title: DEFAULT_CONVERSATION_TITLE,
    created_at: new Date().toISOString(),
    attempts: 0,
    ...partial,
  };
}

// ============================================================
// 对话行构造
// ============================================================

test('buildConversationInsert: 返回全部 7 列且不含 user_id', () => {
  const payload = buildConversationInsert({ id: 'conv-1', deviceId: 'dev-1', now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(Object.keys(payload).sort(), [
    'created_at',
    'device_id',
    'id',
    'message_count',
    'model',
    'title',
    'updated_at',
  ]);
  assert.equal(payload.id, 'conv-1');
  assert.equal(payload.device_id, 'dev-1');
  assert.equal(payload.title, DEFAULT_CONVERSATION_TITLE);
  assert.equal(payload.model, null);
  assert.equal(payload.message_count, 0);
  assert.equal(payload.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(payload.updated_at, '2026-01-01T00:00:00.000Z');
  // user_id 交给 DB 触发器 trg_conversations_sync_user_id 填充
  assert.equal('user_id' in payload, false);
});

test('buildConversationInsert: 自定义 id/title/now 透传', () => {
  const payload = buildConversationInsert({
    id: 'conv-custom',
    deviceId: 'dev-x',
    title: '我的标题',
    now: '2026-02-03T04:05:06.000Z',
  });
  assert.equal(payload.id, 'conv-custom');
  assert.equal(payload.device_id, 'dev-x');
  assert.equal(payload.title, '我的标题');
  assert.equal(payload.created_at, '2026-02-03T04:05:06.000Z');
  assert.equal(payload.updated_at, '2026-02-03T04:05:06.000Z');
});

test('newConversationId: crypto.randomUUID 可用时返回其结果', () => {
  const id = newConversationId();
  const expected = crypto.randomUUID();
  assert.equal(id.length, expected.length);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('newConversationId: 缺失 crypto 时返回 v4 形状字符串', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    const id = newConversationId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

// ============================================================
// 离线待建对话队列
// ============================================================

test('enqueue: 同 id 幂等不重复', () => {
  const q = new PendingConversationQueue('conv-queue-1', memStorage());
  q.enqueue(entry({ id: 'c1' }));
  q.enqueue(entry({ id: 'c1' }));
  assert.equal(q.count, 1);
  assert.deepEqual(q.getPending().map((c) => c.id), ['c1']);
});

test('enqueue: 超过 CONVERSATION_QUEUE_MAX_SIZE 拒绝', () => {
  const q = new PendingConversationQueue('conv-queue-2', memStorage());
  for (let i = 0; i < CONVERSATION_QUEUE_MAX_SIZE; i++) {
    assert.equal(q.enqueue(entry({ id: `c${i}` })), true);
  }
  assert.equal(q.count, CONVERSATION_QUEUE_MAX_SIZE);
  assert.equal(q.enqueue(entry({ id: 'overflow' })), false);
  assert.equal(q.count, CONVERSATION_QUEUE_MAX_SIZE);
});

test('remove: 移除指定对话', () => {
  const q = new PendingConversationQueue('conv-queue-3', memStorage());
  q.enqueue(entry({ id: 'c1' }));
  q.enqueue(entry({ id: 'c2' }));
  q.remove('c1');
  assert.deepEqual(q.getPending().map((c) => c.id), ['c2']);
});

test('getPending: 超 24h 条目被过滤', () => {
  const q = new PendingConversationQueue('conv-queue-4', memStorage());
  q.enqueue(entry({ id: 'fresh' }));
  q.enqueue(entry({
    id: 'stale',
    created_at: new Date(Date.now() - CONVERSATION_QUEUE_MAX_AGE_MS - 1000).toISOString(),
  }));
  assert.deepEqual(q.getPending().map((c) => c.id), ['fresh']);
  assert.equal(q.count, 1);
});

test('flush: sent 移除 / retry 累积 attempts', async () => {
  const q = new PendingConversationQueue('conv-queue-5', memStorage());
  q.enqueue(entry({ id: 'sent-conv' }));
  q.enqueue(entry({ id: 'retry-conv' }));
  const sentCount = await q.flush(async (e) => (e.id === 'sent-conv' ? 'sent' : 'retry'));
  assert.equal(sentCount, 1);
  const remaining = q.getPending();
  assert.deepEqual(remaining.map((c) => c.id), ['retry-conv']);
  assert.equal(remaining[0].attempts, 1);
  // failed 保留原样
  const q2 = new PendingConversationQueue('conv-queue-5b', memStorage());
  q2.enqueue(entry({ id: 'keep-conv' }));
  await q2.flush(async () => 'failed');
  assert.deepEqual(q2.getPending().map((c) => c.id), ['keep-conv']);
});

test('flush: 达到重试上限丢弃', async () => {
  const q = new PendingConversationQueue('conv-queue-6', memStorage());
  q.enqueue(entry({ id: 'c1', attempts: CONVERSATION_QUEUE_MAX_RETRY - 1 }));
  await q.flush(async () => 'retry');
  assert.equal(q.count, 0);
});

test('flush: 重入保护 — 并发调用只执行一次 sender', async () => {
  const q = new PendingConversationQueue('conv-queue-7', memStorage());
  q.enqueue(entry({ id: 'c1' }));
  let calls = 0;
  const run = q.flush(async () => { calls++; return 'sent'; });
  const reentered = q.flush(async () => { calls++; return 'sent'; });
  const [, secondResult] = await Promise.all([run, reentered]);
  assert.equal(calls, 1);
  assert.equal(secondResult, 0);
  assert.equal(q.count, 0);
});