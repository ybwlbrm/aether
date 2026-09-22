/**
 * ChannelStatusRegistry 单元测试（§21 Realtime 全局状态聚合）
 * 覆盖：per-channel 独立状态 / 聚合 connected / degraded / connecting / disconnected
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelStatusRegistry, type ChannelName, type ChannelStatus } from './channel-registry.ts';

test('aggregate: 全部 connected → connected', () => {
  const s = { messages: 'connected', conversations: 'connected', commands: 'connected' } as Record<ChannelName, ChannelStatus>;
  assert.equal(ChannelStatusRegistry.aggregate(s), 'connected');
});

test('aggregate: 部分 connected → degraded（不再被单 channel 覆盖成 disconnected）', () => {
  const s = { messages: 'connected', conversations: 'disconnected', commands: 'connected' } as Record<ChannelName, ChannelStatus>;
  assert.equal(ChannelStatusRegistry.aggregate(s), 'degraded');
});

test('aggregate: 无 connected 但有 connecting → connecting', () => {
  const s = { messages: 'connecting', conversations: 'disconnected', commands: 'disconnected' } as Record<ChannelName, ChannelStatus>;
  assert.equal(ChannelStatusRegistry.aggregate(s), 'connecting');
});

test('aggregate: 全部 disconnected → disconnected', () => {
  const s = { messages: 'disconnected', conversations: 'disconnected', commands: 'disconnected' } as Record<ChannelName, ChannelStatus>;
  assert.equal(ChannelStatusRegistry.aggregate(s), 'disconnected');
});

test('实例: 单 channel 断开不影响其他 channel（核心修复）', () => {
  const r = new ChannelStatusRegistry();
  r.setChannelStatus('messages', 'connected');
  r.setChannelStatus('conversations', 'connected');
  r.setChannelStatus('commands', 'connected');
  assert.equal(r.getState().status, 'connected');

  // messages 断开 → degraded（而非全局 disconnected）
  r.setChannelStatus('messages', 'disconnected');
  assert.equal(r.getState().status, 'degraded');
  assert.equal(r.getChannelStatus('messages'), 'disconnected');
  assert.equal(r.getChannelStatus('conversations'), 'connected');
});

test('markSynced 更新 lastSyncAt', () => {
  const r = new ChannelStatusRegistry();
  assert.equal(r.getState().lastSyncAt, null);
  r.markSynced();
  assert.ok(r.getState().lastSyncAt);
});

test('trackPending/settlePending 维护 pendingCount', () => {
  const r = new ChannelStatusRegistry();
  r.trackPending('cmd-1');
  r.trackPending('cmd-2');
  assert.equal(r.getState().pendingCount, 2);
  r.settlePending('cmd-1');
  assert.equal(r.getState().pendingCount, 1);
});

test('onChange 首次订阅立即收到当前状态', () => {
  const r = new ChannelStatusRegistry();
  let got: unknown = null;
  r.onChange((s) => { got = s; });
  assert.ok(got);
  assert.equal((got as { status: string }).status, 'disconnected');
});

test('reset 清空全部状态', () => {
  const r = new ChannelStatusRegistry();
  r.setChannelStatus('messages', 'connected');
  r.trackPending('x');
  r.markSynced();
  r.reset();
  const s = r.getState();
  assert.equal(s.status, 'disconnected');
  assert.equal(s.pendingCount, 0);
  assert.equal(s.lastSyncAt, null);
});
