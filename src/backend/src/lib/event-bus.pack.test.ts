import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { createEventBus } from './event-bus.js';

describe('EventBus chunk-rows 打包', () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;

  before(async () => {
    SQL = await initSqlJs();
  });

  function makeDb() {
    const sqlDb = new SQL.Database();
    sqlDb.run(`CREATE TABLE activity_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main', agent_type TEXT NOT NULL DEFAULT 'conversation',
      event_type TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT, content TEXT,
      tool TEXT, parent_event_id TEXT, metadata TEXT, created_at TEXT NOT NULL
    )`);
    return sqlDb;
  }

  it('delta 事件聚合为打包行（行数减少），回放完整还原', async () => {
    const sqlDb = makeDb();
    const drizzle = (await import('drizzle-orm/sql-js')).drizzle;
    const schema = await import('../db/schema/index.js');
    const db = drizzle(sqlDb, { schema: { activityEvents: schema.activityEvents } }) as any;

    let saved = 0;
    const bus = createEventBus(db, undefined, () => { saved++; });

    // 20 条 reasoning.delta + 10 条 message.delta + 结束事件
    for (let i = 0; i < 20; i++) {
      bus.emit('pack-conv', 'agent.reasoning.delta', { taskId: 't1', agentId: 'sisyphus', agentType: 'orchestrator', content: `思考${i}` });
    }
    for (let i = 0; i < 10; i++) {
      bus.emit('pack-conv', 'agent.message.delta', { taskId: 't1', agentId: 'sisyphus', agentType: 'orchestrator', content: `正文${i}` });
    }
    // 非 delta 事件触发冲刷
    bus.emit('pack-conv', 'task.completed', { taskId: 't1', agentId: 'sisyphus', status: 'completed', content: '完成', endReason: 'completed' });

    // 落库行数：20 条 reasoning 打包为 1 行 + 10 条 message 打包 1 行 + task.completed 1 行 = 3 行
    const rows = sqlDb.exec('SELECT COUNT(*) FROM activity_events WHERE conversation_id=\'pack-conv\'');
    const physicalRows = rows[0].values[0][0];
    assert.ok(physicalRows <= 3, `物理行数应 <=3，实际 ${physicalRows}`);

    // 回放：还原全部事件（20 reasoning + 10 message + 1 completed = 31）
    const events = bus.listEvents('pack-conv');
    assert.equal(events.length, 31);
    const reasonings = events.filter(e => e.eventType === 'agent.reasoning.delta');
    const messages = events.filter(e => e.eventType === 'agent.message.delta');
    assert.equal(reasonings.length, 20);
    assert.equal(reasonings[0].content, '思考0');
    assert.equal(reasonings[19].content, '思考19');
    assert.equal(messages.length, 10);
    assert.equal(events.at(-1)?.eventType, 'task.completed');

    // seq 单调且完整
    const seqs = events.map(e => e.seq);
    assert.equal(new Set(seqs).size, 31);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

    // listEventsAfter 跨打包行正确过滤
    const after = bus.listEventsAfter('pack-conv', 25);
    assert.ok(after.every(e => e.seq > 25));
    assert.ok(after.length > 0);

    sqlDb.close();
  });

  it('单条 delta 不打包（原样落库）', async () => {
    const sqlDb = makeDb();
    const drizzle = (await import('drizzle-orm/sql-js')).drizzle;
    const schema = await import('../db/schema/index.js');
    const db = drizzle(sqlDb, { schema: { activityEvents: schema.activityEvents } }) as any;

    const bus = createEventBus(db, undefined, () => {});
    bus.emit('single-conv', 'agent.message.delta', { taskId: 't1', content: 'only' });
    bus.emit('single-conv', 'agent.message.delta', { taskId: 't1', content: 'really' }); // 仍是独立两条（不达阈值前无冲刷？先在 emit 时不冲刷）

    const events = bus.listEvents('single-conv');
    assert.equal(events.length, 2);
    assert.equal(events[0].content, 'only');
    assert.equal(events[1].content, 'really');
    sqlDb.close();
  });

  it('非打包类型不受影响（task/tool/agent 事件照常单行）', async () => {
    const sqlDb = makeDb();
    const drizzle = (await import('drizzle-orm/sql-js')).drizzle;
    const schema = await import('../db/schema/index.js');
    const db = drizzle(sqlDb, { schema: { activityEvents: schema.activityEvents } }) as any;

    const bus = createEventBus(db, undefined, () => {});
    bus.emit('norm-conv', 'task.started', { taskId: 't1', content: 'start' });
    bus.emit('norm-conv', 'tool.started', { taskId: 't1', tool: { toolName: 'read_file', toolInput: 'a.ts' } });
    bus.emit('norm-conv', 'tool.completed', { taskId: 't1', tool: { toolName: 'read_file', toolInput: 'a.ts', toolOutput: 'ok' }, parentEventId: 'x', status: 'completed' });
    const events = bus.listEvents('norm-conv');
    assert.deepEqual(events.map(e => e.eventType), ['task.started', 'tool.started', 'tool.completed']);
    sqlDb.close();
  });
});