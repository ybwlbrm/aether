/**
 * Deleted Conversation Guard — AEX-P0-21
 *
 * 会话删除后，后台 run 的迟到事件不得再写入 activity_events。
 * 验证：注册表登记 / 检查 / 清除，以及持久化层命中 guard 时丢弃写入。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  markConversationDeleted,
  isConversationDeleted,
  unmarkConversationDeleted,
  clearDeletedConversations,
} from './deleted-conversation-guard.js';
import { createWriteRow } from './persistence.js';

/** 内存 DB stub：记录 insert 调用，满足 createWriteRow 的最小契约 */
function createMemoryDbStub() {
  const written: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        run: () => { written.push(row); },
      }),
    }),
  };
  return { db: db as never, written };
}

describe('deleted-conversation-guard（AEX-P0-21）', () => {
  beforeEach(() => clearDeletedConversations());
  afterEach(() => clearDeletedConversations());

  it('默认未删除：isConversationDeleted 返回 false', () => {
    assert.equal(isConversationDeleted('conv-a'), false);
  });

  it('登记后 isConversationDeleted 返回 true', () => {
    markConversationDeleted('conv-a');
    assert.equal(isConversationDeleted('conv-a'), true);
    // 其他会话不受影响
    assert.equal(isConversationDeleted('conv-b'), false);
  });

  it('unmark 解除登记', () => {
    markConversationDeleted('conv-a');
    unmarkConversationDeleted('conv-a');
    assert.equal(isConversationDeleted('conv-a'), false);
  });

  it('clear 清空全部登记', () => {
    markConversationDeleted('conv-a');
    markConversationDeleted('conv-b');
    clearDeletedConversations();
    assert.equal(isConversationDeleted('conv-a'), false);
    assert.equal(isConversationDeleted('conv-b'), false);
  });
});

describe('createWriteRow × deleted conversation guard（AEX-P0-21）', () => {
  beforeEach(() => clearDeletedConversations());
  afterEach(() => clearDeletedConversations());

  it('未删除会话：事件正常落库', () => {
    const { db, written } = createMemoryDbStub();
    const writeRow = createWriteRow(db, undefined);
    writeRow({
      id: 'evt-1', conversationId: 'conv-alive', taskId: 't', agentId: 'main',
      agentType: 'conversation', eventType: 'task.started', seq: 1,
      createdAt: new Date().toISOString(),
    });
    assert.equal(written.length, 1);
  });

  it('已删除会话：事件被丢弃（不落库、不抛错）', () => {
    const { db, written } = createMemoryDbStub();
    markConversationDeleted('conv-deleted');
    const writeRow = createWriteRow(db, undefined);
    writeRow({
      id: 'evt-2', conversationId: 'conv-deleted', taskId: 't', agentId: 'main',
      agentType: 'conversation', eventType: 'agent.message.delta', seq: 5,
      createdAt: new Date().toISOString(),
    });
    assert.equal(written.length, 0, '删除后事件必须被丢弃');
  });

  it('critical 事件同样被 guard 丢弃（删除优先于 critical 语义）', () => {
    const { db, written } = createMemoryDbStub();
    markConversationDeleted('conv-deleted');
    const writeRow = createWriteRow(db, undefined);
    writeRow({
      id: 'evt-3', conversationId: 'conv-deleted', taskId: 't', agentId: 'main',
      agentType: 'conversation', eventType: 'run.completed', seq: 9,
      createdAt: new Date().toISOString(), critical: true,
    });
    assert.equal(written.length, 0, '已删除会话的 critical 事件也必须丢弃（FK 失败不应打断发射链）');
  });
});
