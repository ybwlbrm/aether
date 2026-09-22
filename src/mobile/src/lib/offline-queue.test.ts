/**
 * OfflineQueueManager 单元测试（§69 offline queue）
 * 覆盖：enqueue / flush / retry / remove / getPending / 防重入 / 上限 / 超期
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OfflineQueueManager,
  type QueuedCommand,
  type QueueStorage,
} from './offline-queue.ts';

function memStorage(): QueueStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

function cmd(partial: Partial<QueuedCommand> & { id: string }): QueuedCommand {
  return {
    content: 'test',
    conversation_id: null,
    created_at: new Date().toISOString(),
    ...partial,
  };
}

test('enqueue: 加入队列并持久化', () => {
  const q = new OfflineQueueManager('q-test-1', memStorage());
  q.enqueue(cmd({ id: 'c1' }));
  assert.equal(q.count, 1);
  assert.deepEqual(q.getPending().map((c) => c.id), ['c1']);
});

test('enqueue: 同 id 幂等不重复', () => {
  const q = new OfflineQueueManager('q-test-2', memStorage());
  q.enqueue(cmd({ id: 'c1' }));
  q.enqueue(cmd({ id: 'c1' }));
  assert.equal(q.count, 1);
});

test('remove: 移除指定命令', () => {
  const q = new OfflineQueueManager('q-test-3', memStorage());
  q.enqueue(cmd({ id: 'c1' }));
  q.enqueue(cmd({ id: 'c2' }));
  q.remove('c1');
  assert.deepEqual(q.getPending().map((c) => c.id), ['c2']);
});

test('flush: sent 移除、retry 保留并计数、死信丢弃', async () => {
  const q = new OfflineQueueManager('q-test-4', memStorage());
  q.enqueue(cmd({ id: 'sent-cmd' }));
  q.enqueue(cmd({ id: 'retry-cmd' }));
  const sent = await q.flush(async (c) => (c.id === 'sent-cmd' ? 'sent' : 'retry'));
  assert.equal(sent, 1);
  const remaining = q.getPending();
  assert.deepEqual(remaining.map((c) => c.id), ['retry-cmd']);
  assert.equal(remaining[0].attempts, 1);
});

test('flush: 防重入 — 并发调用只执行一次', async () => {
  const q = new OfflineQueueManager('q-test-5', memStorage());
  q.enqueue(cmd({ id: 'c1' }));
  let calls = 0;
  const run = q.flush(async () => { calls++; return 'sent'; });
  const run2 = q.flush(async () => { calls++; return 'sent'; }); // 应被重入保护拦截
  await Promise.all([run, run2]);
  assert.equal(calls, 1); // 只有第一次真正执行
});

test('flush: 达到重试上限进入死信（丢弃）', async () => {
  const q = new OfflineQueueManager('q-test-6', memStorage());
  q.enqueue(cmd({ id: 'c1', attempts: 4 })); // 第 5 次失败 → 丢弃
  await q.flush(async () => 'failed');
  assert.equal(q.count, 0);
});

test('getPending: 超期命令自动过滤', () => {
  const q = new OfflineQueueManager('q-test-7', memStorage());
  q.enqueue(cmd({ id: 'old', created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }));
  assert.equal(q.count, 0);
});

test('onChange: 队列变化通知监听器', () => {
  const q = new OfflineQueueManager('q-test-8', memStorage());
  let notified = 0;
  q.onChange(() => { notified++; });
  q.enqueue(cmd({ id: 'c1' }));
  assert.ok(notified >= 1);
});
