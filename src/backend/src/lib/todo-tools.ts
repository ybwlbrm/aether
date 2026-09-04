/**
 * Todo 工具 — 参考 DeepSeek Harness `packages/core/todo`（todo_write 工具）。
 *
 * 能力：Agent 在任务执行中维护一张会话级待办清单（create -> update -> complete），
 * 结果以 JSON 返回给模型，同时把当前进度投射为易读文本。清单按 sessionId 隔离，
 * 供前端 ActivityStream / 任务卡展示（todo.started / todo.completed 事件链路）。
 */

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

/** 会话级待办清单（内存态；进程重启后由 activity_events 回放重建最简形态） */
const todoStore = new Map<string, TodoItem[]>();

export const todoTools = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: '管理当前任务的待办清单：可新增（append）、标记完成（complete）、更新（update）、列出（list）。任务开始时应先建立清单，每完成一项就标记 done。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['append', 'complete', 'update', 'list'], description: '操作类型' },
          text: { type: 'string', description: '新待办内容（append/update 时使用）' },
          id: { type: 'integer', description: '待办 id（complete/update 时使用）' },
          done: { type: 'boolean', description: 'complete 时置 true 标记完成' },
        },
        required: ['action'],
      },
    },
  },
];

export interface TodoExecCtx {
  sessionId: string;
}

export function executeTodoWrite(args: { action?: string; text?: string; id?: number; done?: boolean }, ctx: TodoExecCtx): { result: string; todos: TodoItem[] } {
  const list = todoStore.get(ctx.sessionId) ?? [];
  const action = args.action || 'list';
  let nextId = list.length > 0 ? Math.max(...list.map(t => t.id)) + 1 : 1;

  switch (action) {
    case 'append': {
      const item: TodoItem = { id: nextId, text: String(args.text ?? '').trim(), done: false };
      if (!item.text) {
        return { result: '错误: append 需要非空 text 参数', todos: list };
      }
      list.push(item);
      todoStore.set(ctx.sessionId, list);
      break;
    }
    case 'complete': {
      const target = list.find(t => t.id === args.id);
      if (!target) return { result: `错误: 找不到待办 id=${args.id}`, todos: list };
      target.done = true;
      todoStore.set(ctx.sessionId, list);
      break;
    }
    case 'update': {
      const target = list.find(t => t.id === args.id);
      if (!target) return { result: `错误: 找不到待办 id=${args.id}`, todos: list };
      if (typeof args.text === 'string' && args.text.trim()) target.text = args.text.trim();
      if (typeof args.done === 'boolean') target.done = args.done;
      todoStore.set(ctx.sessionId, list);
      break;
    }
    case 'list':
    default:
      break;
  }

  // 返回易读进度 + JSON 清单
  const doneCount = list.filter(t => t.done).length;
  const lines = list.map(t => `${t.id}. ${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n');
  const result = list.length === 0
    ? '待办清单为空。'
    : `待办进度: ${doneCount}/${list.length}\n${lines}`;
  return { result, todos: list };
}

/** 测试辅助：清空某会话清单 */
export function clearTodoStore(sessionId?: string): void {
  if (sessionId) todoStore.delete(sessionId);
  else todoStore.clear();
}