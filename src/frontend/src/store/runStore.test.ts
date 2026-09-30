/**
 * runStore 权威 Run 状态层（T8）—— TDD 契约测试。
 *
 * 本文件先于实现写成（RED）：它逐条钉住"唯一数据输入 = 真实后端快照 + 真实 v2 事件"这一不变量。
 * 关键断言：
 *   - 11 态只能经 ingestSnapshot 写入（服务端权威），事件流不得凭空造态
 *   - 44 种事件类型的任意序列都不产出 RUN_STATUSES 之外的状态
 *   - 未见过后端快照的 run，事件不生成占位 RunSnapshot（不伪造数据）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPES_V2,
  RUN_STATUSES,
  type AgentEvent,
  type RetryEventPayload,
  type RunStatus,
} from '@pacc/shared';
import type { RunDto } from '../api/runs';
import { BUDGET_EXCEEDED_EVENT_TYPE, useRunStore } from './runStore';

// ---------- 夹具 ----------

function dto(partial: Partial<RunDto> = {}): RunDto {
  return {
    id: 'run-1',
    conversationId: 'conv-1',
    status: 'created',
    mode: 'normal',
    rootAgentId: null,
    startedAt: null,
    completedAt: null,
    endReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    error: null,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function retryPayload(runId: string): RetryEventPayload {
  return {
    runId,
    taskId: 't-1',
    attempt: 2,
    maxAttempts: 3,
    retryType: 'automatic',
    retryLayer: 'task',
  };
}

/**
 * 44 种事件类型的穷尽夹具。
 * 每个分支内联字面量 type，让 TS 对该分支的 payload 做真实校验 —— 无 any、无类型断言。
 * 后端新增事件类型时此函数必然编译报错（switch 不再穷尽 AgentEvent['type']）。
 */
function event(type: AgentEvent['type'], seq = 1, runId = 'run-1'): AgentEvent {
  const base = {
    eventId: `e-${seq}`,
    sessionId: 'conv-1',
    runId,
    timestamp: '2026-01-01T00:00:00.000Z',
    seq,
    version: 2,
  };
  switch (type) {
    case 'run.created': return { ...base, type: 'run.created', payload: {} };
    case 'run.started': return { ...base, type: 'run.started', payload: {} };
    case 'run.paused': return { ...base, type: 'run.paused', payload: {} };
    case 'run.resumed': return { ...base, type: 'run.resumed', payload: {} };
    case 'run.completed':
      return { ...base, type: 'run.completed', payload: { endReason: 'completed', tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } };
    case 'run.failed':
      return { ...base, type: 'run.failed', payload: { endReason: 'error', error: { message: 'boom' } } };
    case 'run.cancelled': return { ...base, type: 'run.cancelled', payload: { endReason: 'aborted' } };
    case 'run.interrupted': return { ...base, type: 'run.interrupted', payload: { endReason: 'aborted' } };
    case 'task.started': return { ...base, type: 'task.started', payload: { status: 'started' } };
    case 'task.plan': return { ...base, type: 'task.plan', payload: { content: 'plan' } };
    case 'task.progress': return { ...base, type: 'task.progress', payload: { content: 'step' } };
    case 'task.ask-confirm': return { ...base, type: 'task.ask-confirm', payload: { content: 'ok?' } };
    case 'task.completed': return { ...base, type: 'task.completed', payload: { status: 'completed', endReason: 'stop' } };
    case 'task.cancelled': return { ...base, type: 'task.cancelled', payload: { status: 'cancelled', endReason: 'aborted' } };
    case 'task.failed':
      return { ...base, type: 'task.failed', payload: { status: 'error', endReason: 'error', error: { message: 'task failed' } } };
    case 'agent.started': return { ...base, type: 'agent.started', payload: { status: 'running' } };
    case 'agent.status': return { ...base, type: 'agent.status', payload: { status: 'running' } };
    case 'agent.waiting': return { ...base, type: 'agent.waiting', payload: { status: 'waiting', content: 'wait' } };
    case 'agent.resumed': return { ...base, type: 'agent.resumed', payload: { status: 'running' } };
    case 'agent.completed': return { ...base, type: 'agent.completed', payload: { status: 'completed' } };
    case 'agent.error':
      return { ...base, type: 'agent.error', payload: { status: 'error', content: 'err', error: { message: 'e' } } };
    case 'agent.retry': return { ...base, type: 'agent.retry', payload: { status: 'retry', content: 'retry' } };
    case 'agent.spawned': return { ...base, type: 'agent.spawned', payload: { targetAgentId: 'a-2' } };
    case 'agent.handoff': return { ...base, type: 'agent.handoff', payload: { targetAgentId: 'a-2', content: 'go' } };
    case 'agent.failed':
      return { ...base, type: 'agent.failed', payload: { status: 'error', content: 'e', error: { message: 'e' } } };
    case 'agent.stopped': return { ...base, type: 'agent.stopped', payload: {} };
    case 'agent.inbox.directive': return { ...base, type: 'agent.inbox.directive', payload: { directive: 'stop' } };
    case 'agent.message.delta': return { ...base, type: 'agent.message.delta', payload: { content: 'hi' } };
    case 'agent.message.completed': return { ...base, type: 'agent.message.completed', payload: { content: 'hi', isFinal: true } };
    case 'agent.reasoning.delta': return { ...base, type: 'agent.reasoning.delta', payload: { content: 'why' } };
    case 'agent.output.delta': return { ...base, type: 'agent.output.delta', payload: { content: 'out' } };
    case 'agent.output.completed': return { ...base, type: 'agent.output.completed', payload: { content: 'out', isFinal: true } };
    case 'tool.started': return { ...base, type: 'tool.started', payload: { toolName: 'read', toolInput: 'a', status: 'started' } };
    case 'tool.progress': return { ...base, type: 'tool.progress', payload: { toolName: 'read', toolInput: 'a', status: 'running' } };
    case 'tool.completed':
      return { ...base, type: 'tool.completed', payload: { toolName: 'read', toolInput: 'a', status: 'completed', toolOutput: 'ok' } };
    case 'tool.error':
      return { ...base, type: 'tool.error', payload: { toolName: 'read', toolInput: 'a', status: 'error', error: { message: 'e' } } };
    case 'tool.retry': return { ...base, type: 'tool.retry', payload: { toolName: 'read', toolInput: 'a', status: 'retry' } };
    case 'token.usage': return { ...base, type: 'token.usage', payload: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
    case 'attempt.started': return { ...base, type: 'attempt.started', payload: retryPayload(runId) };
    case 'retry.scheduled':
      return { ...base, type: 'retry.scheduled', payload: { ...retryPayload(runId), reason: 'timeout', delayMs: 1200, nextRetryAt: '2026-01-01T00:00:02.000Z' } };
    case 'retry.started': return { ...base, type: 'retry.started', payload: retryPayload(runId) };
    case 'retry.completed': return { ...base, type: 'retry.completed', payload: retryPayload(runId) };
    case 'retry.failed': return { ...base, type: 'retry.failed', payload: { ...retryPayload(runId), reason: 'timeout' } };
    case 'retry.exhausted': return { ...base, type: 'retry.exhausted', payload: { ...retryPayload(runId), reason: 'timeout' } };
  }
}

beforeEach(() => {
  useRunStore.setState({ runsById: {}, runIdsByConversation: {}, activeRunId: null, lastSyncedAt: null });
});

// ---------- (a) 11 态可达 ----------

describe('ingestSnapshot：11 态全部可达', () => {
  it('逐个写入 11 个后端状态值并可读回', () => {
    expect(RUN_STATUSES).toHaveLength(11);
    RUN_STATUSES.forEach((status, index) => {
      useRunStore.getState().ingestSnapshot(dto({ id: `run-${index}`, status }));
    });
    RUN_STATUSES.forEach((status, index) => {
      expect(useRunStore.getState().getRun(`run-${index}`)?.status).toBe(status);
    });
  });

  it('状态值直接来自后端快照，可从 running 跳到任意终态（不经过前端状态机）', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'] as const) {
      useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status }));
      expect(useRunStore.getState().getRun('run-1')?.status).toBe(status);
    }
  });

  it('isRunBusy 委托 T5 busy 标志：5 个进行中态为 true', () => {
    const busy: readonly RunStatus[] = ['running', 'waiting', 'retry_waiting', 'retrying', 'verifying'];
    for (const status of RUN_STATUSES) {
      expect(useRunStore.getState().isRunBusy(status)).toBe(busy.includes(status));
    }
  });
});

// ---------- (b) 属性测试：44 种事件类型永不产出非法状态 ----------

describe('applyLifecycleEvent：44 种事件类型的状态闭包', () => {
  it('AGENT_EVENT_TYPES_V2 恰为 44 种（夹具穷尽性的前提）', () => {
    expect(AGENT_EVENT_TYPES_V2).toHaveLength(44);
  });

  it('随机事件序列后状态始终落在 RUN_STATUSES 内', () => {
    // 确定性 LCG：同一种子必得同一序列，失败可复现
    let seed = 20260927;
    const pick = (n: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let round = 0; round < 12; round++) {
      const runId = `run-${round}`;
      useRunStore.getState().ingestSnapshot(dto({ id: runId, status: 'created' }));
      for (let i = 1; i <= 30; i++) {
        const type = AGENT_EVENT_TYPES_V2[pick(AGENT_EVENT_TYPES_V2.length)];
        useRunStore.getState().applyLifecycleEvent(event(type, i, runId));
        const status = useRunStore.getState().getRun(runId)?.status;
        expect(RUN_STATUSES).toContain(status);
      }
    }
  });

  it('44 种事件逐一单独应用，均不产生 RUN_STATUSES 之外的状态', () => {
    for (const type of AGENT_EVENT_TYPES_V2) {
      useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'created' }));
      useRunStore.getState().applyLifecycleEvent(event(type, 1));
      expect(RUN_STATUSES).toContain(useRunStore.getState().getRun('run-1')?.status);
    }
  });
});

// ---------- (c) 4 个终态事件映射 ----------

describe('applyLifecycleEvent：run 生命周期事件 → status', () => {
  const CASES: ReadonlyArray<readonly [AgentEvent['type'], RunStatus]> = [
    ['run.completed', 'completed'],
    ['run.failed', 'failed'],
    ['run.cancelled', 'cancelled'],
    ['run.interrupted', 'interrupted'],
  ];

  it.each(CASES)('%s → %s', (type, expected) => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.getState().applyLifecycleEvent(event(type, 1));
    expect(useRunStore.getState().getRun('run-1')?.status).toBe(expected);
  });

  it('8 个 run.* 事件全部映射到 T5 表中的状态', () => {
    const EXPECTED: ReadonlyArray<readonly [AgentEvent['type'], RunStatus]> = [
      ['run.created', 'created'],
      ['run.started', 'running'],
      ['run.paused', 'waiting'],
      ['run.resumed', 'running'],
      ['run.completed', 'completed'],
      ['run.failed', 'failed'],
      ['run.cancelled', 'cancelled'],
      ['run.interrupted', 'interrupted'],
    ];
    for (const [type, expected] of EXPECTED) {
      useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'created' }));
      useRunStore.getState().applyLifecycleEvent(event(type, 1));
      expect(useRunStore.getState().getRun('run-1')?.status).toBe(expected);
    }
  });
});

// ---------- (d) run.budget_exceeded：v2 闭集外，string 检查 ----------

describe('applyLifecycleEvent：run.budget_exceeded', () => {
  it('映射为 budget_exceeded（前端 44 种闭集外的后端事件）', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.getState().applyLifecycleEvent({ type: BUDGET_EXCEEDED_EVENT_TYPE, runId: 'run-1', seq: 7 });
    expect(useRunStore.getState().getRun('run-1')?.status).toBe('budget_exceeded');
  });

  it('未被 AGENT_EVENT_TYPES_V2 收录，映射完全依赖 store 本地 string 检查', () => {
    expect(AGENT_EVENT_TYPES_V2).not.toContain(BUDGET_EXCEEDED_EVENT_TYPE);
  });
});

// ---------- (e) retry/attempt → retryState ----------

describe('applyLifecycleEvent：retry/attempt → retryState', () => {
  it('retry.scheduled 写入 attempt / status / delayMs', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.getState().applyLifecycleEvent(event('retry.scheduled', 3));
    expect(useRunStore.getState().getRun('run-1')?.retryState).toEqual({
      attempt: 2,
      status: 'scheduled',
      delayMs: 1200,
    });
  });

  it('retry.exhausted 写入 status: exhausted', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.getState().applyLifecycleEvent(event('retry.exhausted', 4));
    expect(useRunStore.getState().getRun('run-1')?.retryState).toEqual({ attempt: 2, status: 'exhausted' });
  });

  it('6 个 retry/attempt 事件各自产出合法 retryState.status', () => {
    const EXPECTED: ReadonlyArray<readonly [AgentEvent['type'], string]> = [
      ['attempt.started', 'running'],
      ['retry.scheduled', 'scheduled'],
      ['retry.started', 'running'],
      ['retry.completed', 'completed'],
      ['retry.failed', 'failed'],
      ['retry.exhausted', 'exhausted'],
    ];
    for (const [type, expected] of EXPECTED) {
      useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
      useRunStore.getState().applyLifecycleEvent(event(type, 1));
      const retryState = useRunStore.getState().getRun('run-1')?.retryState;
      expect(retryState?.status).toBe(expected);
      expect(retryState?.attempt).toBe(2);
    }
  });

  it('retry 事件不改动 status（状态迁移只认 8 个 run.*）', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.getState().applyLifecycleEvent(event('retry.scheduled', 1));
    expect(useRunStore.getState().getRun('run-1')?.status).toBe('running');
  });
});

// ---------- (f) activeRunId 与 removeRun ----------

describe('setActiveRun / getActiveRun / removeRun', () => {
  it('手动设置后 getActiveRun 返回该 run 快照', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.setState({ activeRunId: null });
    useRunStore.getState().setActiveRun('run-1');
    expect(useRunStore.getState().activeRunId).toBe('run-1');
    expect(useRunStore.getState().getActiveRun()?.id).toBe('run-1');
  });

  it('setActiveRun(null) 清除活动 run', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.getState().setActiveRun('run-1');
    useRunStore.getState().setActiveRun(null);
    expect(useRunStore.getState().getActiveRun()).toBeNull();
  });

  it('ingestSnapshot 不推断 activeRunId（服务端快照不是"正在跑"的证据）', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    expect(useRunStore.getState().activeRunId).toBeNull();
  });

  it('applyLifecycleEvent 不推断 activeRunId（事件流同样不是证据）', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'created' }));
    useRunStore.getState().applyLifecycleEvent(event('run.started', 1));
    expect(useRunStore.getState().activeRunId).toBeNull();
  });

  it('removeRun 清理快照、索引与悬挂的 activeRunId', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    useRunStore.getState().setActiveRun('run-1');
    useRunStore.getState().removeRun('run-1');
    expect(useRunStore.getState().getRun('run-1')).toBeUndefined();
    expect(useRunStore.getState().getActiveRun()).toBeNull();
    expect(useRunStore.getState().getRunsForConversation('conv-1')).toEqual([]);
  });

  it('removeRun 不影响其他 run 的 activeRunId', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'completed' }));
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-2', status: 'running' }));
    useRunStore.getState().setActiveRun('run-2');
    useRunStore.getState().removeRun('run-1');
    expect(useRunStore.getState().getActiveRun()?.id).toBe('run-2');
  });
});

// ---------- (g) conversation 索引 ----------

describe('getRunsForConversation / clearConversation', () => {
  it('按 conversationId 过滤', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-a1', conversationId: 'conv-a', status: 'completed' }));
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-a2', conversationId: 'conv-a', status: 'running' }));
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-b1', conversationId: 'conv-b', status: 'running' }));
    expect(useRunStore.getState().getRunsForConversation('conv-a').map((r) => r.id)).toEqual(['run-a1', 'run-a2']);
    expect(useRunStore.getState().getRunsForConversation('conv-b').map((r) => r.id)).toEqual(['run-b1']);
    expect(useRunStore.getState().getRunsForConversation('conv-missing')).toEqual([]);
  });

  it('同一 run 重复 ingest 不产生重复索引', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', conversationId: 'conv-a', status: 'created' }));
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', conversationId: 'conv-a', status: 'running' }));
    expect(useRunStore.getState().getRunsForConversation('conv-a')).toHaveLength(1);
  });

  it('clearConversation 清空该会话全部 run 与索引', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-a1', conversationId: 'conv-a', status: 'running' }));
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-a2', conversationId: 'conv-a', status: 'running' }));
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-b1', conversationId: 'conv-b', status: 'running' }));
    useRunStore.getState().clearConversation('conv-a');
    expect(useRunStore.getState().getRunsForConversation('conv-a')).toEqual([]);
    expect(useRunStore.getState().getRun('run-a1')).toBeUndefined();
    expect(useRunStore.getState().getRun('run-a2')).toBeUndefined();
    expect(useRunStore.getState().getRun('run-b1')).toBeDefined();
  });
});

// ---------- (h) lastEventSeq / lastSyncedAt / isStale ----------

describe('快照与游标元数据', () => {
  it('ingestSnapshot 写入 lastEventSeq 与 lastSyncedAt', () => {
    expect(useRunStore.getState().lastSyncedAt).toBeNull();
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1' }), 42);
    const snapshot = useRunStore.getState().getRun('run-1');
    expect(snapshot?.lastEventSeq).toBe(42);
    expect(useRunStore.getState().lastSyncedAt).toBeTypeOf('number');
    expect(useRunStore.getState().lastSyncedAt).toBeGreaterThan(0);
  });

  it('未传 eventSeq 时保留既有游标，不倒退', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1' }), 42);
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    expect(useRunStore.getState().getRun('run-1')?.lastEventSeq).toBe(42);
  });

  it('applyLifecycleEvent 用事件 seq 单调推进 lastEventSeq', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1' }), 10);
    useRunStore.getState().applyLifecycleEvent(event('run.started', 11));
    expect(useRunStore.getState().getRun('run-1')?.lastEventSeq).toBe(11);
    useRunStore.getState().applyLifecycleEvent(event('run.completed', 3));
    expect(useRunStore.getState().getRun('run-1')?.lastEventSeq).toBe(11);
  });

  it('ingestSnapshot 清除 isStale；markStale 置位', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1' }));
    expect(useRunStore.getState().getRun('run-1')?.isStale).toBe(false);
    useRunStore.getState().markStale('run-1');
    expect(useRunStore.getState().getRun('run-1')?.isStale).toBe(true);
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    expect(useRunStore.getState().getRun('run-1')?.isStale).toBe(false);
  });

  it('markStale 未知 run 不生成占位快照', () => {
    useRunStore.getState().markStale('run-ghost');
    expect(useRunStore.getState().getRun('run-ghost')).toBeUndefined();
  });

  it('ingestSnapshot 保留事件流投影出的 retryState（DTO 不含重试信息）', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1' }));
    useRunStore.getState().applyLifecycleEvent(event('retry.scheduled', 5));
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }), 6);
    expect(useRunStore.getState().getRun('run-1')?.retryState).toEqual({
      attempt: 2,
      status: 'scheduled',
      delayMs: 1200,
    });
  });
});

// ---------- (i)(j) 忽略语义 ----------

describe('applyLifecycleEvent 的忽略语义', () => {
  it('非 run 事件（agent.message.delta 等）不改变状态且不抛错', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    for (const type of [
      'agent.message.delta',
      'agent.reasoning.delta',
      'tool.completed',
      'task.completed',
      'token.usage',
    ] as const) {
      expect(() => useRunStore.getState().applyLifecycleEvent(event(type, 1))).not.toThrow();
      expect(useRunStore.getState().getRun('run-1')?.status).toBe('running');
      expect(useRunStore.getState().getRun('run-1')?.retryState).toBeUndefined();
    }
  });

  it('未知事件类型 x.y 被安全忽略', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    expect(() =>
      useRunStore.getState().applyLifecycleEvent({ type: 'x.y', runId: 'run-1', seq: 99 }),
    ).not.toThrow();
    expect(useRunStore.getState().getRun('run-1')?.status).toBe('running');
  });

  it('Object 原型链上的键不误判为生命周期事件', () => {
    useRunStore.getState().ingestSnapshot(dto({ id: 'run-1', status: 'running' }));
    for (const type of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      useRunStore.getState().applyLifecycleEvent({ type, runId: 'run-1', seq: 1 });
    }
    expect(useRunStore.getState().getRun('run-1')?.status).toBe('running');
  });

  it('未见过后端快照的 run：事件不生成占位 RunSnapshot（不伪造数据）', () => {
    useRunStore.getState().applyLifecycleEvent(event('run.started', 1, 'run-ghost'));
    expect(useRunStore.getState().getRun('run-ghost')).toBeUndefined();
    expect(Object.keys(useRunStore.getState().runsById)).toEqual([]);
  });
});
