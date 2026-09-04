import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryEventBus, createEventBus, rowToEnvelope } from './event-bus.js';

describe('EventBus (memory)', () => {
  it('emit 自动分配会话内单调递增 seq', () => {
    const sent: string[] = [];
    const bus = createMemoryEventBus((event, data) => { sent.push(`${event}:${data}`); });
    const e1 = bus.emit('conv-A', 'task.started', { taskId: 'task-1', agentId: 'main', agentType: 'conversation' });
    const e2 = bus.emit('conv-A', 'tool.started', { taskId: 'task-1', agentId: 'main', content: 'read_file' });
    const e3 = bus.emit('conv-B', 'agent.status', { content: 'analyzing' });

    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e3.seq, 1); // 不同会话独立计数
    assert.ok(e1.eventId);
    assert.equal(e1.sessionId, 'conv-A');
    assert.equal(e1.eventType, 'task.started');
    assert.equal(sent.length, 3);
    assert.ok(sent[1].startsWith('tool.started:'));
  });

  it('listEvents 按 seq 升序返回', () => {
    const bus = createMemoryEventBus();
    bus.emit('conv-C', 'tool.started', { content: 'a' });
    bus.emit('conv-C', 'agent.status', { content: 'b' });
    bus.emit('conv-C', 'tool.completed', { content: 'c', status: 'completed' });
    const events = bus.listEvents('conv-C');
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3]);
  });

  it('listEventsAfter 只返回指定 seq 之后的事件', () => {
    const bus = createMemoryEventBus();
    bus.emit('conv-D', 'tool.started', { content: 'a' });
    bus.emit('conv-D', 'agent.status', { content: 'b' });
    bus.emit('conv-D', 'tool.completed', { content: 'c' });
    const after = bus.listEventsAfter('conv-D', 1);
    assert.deepEqual(after.map(e => e.seq), [2, 3]);
  });

  it('同会话并发 emit 不产生重复 seq（串行调度）', async () => {
    const bus = createMemoryEventBus();
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => bus.emit('conv-E', 'agent.status', { content: `c${i}` }))));
    const seqs = bus.listEvents('conv-E').map(e => e.seq);
    assert.equal(new Set(seqs).size, 20);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  it('会话 seq 跨 bus 实例续接（进程内全局语义）', () => {
    const bus1 = createMemoryEventBus();
    bus1.emit('conv-F', 'task.started', {});
    const bus2 = createMemoryEventBus();
    const e = bus2.emit('conv-F', 'agent.status', { content: 'x' });
    assert.equal(e.seq, 2);
  });
});

describe('EventBus rowToEnvelope', () => {
  it('DB 行完整还原为 envelope（含 JSON 字段解析）', () => {
    const env = rowToEnvelope({
      id: 'e-1', conversationId: 'c-1', taskId: 't-1', agentId: 'sisyphus', agentType: 'planner',
      eventType: 'tool.completed', seq: 5, status: 'completed', content: 'done',
      tool: JSON.stringify({ toolName: 'read_file', toolInput: 'a.ts' }),
      parentEventId: 'e-0', metadata: JSON.stringify({ token: 10 }), createdAt: '2026-08-24T00:00:00Z',
    });
    assert.equal(env.eventId, 'e-1');
    assert.equal(env.sessionId, 'c-1');
    assert.equal(env.tool?.toolName, 'read_file');
    assert.equal(env.metadata?.token, 10);
    assert.equal(env.parentEventId, 'e-0');
    assert.equal(env.status, 'completed');
  });

  it('空 JSON 字段优雅处理', () => {
    const env = rowToEnvelope({
      id: 'e-2', conversationId: 'c-1', taskId: 't-1', agentId: 'main', agentType: 'conversation',
      eventType: 'agent.status', seq: 6, status: null, content: 'hi', tool: null, parentEventId: null, metadata: null,
      createdAt: '2026-08-24T00:00:00Z',
    });
    assert.equal(env.tool, undefined);
    assert.equal(env.metadata, undefined);
  });
});

// DB 版 createEventBus 的集成测试（用 sql.js 内存库）
describe('EventBus (sqlite)', () => {
  it('emit 落库后 listEvents 可回放；重启（重建 bus）后 seq 从 DB 续接', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const sqlDb = new SQL.Database();
    sqlDb.run(`CREATE TABLE activity_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main', agent_type TEXT NOT NULL DEFAULT 'conversation',
      event_type TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT, content TEXT,
      tool TEXT, parent_event_id TEXT, metadata TEXT, created_at TEXT NOT NULL
    )`);
    const drizzle = (await import('drizzle-orm/sql-js')).drizzle;
    const schema = await import('../db/schema/index.js');
    const { eq } = await import('drizzle-orm');

    let saved = 0;
    const db = drizzle(sqlDb, { schema: { activityEvents: schema.activityEvents } }) as any;

    // 第一次 bus
    const bus1 = createEventBus(db, undefined, () => { saved++; });
    bus1.emit('conv-db', 'task.started', { taskId: 't-1', agentId: 'main' });
    bus1.emit('conv-db', 'tool.started', { taskId: 't-1', content: 'read_file' });
    bus1.emit('conv-db', 'tool.completed', { taskId: 't-1', content: 'ok', status: 'completed' });
    assert.ok(saved >= 3);
    assert.equal(bus1.listEvents('conv-db').length, 3);

    // 模拟进程重启：新建 bus（不重复落库数据源）
    const bus2 = createEventBus(db, undefined, () => {});
    bus2.emit('conv-db', 'agent.status', { taskId: 't-1', content: 'almost done' });
    const all = bus2.listEvents('conv-db');
    // 第一个事件 seq 应为 1（来自 DB 续接），新事件 seq 应为 4
    assert.equal(all[0].seq, 1);
    assert.equal(all[3].seq, 4);
    assert.equal(all.length, 4);

    // listEventsAfter 在 DB 版上也工作
    const after = bus2.listEventsAfter('conv-db', 2);
    assert.deepEqual(after.map(e => e.seq), [3, 4]);

    // 序号复用在显式 role=memory: init seq 递增逻辑正确
    const seqs = all.map(e => e.seq);
    assert.equal(new Set(seqs).size, 4);
  });
});