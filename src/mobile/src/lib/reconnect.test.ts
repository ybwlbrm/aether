/**
 * ReconnectStateRebuilder 单元测试（AEX-P1-077 重连状态重建）
 *
 * 核心不变量：
 *   1. 只有「非 connected → connected」才触发一次重建（不重复触发、不重复订阅）
 *   2. 命令终态结算先于消息增量合并（终态优先）
 *   3. 单条命令/单个会话失败被隔离，不阻断其余恢复
 *   4. 同一引用只查询一次
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectStateRebuilder, type ReconnectCommandReference } from './reconnect.ts';
import { buildRemoteCommandSnapshot, type RemoteCommandSnapshot } from './remote-command.ts';

const COMPLETED: RemoteCommandSnapshot = buildRemoteCommandSnapshot({
  id: 'srv-1',
  status: 'completed',
  resultSummary: 'ok',
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('重连：非 connected → connected 触发且只触发一次重建', async () => {
  let rebuilds = 0;
  const r = new ReconnectStateRebuilder({
    fetchTerminal: async () => { rebuilds++; return null; },
  });
  r.registerCommand({ serverId: 'srv-1', clientCommandId: 'c1' }, () => {});

  r.noteSyncStatus('disconnected');
  assert.equal(rebuilds, 0, '断开时不做无用的重建');
  r.noteSyncStatus('connecting');
  assert.equal(rebuilds, 0, 'connecting 不算恢复');
  r.noteSyncStatus('connected');
  await r.whenIdle();
  assert.equal(rebuilds, 1);

  r.noteSyncStatus('connected'); // 持续在线 → 不得重复重建
  await r.whenIdle();
  assert.equal(rebuilds, 1, '持续 connected 不得重复触发重建');
  r.noteSyncStatus('degraded');
  await r.whenIdle();
  assert.equal(rebuilds, 1, 'degraded 不算恢复');
  r.noteSyncStatus('connected'); // degraded → connected 视为一次新的恢复
  await r.whenIdle();
  assert.equal(rebuilds, 2, 'degraded 后恢复连接触发新一轮重建');
});

test('重连：命令终态结算先于消息增量合并', async () => {
  const order: string[] = [];
  const r = new ReconnectStateRebuilder({
    fetchTerminal: async () => { order.push('fetch'); return COMPLETED; },
  });
  r.registerCommand({ serverId: 'srv-1', clientCommandId: 'c1' }, () => { order.push('settle'); });
  r.registerConversation('conv-1', async () => { order.push('merge'); });

  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  const report = await r.whenIdle();

  assert.deepEqual(order, ['fetch', 'settle', 'merge']);
  assert.equal(report.commandsSettled, 1);
  assert.equal(report.conversationsMerged, 1);
  assert.equal(report.errors, 0);
});

test('重连：无终态快照的命令不算结算，也不阻断其他命令', async () => {
  const settled: string[] = [];
  const r = new ReconnectStateRebuilder({
    fetchTerminal: async (ref) => (ref.serverId === 'srv-ok' ? COMPLETED : null),
  });
  r.registerCommand({ serverId: 'srv-ok', clientCommandId: 'a' }, () => { settled.push('a'); });
  r.registerCommand({ serverId: 'srv-none', clientCommandId: 'b' }, () => { settled.push('b'); });

  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  const report = await r.whenIdle();

  assert.deepEqual(settled, ['a']);
  assert.equal(report.commandsSettled, 1);
  assert.equal(report.errors, 0);
});

test('重连：命令查询抛错被隔离，会话合并仍执行', async () => {
  let merged = 0;
  const r = new ReconnectStateRebuilder({
    fetchTerminal: async () => { throw new Error('network down'); },
  });
  r.registerCommand({ serverId: 'srv-1', clientCommandId: 'c1' }, () => {
    throw new Error('不应被调用');
  });
  r.registerConversation('conv-1', async () => { merged++; });

  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  const report = await r.whenIdle();

  assert.equal(merged, 1, '命令查询失败不得阻断消息增量合并');
  assert.equal(report.errors, 1);
  assert.equal(report.commandsSettled, 0);
});

test('重连：会话合并抛错被隔离，其余会话继续', async () => {
  const r = new ReconnectStateRebuilder({ fetchTerminal: async () => null });
  const ok: string[] = [];
  r.registerConversation('bad', async () => { throw new Error('boom'); });
  r.registerConversation('good', async () => { ok.push('good'); });

  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  const report = await r.whenIdle();

  assert.deepEqual(ok, ['good']);
  assert.equal(report.errors, 1);
  assert.equal(report.conversationsMerged, 1);
});

test('重连：同一引用重复注册只查询一次，释放后不再恢复', async () => {
  const queries: string[] = [];
  const r = new ReconnectStateRebuilder({
    fetchTerminal: async (ref) => { queries.push(referenceKey(ref)); return COMPLETED; },
  });
  const ref: ReconnectCommandReference = { serverId: null, clientCommandId: 'c1' };
  const releaseFirst = r.registerCommand(ref, () => {});
  const releaseSecond = r.registerCommand(ref, () => {}); // 同引用二次订阅（组件重渲染）不应放大工作量

  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  await r.whenIdle();
  assert.deepEqual(queries, ['client:c1'], '同一引用只查询一次');

  releaseFirst();
  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  await r.whenIdle();
  assert.deepEqual(queries, ['client:c1', 'client:c1'], '仍有一个订阅者，恢复继续（再次重建仍结算）');

  releaseSecond();
  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  await r.whenIdle();
  assert.deepEqual(queries, ['client:c1', 'client:c1'], '全部释放后不再恢复');
});

test('重连：并发触发合并为同一轮重建（不重复 IO）', async () => {
  const gate = deferred<void>();
  let queries = 0;
  const r = new ReconnectStateRebuilder({
    fetchTerminal: async () => { queries++; await gate.promise; return COMPLETED; },
  });
  r.registerCommand({ serverId: 'srv-1', clientCommandId: 'c1' }, () => {});

  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected'); // 重建进行中再次掉线又恢复
  gate.resolve();
  await r.whenIdle();

  assert.equal(queries, 1, '并发触发必须合并为一轮');
});

test('重连：未注册任何目标时重建是安全的空操作', async () => {
  const r = new ReconnectStateRebuilder({ fetchTerminal: async () => COMPLETED });
  r.noteSyncStatus('connected');
  const report = await r.whenIdle();
  assert.deepEqual(report, { commandsSettled: 0, conversationsMerged: 0, errors: 0 });
});

test('重连：会话释放后不再参与重建', async () => {
  const merged: string[] = [];
  const r = new ReconnectStateRebuilder({ fetchTerminal: async () => null });
  const release = r.registerConversation('conv-1', async () => { merged.push('conv-1'); });
  release();

  r.noteSyncStatus('disconnected');
  r.noteSyncStatus('connected');
  await r.whenIdle();
  assert.deepEqual(merged, []);
});

function referenceKey(ref: ReconnectCommandReference): string {
  return ref.serverId ? `server:${ref.serverId}` : `client:${ref.clientCommandId}`;
}
