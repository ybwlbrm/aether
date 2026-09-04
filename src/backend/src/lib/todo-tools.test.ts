import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeTodoWrite, clearTodoStore } from './todo-tools.js';

describe('todo_write 工具', () => {
  beforeEach(() => clearTodoStore());

  it('append 新增待办并返回进度（session 隔离）', () => {
    const r1 = executeTodoWrite({ action: 'append', text: '阅读源码' }, { sessionId: 's1' });
    assert.ok(r1.result.includes('0/1'));
    assert.ok(r1.result.includes('[ ] 阅读源码'));
    assert.equal(r1.todos.length, 1);

    // 另一会话不受影响
    const r2 = executeTodoWrite({ action: 'list' }, { sessionId: 's2' });
    assert.ok(r2.result.includes('待办清单为空'));
  });

  it('complete 标记完成并更新进度', () => {
    executeTodoWrite({ action: 'append', text: '任务A' }, { sessionId: 's1' });
    executeTodoWrite({ action: 'append', text: '任务B' }, { sessionId: 's1' });
    const r = executeTodoWrite({ action: 'complete', id: 1 }, { sessionId: 's1' });
    assert.ok(r.result.includes('1/2'));
    assert.ok(r.todos.find(t => t.id === 1)?.done === true);
    assert.ok(r.todos.find(t => t.id === 2)?.done === false);
  });

  it('update 修改文案与状态', () => {
    executeTodoWrite({ action: 'append', text: '旧文案' }, { sessionId: 's1' });
    const r = executeTodoWrite({ action: 'update', id: 1, text: '新文案', done: true }, { sessionId: 's1' });
    assert.equal(r.todos[0].text, '新文案');
    assert.equal(r.todos[0].done, true);
  });

  it('complete 不存在的 id 返回错误文本', () => {
    const r = executeTodoWrite({ action: 'complete', id: 99 }, { sessionId: 's1' });
    assert.ok(r.result.includes('找不到待办'));
  });

  it('append 空文本返回错误', () => {
    const r = executeTodoWrite({ action: 'append', text: '   ' }, { sessionId: 's1' });
    assert.ok(r.result.includes('错误'));
  });
});