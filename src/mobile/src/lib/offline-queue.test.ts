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

test('flush: 达到重试上限进入 dead_letter（不丢弃，getPending 不含它）', async () => {
  const q = new OfflineQueueManager('q-test-6', memStorage());
  q.enqueue(cmd({ id: 'c1', attempts: 4 })); // 第 5 次失败 → dead_letter
  await q.flush(async () => 'failed');
  assert.equal(q.count, 0);
  assert.deepEqual(q.getDeadLetter().map((c) => c.id), ['c1']);
});

test('flush 重试耗尽后进入 dead_letter，不消失', async () => {
  const q = new OfflineQueueManager('q-test-dl-1', memStorage());
  q.enqueue(cmd({ id: 'retry-cmd' }));
  for (let i = 0; i < 6; i++) await q.flush(async () => 'retry');

  // 永久失败的命令必须留在存储里，只是被标记为 dead_letter
  assert.equal(q.count, 0, 'dead_letter 不应再作为可重试命令出现');
  const dead = q.getDeadLetter();
  assert.equal(dead.length, 1, '永久失败命令不得消失');
  assert.equal(dead[0].id, 'retry-cmd');
  assert.equal(dead[0].status, 'dead_letter');
  assert.equal(dead[0].attempts, 5);
  assert.ok(dead[0].dead_lettered_at, 'dead_letter 必须记录时间戳');
  assert.equal(q.deadLetterCount, 1);
});

test('dead_letter 跨实例持久化（刷新页面仍在）', () => {
  const storage = memStorage();
  const first = new OfflineQueueManager('q-test-dl-2', storage);
  first.enqueue(cmd({ id: 'c1', attempts: 4 }));
  const second = new OfflineQueueManager('q-test-dl-2', storage);
  // 用 sender 触发一次耗尽
  return second.flush(async () => 'failed').then(() => {
    const third = new OfflineQueueManager('q-test-dl-2', storage);
    assert.deepEqual(third.getDeadLetter().map((c) => c.id), ['c1']);
    assert.equal(third.count, 0);
  });
});

test('retryAll 将 dead_letter 重置 attempts 并重新入队', async () => {
  const q = new OfflineQueueManager('q-test-dl-3', memStorage());
  q.enqueue(cmd({ id: 'c1', attempts: 4 }));
  await q.flush(async () => 'failed');
  assert.equal(q.getDeadLetter().length, 1);

  const revived = q.retryAll();
  assert.equal(revived, 1);
  assert.equal(q.deadLetterCount, 0, 'retryAll 后死信清空');
  assert.deepEqual(q.getPending().map((c) => c.id), ['c1']);
  assert.equal(q.getPending()[0].attempts, 0, 'attempts 必须重置，否则立刻再次耗尽');
  assert.equal(q.getPending()[0].status, 'pending');
  // 刷新 created_at：过期命令被 retryAll 复活后必须仍可发送，不得因超期再次静默消失
  assert.ok(Date.now() - new Date(q.getPending()[0].created_at).getTime() < 1000);

  // 重新入队的命令可以真正发出去
  const sent = await q.flush(async () => 'sent');
  assert.equal(sent, 1);
  assert.equal(q.count, 0);
  assert.equal(q.deadLetterCount, 0);
});

test('dead_letter 不受 24h 超期规则影响：上一会话的陈旧死信仍可见且可复活', () => {
  const storage = memStorage();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  // 模拟上一会话已落盘的死信（用户可能几天后才重新打开 App）
  storage.setItem('q-test-dl-4', JSON.stringify([
    { id: 'old', content: 'test', conversation_id: null, created_at: twoDaysAgo, attempts: 5, status: 'dead_letter', dead_lettered_at: twoDaysAgo },
  ]));

  const q = new OfflineQueueManager('q-test-dl-4', storage);
  assert.deepEqual(q.getDeadLetter().map((c) => c.id), ['old'], '死信不得因超期被静默丢弃');
  assert.equal(q.count, 0);

  assert.equal(q.retryAll(), 1);
  assert.deepEqual(q.getPending().map((c) => c.id), ['old'], '复活后不得立刻被超期过滤吞掉');
  assert.equal(q.getPending()[0].attempts, 0);
});

test('remove 可清除单条 dead_letter（用户主动丢弃）', async () => {
  const q = new OfflineQueueManager('q-test-dl-5', memStorage());
  q.enqueue(cmd({ id: 'c1', attempts: 4 }));
  q.enqueue(cmd({ id: 'c2', attempts: 4 }));
  await q.flush(async () => 'failed');
  assert.equal(q.deadLetterCount, 2);

  q.remove('c1');
  assert.deepEqual(q.getDeadLetter().map((c) => c.id), ['c2']);
  assert.equal(q.has('c1'), false);
});

test('has 覆盖 pending 与 dead_letter 两种状态', async () => {
  const q = new OfflineQueueManager('q-test-dl-6', memStorage());
  q.enqueue(cmd({ id: 'pending-cmd' }));
  q.enqueue(cmd({ id: 'dead-cmd', attempts: 4 }));
  assert.equal(q.has('pending-cmd'), true);
  await q.flush(async (c) => (c.id === 'pending-cmd' ? 'sent' : 'failed'));
  assert.equal(q.has('pending-cmd'), false);
  assert.equal(q.has('dead-cmd'), true);
});

test('enqueue 同 id 命中 dead_letter 时复活为 pending', async () => {
  const q = new OfflineQueueManager('q-test-dl-7', memStorage());
  q.enqueue(cmd({ id: 'c1', attempts: 4 }));
  await q.flush(async () => 'failed');
  assert.equal(q.deadLetterCount, 1);

  assert.equal(q.enqueue(cmd({ id: 'c1', content: 'again' })), true);
  assert.equal(q.deadLetterCount, 0);
  assert.deepEqual(q.getPending().map((c) => c.id), ['c1']);
  assert.equal(q.getPending()[0].attempts, 0);
  assert.equal(q.getPending()[0].content, 'again');
});

test('flush 保留 dead_letter，不被后续 flush 覆盖清空', async () => {
  const q = new OfflineQueueManager('q-test-dl-8', memStorage());
  q.enqueue(cmd({ id: 'dead', attempts: 4 }));
  await q.flush(async () => 'failed');
  q.enqueue(cmd({ id: 'live' }));
  await q.flush(async () => 'failed');

  assert.deepEqual(q.getDeadLetter().map((c) => c.id), ['dead']);
  assert.deepEqual(q.getPending().map((c) => c.id), ['live']);
});

test('flush 记录中间状态 retrying / failed', async () => {
  const q = new OfflineQueueManager('q-test-dl-9', memStorage());
  q.enqueue(cmd({ id: 'r' }));
  q.enqueue(cmd({ id: 'f' }));
  await q.flush(async (c) => (c.id === 'r' ? 'retry' : 'failed'));
  const byId = new Map(q.getPending().map((c) => [c.id, c]));
  assert.equal(byId.get('r')?.status, 'retrying');
  assert.equal(byId.get('f')?.status, 'failed');
});

test('onChange: 快照同时给出 pending 与 deadLetter', async () => {
  const q = new OfflineQueueManager('q-test-dl-10', memStorage());
  const snapshots: { pending: number; deadLetter: number }[] = [];
  q.onChange((s) => { snapshots.push({ pending: s.pending.length, deadLetter: s.deadLetter.length }); });
  q.enqueue(cmd({ id: 'c1', attempts: 4 }));
  await q.flush(async () => 'failed');

  const last = snapshots[snapshots.length - 1];
  assert.equal(last.pending, 0);
  assert.equal(last.deadLetter, 1);
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
