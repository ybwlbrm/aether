import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentEventEnvelope } from '@pacc/shared';
import { projectToRecords, type ActivityRecord, useActivityStore, projectTaskProgress } from './activityStore';
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
    useActivityStore.setState({ eventsByConv: {}, cursorByConv: {}, taskCardCache: {} });
  });

  it('两个不同 Run 的相同 seq 事件不得互相去重（去重键 = eventId 或 sessionId+taskId+seq）', () => {
    const store = useActivityStore.getState();
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-A' }));
    store.appendEvent('conv1', env({ eventType: 'task.started', seq: 1, taskId: 'run-B', eventId: 'runB-e1' }));
    const events = useActivityStore.getState().getEvents('conv1');
    // 当前实现按 seq 去重 → 只保留 1 条 = RED；正确应保留 2 条（不同 run）
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
    // agent.completed ≠ task.completed：任务仍应 running（当前实现误判 completed = RED）
    expect(progress?.status).toBe('running');
  });
});