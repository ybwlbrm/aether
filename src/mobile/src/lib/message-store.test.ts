/**
 * message-store 单元测试（§69 merge 部分）
 * 覆盖：insert / update / duplicate / ordering / streaming 不重复 / 乐观替换 / 完成判断
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeMessages,
  upsertMessage,
  replaceOptimistic,
  hasAssistantAfter,
  compareMessages,
  advanceMessageCursor,
  type ChatMessage,
} from './message-store.ts';

function msg(partial: Partial<ChatMessage> & { id: string; created_at: string }): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: null, tool_results: null, ...partial };
}

test('merge: 新消息插入并按 created_at 排序', () => {
  const a = msg({ id: 'a', created_at: '2026-01-01T00:00:00Z', content: 'A' });
  const b = msg({ id: 'b', created_at: '2026-01-01T00:00:01Z', content: 'B' });
  const c = msg({ id: 'c', created_at: '2026-01-01T00:00:00Z', content: 'C' });
  const merged = mergeMessages([b], [a, c]);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'c', 'b']); // 同秒 a<c<... 
  // a/c 同为 00:00:00，按 id 升序 a<c；b 为 00:00:01 最后
});

test('merge: 已存在 id → 覆盖内容不产生重复（流式 UPDATE）', () => {
  const v1 = msg({ id: 'x', created_at: '2026-01-01T00:00:00Z', content: '半句' });
  const v2 = msg({ id: 'x', created_at: '2026-01-01T00:00:00Z', content: '半句续写' });
  const r1 = mergeMessages([], [v1]);
  const r2 = mergeMessages(r1, [v2]);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].content, '半句续写');
});

test('merge: 多条来源同时到达（polling + realtime）不重复', () => {
  const m1 = msg({ id: 'm1', created_at: '2026-01-01T00:00:00Z', content: '1' });
  const m2 = msg({ id: 'm2', created_at: '2026-01-01T00:00:01Z', content: '2' });
  const m2u = msg({ id: 'm2', created_at: '2026-01-01T00:00:01Z', content: '2-updated' });
  const merged = mergeMessages([m1, m2], [m2u, m1]); // 重复 m1 + 更新 m2
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((m) => m.content), ['1', '2-updated']);
});

test('merge: 空输入返回空，不崩溃', () => {
  assert.deepEqual(mergeMessages([], []), []);
  assert.deepEqual(mergeMessages([msg({ id: 'a', created_at: '2026-01-01T00:00:00Z' })], []).length, 1);
});

test('upsert: 单条存在则原位覆盖', () => {
  const a = msg({ id: 'a', created_at: '2026-01-01T00:00:00Z', content: 'v1' });
  const a2 = msg({ id: 'a', created_at: '2026-01-01T00:00:00Z', content: 'v2' });
  const b = msg({ id: 'b', created_at: '2026-01-01T00:00:01Z', content: 'B' });
  let list = upsertMessage([a, b], a2);
  assert.equal(list.length, 2);
  assert.equal(list[0].content, 'v2');
  list = upsertMessage(list, msg({ id: 'c', created_at: '2026-01-01T00:00:02Z', content: 'C' }));
  assert.equal(list.length, 3);
});

test('replaceOptimistic: 真实消息替换 temp- 占位', () => {
  const temp = msg({ id: 'temp-abc', role: 'user', created_at: '2026-01-01T00:00:00Z', content: 'hi' });
  const real = msg({ id: 'real-uuid', role: 'user', created_at: '2026-01-01T00:00:00Z', content: 'hi' });
  const list = replaceOptimistic([temp], real);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'real-uuid');
});

test('hasAssistantAfter: 只看本次请求之后的 assistant（历史 assistant 不误判）', () => {
  const oldAssistant = msg({ id: 'old', role: 'assistant', created_at: '2026-01-01T00:00:00Z' });
  const userMsg = msg({ id: 'u', role: 'user', created_at: '2026-01-01T00:01:00Z' });
  // 只有历史 assistant（早于用户消息）→ 不应判定完成
  assert.equal(hasAssistantAfter([oldAssistant, userMsg], '2026-01-01T00:01:00Z'), false);
  // 出现晚于用户消息的 assistant → 判定完成
  const newAssistant = msg({ id: 'new', role: 'assistant', created_at: '2026-01-01T00:02:00Z' });
  assert.equal(hasAssistantAfter([oldAssistant, userMsg, newAssistant], '2026-01-01T00:01:00Z'), true);
});

test('compareMessages: 同 created_at 按 id 升序（确定性）', () => {
  const z = msg({ id: 'z', created_at: '2026-01-01T00:00:00Z' });
  const a = msg({ id: 'a', created_at: '2026-01-01T00:00:00Z' });
  assert.ok(compareMessages(a, z) < 0);
  assert.ok(compareMessages(z, a) > 0);
  assert.equal(compareMessages(a, a), 0);
});

test('advanceMessageCursor: 游标取最大 created_at 并单调不回退', () => {
  const t1 = '2026-01-01T00:00:01Z';
  const t2 = '2026-01-01T00:00:05Z';
  // 输入乱序也取最大
  assert.equal(
    advanceMessageCursor(null, [msg({ id: 'b', created_at: t2 }), msg({ id: 'a', created_at: t1 })]),
    t2,
  );
  // 旧消息（乱序到达 / 迟到）不得让游标回退，否则增量拉取会重复拉大量历史
  assert.equal(advanceMessageCursor(t2, [msg({ id: 'old', created_at: t1 })]), t2);
  // 同秒消息也推进不了游标但不得回退
  assert.equal(advanceMessageCursor(t2, [msg({ id: 'same', created_at: t2 })]), t2);
  // 空输入保持原值；空输入且无游标 → null（走全量）
  assert.equal(advanceMessageCursor(t1, []), t1);
  assert.equal(advanceMessageCursor(null, []), null);
  // 非法时间戳被忽略
  assert.equal(advanceMessageCursor(null, [msg({ id: 'bad', created_at: 'not-a-date' })]), null);
});
