/**
 * realtime logic tests (BE-RL-03: 重连死循环修复)
 *
 * 验证 setupRealtimeListener 在清理旧 channel 时不会触发重连调度：
 * - removeChannel(旧channel) 触发的 CLOSED 回调必须被忽略（该 channel 已非当前注册）
 * - 只有当前注册 channel 的 CLOSED/TIMED_OUT/CHANNEL_ERROR 才触发重连
 *
 * shouldScheduleReconnect 为纯函数（realtime-logic.ts），不依赖网络/Supabase。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldScheduleReconnect } from './realtime-logic.js';

describe('Realtime 重连死循环修复 (BE-RL-03)', () => {
  it('旧 channel 被 removeChannel 后的 CLOSED 回调 → 不应调度重连（死循环根因）', () => {
    // 场景：setupRealtimeListener 重连时 removeChannel(旧channel)，
    // 旧 channel 触发 CLOSED 回调，但此时它已不是当前注册的 channel
    const result = shouldScheduleReconnect('CLOSED', false);
    assert.equal(result, false, '已移除的旧 channel CLOSED 回调必须被忽略');
  });

  it('当前 channel 真正断线（CLOSED）→ 应调度重连', () => {
    const result = shouldScheduleReconnect('CLOSED', true);
    assert.equal(result, true, '当前注册 channel 的 CLOSED 必须触发重连');
  });

  it('当前 channel TIMED_OUT → 应调度重连', () => {
    assert.equal(shouldScheduleReconnect('TIMED_OUT', true), true);
  });

  it('当前 channel CHANNEL_ERROR → 应调度重连', () => {
    assert.equal(shouldScheduleReconnect('CHANNEL_ERROR', true), true);
  });

  it('SUBSCRIBED → 不调度重连', () => {
    assert.equal(shouldScheduleReconnect('SUBSCRIBED', true), false);
  });

  it('旧 channel 的 SUBSCRIBED 回调 → 不调度重连', () => {
    assert.equal(shouldScheduleReconnect('SUBSCRIBED', false), false);
  });

  it('旧 channel 的 TIMED_OUT 回调 → 不调度重连（同上死循环场景）', () => {
    assert.equal(shouldScheduleReconnect('TIMED_OUT', false), false);
  });
});
