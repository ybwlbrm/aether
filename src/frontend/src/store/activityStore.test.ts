import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentEventEnvelope } from '@pacc/shared';
import { projectToRecords, type ActivityRecord, useActivityStore, projectTaskProgress, getEventIdentity } from './activityStore';
import { parseSseFrame } from '../api/streamClient';

function env(partial: Partial<AgentEventEnvelope> & { eventType: AgentEventEnvelope['eventType'] }): AgentEventEnvelope {
  return {
    eventId: `e-${partial.seq ?? 0}`,
    sessionId: 's-1',
    taskId: 't-1',
    agentId: 'main',
    agentType: 'conversation',
    timestamp: '2026-08-24T00:00:00Z',
    seq: partial.seq ?? 0,
    ...partial,
  } as AgentEventEnvelope;
}

describe('activityStore 投影', () => {
  it('tool.started → tool.completed 折叠为单条记录（pending → completed 状态流转）', () => {
    const records = projectToRecords([
      env({ eventType: 'tool.started', seq: 1, eventId: 'tool-1', tool: { toolName: 'read_file', toolInput: 'a.ts' } }),
      env({ eventType: 'tool.completed', seq: 2, parentEventId: 'tool-1', tool: { toolName: 'read_file', toolInput: 'a.ts', toolOutput: 'ok' } }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'tool', status: 'completed', label: 'read_file', target: 'a.ts' });
  });

  it('tool.error 通过 parentEventId 更新原记录为 error 并携带错误信息', () => {
    const records = projectToRecords([
      env({ eventType: 'tool.started', seq: 1, eventId: 'tool-1', tool: { toolName: 'edit_file', toolInput: 'b.ts' } }),
      env({ eventType: 'tool.error', seq: 2, parentEventId: 'tool-1', tool: { toolName: 'edit_file', toolInput: 'b.ts', error: { message: 'require read first' } } }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('error');
    expect(records[0].side).toBe('require read first');
  });

  it('agent.status / agent.completed 各自成为独立活动行', () => {
    const records = projectToRecords([
      env({ eventType: 'agent.status', seq: 1, agentId: 'sisyphus', content: '正在分析 Tool Router' }),
      env({ eventType: 'agent.completed', seq: 2, agentId: 'sisyphus', content: '完成' }),
    ]);
    const kinds = records.map(r => r.kind);
    expect(kinds).toEqual(['agent', 'agent']);
    expect((records[1] as ActivityRecord).status).toBe('completed');
  });

  it('任务边界事件（task.completed/cancelled/failed）进入活动流', () => {
    const records = projectToRecords([
      env({ eventType: 'task.completed', seq: 1, content: '完成' }),
    ]);
    expect(records[0]).toMatchObject({ kind: 'task', status: 'completed' });
  });

  it('agent.message.delta 不进活动流（由 projectReplies 单独投影）', () => {
    const records = projectToRecords([
      env({ eventType: 'agent.message.delta', seq: 1, content: '我发现' }),
      env({ eventType: 'agent.message.delta', seq: 2, content: '项目' }),
    ]);
    expect(records).toHaveLength(0);
  });

  it('无 parent 的 tool.completed 也生成记录（防御性兜底）', () => {
    const records = projectToRecords([
      env({ eventType: 'tool.completed', seq: 1, tool: { toolName: 'grep', toolInput: 'x' } }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
  });
});

describe('parseSseFrame（streamClient 统一帧解析）', () => {
  it('解析 event/data 行', () => {
    const { eventName, dataLine } = parseSseFrame('event: tool.started\ndata: {"a":1}');
    expect(eventName).toBe('tool.started');
    expect(JSON.parse(dataLine)).toEqual({ a: 1 });
  });

  it('无 event 行时默认 message', () => {
    const { eventName } = parseSseFrame('data: {"content":"hi"}');
    expect(eventName).toBe('message');
  });

  it('支持 CRLF 与多行 data', () => {
    const { eventName, dataLine } = parseSseFrame('event: agent.status\r\ndata: {"content":"line1\r\ndata: ","more":"x"}\r\n');
    expect(eventName).toBe('agent.status');
    expect(dataLine).toContain('line1');
  });
});

describe('activityStore — 跨 Run 去重与隔离（P0-08/P1-12）', () => {
  beforeEach(() => {
    useActivityStore.setState({ 
      eventsByRun: {}, 
      cursorByRun: {}, 
      taskCardCache: {},
      reasoningCache: {},
      runMetaById: {},
      runsByConversation: {},
    });
  });

  it('两个不同 Run 的相同 seq 事件不得互相去重（去重键 = eventId 或 sessionId+taskId+seq）', () => {
    const store = useActivityStore.getState();
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-B', eventId: 'runB-e1' }));
    const events = useActivityStore.getState().getEvents('conv1');
    // 现在按 run 隔离，不同 taskId 会生成不同 runKey，应保留 2 条
    expect(events).toHaveLength(2);
  });

  it('同一 Run 相同 eventId 重复推送（SSE 重放）被去重', () => {
    const store = useActivityStore.getState();
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A', eventId: 'e-same' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A', eventId: 'e-same' }));
    expect(useActivityStore.getState().getEvents('conv1')).toHaveLength(1);
  });

  it('projectTaskProgress：agent.completed 不得把 task 标记为完成（P0-18）', () => {
    const events: AgentEventEnvelope[] = [
      env({ eventType: 'task.started', seq: 1, taskId: 't-1' }),
      env({ eventType: 'agent.completed', seq: 2, taskId: 't-1', agentId: 'sisyphus', content: 'done' }),
    ];
    const progress = projectTaskProgress(events);
    // agent.completed ≠ task.completed：任务仍应 running
    expect(progress?.status).toBe('running');
  });

  it('EVT-003: 统一事件身份 = eventId 优先（不同 eventId 不因 seq 相同被误杀）', () => {
    const store = useActivityStore.getState();
    store.appendEvents('conv1', [env({ eventType: 'agent.started', seq: 5, taskId: 'r1', eventId: 'e-5' })]);
    // 另一事件 eventId 不同但 sessionId+taskId+seq 相同：eventId 全局唯一 → 应视为不同事件
    store.appendEvent('conv1', env({ eventType: 'agent.started', seq: 5, taskId: 'r1', eventId: 'e-5-bis' }));
    expect(useActivityStore.getState().getEvents('conv1')).toHaveLength(2);
  });

  it('EVT-003: 两个入口对相同 eventId 的去重行为一致（append 后 batch 重放不重复）', () => {
    const store = useActivityStore.getState();
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'r1', eventId: 'shared-1' }));
    store.appendEvents('conv1', [env({ eventType: 'task.started', seq: 1, taskId: 'r1', eventId: 'shared-1' })]);
    expect(useActivityStore.getState().getEvents('conv1')).toHaveLength(1);
    // 不同 run：sessionId 不同且 eventId 不同 → 全部保留
    store.appendEvents('conv1', [env({ eventType: 'agent.started', seq: 1, sessionId: 's-2', taskId: 'run-B', eventId: 'e-b1' })]);
    expect(useActivityStore.getState().getEvents('conv1')).toHaveLength(2);
  });
});

describe('activityStore — Run-scoped 状态隔离（P0-03 第三轮审计）', () => {
  beforeEach(() => {
    useActivityStore.setState({ 
      eventsByRun: {}, 
      cursorByRun: {}, 
      taskCardCache: {},
      reasoningCache: {},
      runMetaById: {},
      runsByConversation: {},
    });
  });

  it('同一 conversation 两次 Run 的事件分别进入不同 run bucket（互不污染）', () => {
    const store = useActivityStore.getState();
    
    // Run 1: taskId = 'run-1'
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-1', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'agent.started', seq: 2, taskId: 'run-1', eventId: 'e2', agentId: 'agent-1' }));
    store.appendEvent('conv1', env({ eventType: 'task.completed', seq: 3, taskId: 'run-1', eventId: 'e3' }));
    
    // Run 2: taskId = 'run-2' (同一 conversation)
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-2', eventId: 'e4' }));
    store.appendEvent('conv1', env({ eventType: 'agent.started', seq: 2, taskId: 'run-2', eventId: 'e5', agentId: 'agent-2' }));
    store.appendEvent('conv1', env({ eventType: 'task.completed', seq: 3, taskId: 'run-2', eventId: 'e6' }));
    
    // 聚合视图：应该有 6 个事件
    const allEvents = store.getEvents('conv1');
    expect(allEvents).toHaveLength(6);
    
    // 按 run 分离：每个 run 应该有 3 个事件
    const runIds = store.getRunsForConversation('conv1');
    expect(runIds).toHaveLength(2);
    
    const run1Events = store.getEventsByRun(runIds[0]);
    const run2Events = store.getEventsByRun(runIds[1]);
    expect(run1Events).toHaveLength(3);
    expect(run2Events).toHaveLength(3);
    
    // 验证 run 归属正确
    expect(run1Events.every(e => e.taskId === 'run-1')).toBe(true);
    expect(run2Events.every(e => e.taskId === 'run-2')).toBe(true);
  });

  it('run A 的 reasoning 不影响 run B', () => {
    const store = useActivityStore.getState();
    
    // Run 1
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'agent.reasoning.delta', seq: 2, taskId: 'run-A', eventId: 'e2', agentId: 'agent-1', content: 'Reasoning A' }));
    
    // Run 2
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-B', eventId: 'e3' }));
    store.appendEvent('conv1', env({ eventType: 'agent.reasoning.delta', seq: 2, taskId: 'run-B', eventId: 'e4', agentId: 'agent-2', content: 'Reasoning B' }));
    
    // 投影 taskCard 时应该按 run 隔离
    const runIds = store.getRunsForConversation('conv1');
    const cardA = store.projectTaskCardByRun(runIds[0]);
    const cardB = store.projectTaskCardByRun(runIds[1]);
    
    expect(cardA?.activeReasoning).toContain('Reasoning A');
    expect(cardA?.activeReasoning).not.toContain('Reasoning B');
    expect(cardB?.activeReasoning).toContain('Reasoning B');
    expect(cardB?.activeReasoning).not.toContain('Reasoning A');
  });

  it('cursor 独立：每个 run 维护自己的 seq 游标', () => {
    const store = useActivityStore.getState();
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'agent.started', seq: 2, taskId: 'run-A', eventId: 'e2' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-B', eventId: 'e3' }));
    store.appendEvent('conv1', env({ eventType: 'agent.started', seq: 2, taskId: 'run-B', eventId: 'e4' }));
    store.appendEvent('conv1', env({ eventType: 'agent.started', seq: 3, taskId: 'run-B', eventId: 'e5' }));
    
    const runIds = store.getRunsForConversation('conv1');
    expect(store.getLastSeqByRun(runIds[0])).toBe(2);
    expect(store.getLastSeqByRun(runIds[1])).toBe(3);
    // 聚合游标取最大值
    expect(store.getLastSeq('conv1')).toBe(3);
  });

  it('runsByConversation 正确聚合：同一 conversation 的多个 run 都被记录', () => {
    const store = useActivityStore.getState();
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-1', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-2', eventId: 'e2' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-3', eventId: 'e3' }));
    
    const runIds = store.getRunsForConversation('conv1');
    expect(runIds).toHaveLength(3);
    expect(runIds).toContain('s-1:run-1');
    expect(runIds).toContain('s-1:run-2');
    expect(runIds).toContain('s-1:run-3');
  });

  it('clearConv 清除该 conversation 下所有 run 的数据', () => {
    const store = useActivityStore.getState();
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-1', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-2', eventId: 'e2' }));
    store.appendEvent('conv2', env({ eventType: 'task.started', seq: 1, taskId: 'run-3', eventId: 'e3' }));
    
    expect(store.getEvents('conv1')).toHaveLength(2);
    expect(store.getEvents('conv2')).toHaveLength(1);
    
    store.clearConv('conv1');
    
    expect(store.getEvents('conv1')).toHaveLength(0);
    expect(store.getRunsForConversation('conv1')).toHaveLength(0);
    expect(store.getEvents('conv2')).toHaveLength(1); // conv2 不受影响
  });

  it('clearRun 仅清除指定 run，不影响同 conversation 其他 run', () => {
    const store = useActivityStore.getState();
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-1', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-2', eventId: 'e2' }));
    
    const runIds = store.getRunsForConversation('conv1');
    expect(runIds).toHaveLength(2);
    
    store.clearRun(runIds[0]);
    
    expect(store.getRunsForConversation('conv1')).toHaveLength(1);
    expect(store.getEvents('conv1')).toHaveLength(1);
    expect(store.getEventsByRun(runIds[1])).toHaveLength(1);
  });

  it('getEventIdentity 统一去重键：eventId 优先，回退 sessionId+taskId+seq', () => {
    const ev1 = env({ eventType: 'task.started', seq: 1, taskId: 't1', eventId: 'uuid-123' });
    const ev2 = env({ eventType: 'task.started', seq: 1, taskId: 't1', eventId: 'uuid-123' }); // 同 eventId
    // 创建一个没有 eventId 的事件（通过直接构造对象）
    const ev3 = {
      eventId: '',
      sessionId: 's-1',
      taskId: 't1',
      agentId: 'main',
      agentType: 'conversation',
      timestamp: '2026-08-24T00:00:00Z',
      seq: 1,
      eventType: 'task.started' as AgentEventEnvelope['eventType'],
    } as AgentEventEnvelope;
    
    expect(getEventIdentity(ev1)).toBe('uuid-123');
    expect(getEventIdentity(ev2)).toBe('uuid-123');
    expect(getEventIdentity(ev3)).toBe('s-1::t1::1');
    expect(getEventIdentity(ev1)).not.toBe(getEventIdentity(ev3));
  });

  it('replaceEvents 替换指定 conversation 的所有 run 事件', () => {
    const store = useActivityStore.getState();
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-1', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-2', eventId: 'e2' }));
    
    // 替换为新事件
    store.replaceEvents('conv1', [
      env({ eventType: 'task.started', seq: 1, taskId: 'run-new', eventId: 'e3' }),
      env({ eventType: 'agent.started', seq: 2, taskId: 'run-new', eventId: 'e4' }),
    ]);
    
    const events = store.getEvents('conv1');
    expect(events).toHaveLength(2);
    expect(events[0].taskId).toBe('run-new');
    expect(events[1].taskId).toBe('run-new');
    
    const runIds = store.getRunsForConversation('conv1');
    expect(runIds).toHaveLength(1);
    expect(runIds[0]).toBe('s-1:run-new');
  });

  it('runMetaById 记录 run 元数据（开始/结束时间、状态、结束原因）', () => {
    const store = useActivityStore.getState();
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-1', eventId: 'e1', timestamp: '2026-01-01T00:00:00Z' }));
    store.appendEvent('conv1', env({ eventType: 'agent.started', seq: 2, taskId: 'run-1', eventId: 'e2' }));
    store.appendEvent('conv1', env({ eventType: 'task.completed', seq: 3, taskId: 'run-1', eventId: 'e3', timestamp: '2026-01-01T00:01:00Z', endReason: 'completed' }));
    
    const runIds = store.getRunsForConversation('conv1');
    const meta = store.getRunMeta(runIds[0]);
    
    expect(meta).toBeDefined();
    expect(meta?.runId).toBe(runIds[0]);
    expect(meta?.conversationId).toBe('conv1');
    expect(meta?.taskId).toBe('run-1');
    expect(meta?.status).toBe('completed');
    expect(meta?.endReason).toBe('completed');
    expect(meta?.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(meta?.endedAt).toBe('2026-01-01T00:01:00Z');
  });

  it('projectTaskCardByRun 仅投影指定 run 的任务卡', () => {
    const store = useActivityStore.getState();
    
    // Run 1: 有 plan
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'task.plan', seq: 2, taskId: 'run-A', eventId: 'e2', content: 'Plan A' }));
    store.appendEvent('conv1', env({ eventType: 'task.completed', seq: 3, taskId: 'run-A', eventId: 'e3' }));
    
    // Run 2: 无 plan
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-B', eventId: 'e4' }));
    store.appendEvent('conv1', env({ eventType: 'task.completed', seq: 2, taskId: 'run-B', eventId: 'e5' }));
    
    const runIds = store.getRunsForConversation('conv1');
    const cardA = store.projectTaskCardByRun(runIds[0]);
    const cardB = store.projectTaskCardByRun(runIds[1]);
    
    expect(cardA?.plan).toBe('Plan A');
    expect(cardB?.plan).toBeUndefined();
  });

  it('projectRepliesByRun 仅投影指定 run 的最终回答', () => {
    const store = useActivityStore.getState();
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A', eventId: 'e1' }));
    store.appendEvent('conv1', env({ eventType: 'agent.message.delta', seq: 2, taskId: 'run-A', eventId: 'e2', agentId: 'agent-1', content: 'Hello ' }));
    store.appendEvent('conv1', env({ eventType: 'agent.message.delta', seq: 3, taskId: 'run-A', eventId: 'e3', agentId: 'agent-1', content: 'World' }));
    
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-B', eventId: 'e4' }));
    store.appendEvent('conv1', env({ eventType: 'agent.message.delta', seq: 2, taskId: 'run-B', eventId: 'e5', agentId: 'agent-2', content: 'Foo' }));
    
    const runIds = store.getRunsForConversation('conv1');
    const repliesA = store.projectRepliesByRun(runIds[0]);
    const repliesB = store.projectRepliesByRun(runIds[1]);
    
    expect(repliesA.get('agent-1')).toBe('Hello World');
    expect(repliesB.get('agent-2')).toBe('Foo');
    expect(repliesA.has('agent-2')).toBe(false);
    expect(repliesB.has('agent-1')).toBe(false);
  });
});