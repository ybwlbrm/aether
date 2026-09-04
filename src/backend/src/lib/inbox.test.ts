import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushDirective, drainDirectives, hasPendingDirectives, clearInbox } from './inbox.js';

describe('inbox 指令队列（steer/followup 语义）', () => {
  beforeEach(() => clearInbox());

  it('push 投递一条指令并分配 id', () => {
    const item = pushDirective('conv-a', '不要用 grep，直接读文件');
    assert.ok(item.id.startsWith('dir-'));
    assert.equal(item.text, '不要用 grep，直接读文件');
    assert.equal(hasPendingDirectives('conv-a'), true);
  });

  it('drain 取走全部待办并清空', () => {
    pushDirective('conv-a', '指令1');
    pushDirective('conv-a', '指令2');
    const all = drainDirectives('conv-a');
    assert.equal(all.length, 2);
    assert.equal(all[0].text, '指令1');
    assert.equal(hasPendingDirectives('conv-a'), false);
    // 再次 drain 为空
    assert.deepEqual(drainDirectives('conv-a'), []);
  });

  it('会话隔离：不同会话互不影响', () => {
    pushDirective('conv-a', 'A');
    pushDirective('conv-b', 'B');
    const a = drainDirectives('conv-a');
    assert.equal(a[0].text, 'A');
    assert.equal(hasPendingDirectives('conv-b'), true);
  });

  it('空文本指令不投递', () => {
    const item = pushDirective('conv-a', '   ');
    assert.equal(item.text, '');
    // drain 仍返回空（空文本不会入队）
    assert.deepEqual(drainDirectives('conv-a'), []);
  });

  it('clearInbox 指定会话清空', () => {
    pushDirective('conv-a', 'x');
    clearInbox('conv-a');
    assert.equal(hasPendingDirectives('conv-a'), false);
  });
});