import { describe, it, expect } from 'vitest';
import type { AgentEventEnvelope } from '@pacc/shared';
import {
  projectToolActivity,
  projectFileActivity,
  projectAgentTree,
  projectRetryState,
  hasFullToolPayload,
} from './projections';

/**
 * 投影测试（T9）。
 * 全部走 fixture 事件数组驱动 —— 投影函数是纯函数，不接触 activityStore。
 */

function env(partial: Omit<Partial<AgentEventEnvelope>, 'eventType'> & { eventType: string }): AgentEventEnvelope {
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

/** 完整工具事件（真实链路 buildToolPayload 产出：toolName + toolInput + inputDetail） */
function fullToolEvent(
  partial: Omit<Partial<AgentEventEnvelope>, 'eventType'> & { eventType: string },
): AgentEventEnvelope {
  return env(partial);
}

describe('projectToolActivity', () => {
  it('tool.started 与 tool.completed 通过 parentEventId 配对为单条 running→completed', () => {
    const entries = projectToolActivity([
      fullToolEvent({
        eventType: 'tool.started',
        seq: 1,
        eventId: 'tool-1',
        timestamp: '2026-08-24T00:00:01Z',
        tool: { toolName: 'read_file', toolInput: 'src/a.ts', inputDetail: { path: 'src/a.ts' } },
      }),
      fullToolEvent({
        eventType: 'tool.completed',
        seq: 2,
        eventId: 'tool-2',
        parentEventId: 'tool-1',
        timestamp: '2026-08-24T00:00:05Z',
        tool: { toolName: 'read_file', toolInput: 'src/a.ts', toolOutput: 'ok', outputDetail: 'ok' },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventId: 'tool-1',
      toolName: 'read_file',
      label: 'Read',
      kind: 'read',
      target: 'src/a.ts',
      status: 'completed',
      startedAt: '2026-08-24T00:00:01Z',
      endedAt: '2026-08-24T00:00:05Z',
      hasDetail: true,
    });
    // 锚点仍是 tool.started，parentEventId 指向改写状态的那一帧
    expect(entries[0].parentEventId).toBe('tool-2');
  });

  it('tool.progress 把配对条目保持为 running 且不落 endedAt', () => {
    const [entry] = projectToolActivity([
      fullToolEvent({ eventType: 'tool.started', seq: 1, eventId: 't1', timestamp: '2026-08-24T00:00:01Z', tool: { toolName: 'grep', toolInput: 'x' } }),
      fullToolEvent({ eventType: 'tool.progress', seq: 2, eventId: 't2', parentEventId: 't1', timestamp: '2026-08-24T00:00:09Z' }),
    ]);
    expect(entry?.status).toBe('running');
    expect(entry?.endedAt).toBeUndefined();
  });

  it('tool.error 把配对条目置为 error，tool.retry 置为 retry', () => {
    const [entry] = projectToolActivity([
      fullToolEvent({ eventType: 'tool.started', seq: 1, eventId: 't1', tool: { toolName: 'edit_file', toolInput: 'b.ts' } }),
      fullToolEvent({
        eventType: 'tool.retry',
        seq: 2,
        eventId: 't2',
        parentEventId: 't1',
        content: 'ENOENT，重试',
        tool: { toolName: 'edit_file', toolInput: 'b.ts' },
      }),
    ]);
    expect(entry?.status).toBe('retry');

    const [errored] = projectToolActivity([
      fullToolEvent({ eventType: 'tool.started', seq: 1, eventId: 't1', tool: { toolName: 'edit_file', toolInput: 'b.ts' } }),
      fullToolEvent({
        eventType: 'tool.error',
        seq: 2,
        eventId: 't2',
        parentEventId: 't1',
        tool: { toolName: 'edit_file', toolInput: 'b.ts', error: { message: 'require read first' } },
      }),
    ]);
    expect(errored?.status).toBe('error');
    expect(errored?.endedAt).toBe('2026-08-24T00:00:00Z');
  });

  it('runId 过滤：只投影该 run 的工具事件（v1 回退 sessionId:taskId 派生 runKey）', () => {
    const entries = projectToolActivity(
      [
        fullToolEvent({ eventType: 'tool.started', seq: 1, eventId: 'a1', tool: { toolName: 'read_file', toolInput: 'a.ts' } }),
        fullToolEvent({
          eventType: 'tool.started',
          seq: 2,
          eventId: 'b1',
          taskId: 't-2',
          tool: { toolName: 'read_file', toolInput: 'b.ts' },
        }),
      ],
      's-1:t-1',
    );
    expect(entries.map(e => e.target)).toEqual(['a.ts']);
  });

  it('无 parentEventId 的 tool.completed 独立成条（防御性兜底）', () => {
    const entries = projectToolActivity([
      fullToolEvent({ eventType: 'tool.completed', seq: 3, eventId: 'solo', tool: { toolName: 'grep', toolInput: 'x' } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: 'grep', status: 'completed', eventId: 'solo' });
  });
});

describe('projectFileActivity', () => {
  it('6 类文件工具映射为 read/write/edit/delete/mkdir/list 并提取路径', () => {
    const files = projectFileActivity([
      fullToolEvent({ eventType: 'tool.started', seq: 1, tool: { toolName: 'read_file', toolInput: 'src/a.ts', inputDetail: { path: 'src/a.ts' } } }),
      fullToolEvent({ eventType: 'tool.started', seq: 2, tool: { toolName: 'write_file', toolInput: 'src/b.ts', inputDetail: { path: 'src/b.ts' } } }),
      fullToolEvent({ eventType: 'tool.started', seq: 3, tool: { toolName: 'edit_file', toolInput: 'src/c.ts', inputDetail: { path: 'src/c.ts' } } }),
      fullToolEvent({ eventType: 'tool.started', seq: 4, tool: { toolName: 'delete_file', toolInput: 'src/d.ts', inputDetail: { path: 'src/d.ts' } } }),
      fullToolEvent({ eventType: 'tool.started', seq: 5, tool: { toolName: 'create_directory', toolInput: 'src/e', inputDetail: { path: 'src/e' } } }),
      fullToolEvent({ eventType: 'tool.started', seq: 6, tool: { toolName: 'list_files', toolInput: 'src', inputDetail: { path: 'src' } } }),
    ]);

    expect(files.map(f => f.op)).toEqual(['read', 'write', 'edit', 'delete', 'mkdir', 'list']);
    expect(files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e', 'src']);
    expect(files.every(f => f.truncated === false)).toBe(true);
  });

  it('非文件工具（grep / execute_command）不进入文件活动', () => {
    const files = projectFileActivity([
      fullToolEvent({ eventType: 'tool.started', seq: 1, tool: { toolName: 'grep', toolInput: 'needle', inputDetail: { pattern: 'needle' } } }),
      fullToolEvent({ eventType: 'tool.started', seq: 2, tool: { toolName: 'execute_command', toolInput: 'npm test', inputDetail: { command: 'npm test' } } }),
    ]);
    expect(files).toHaveLength(0);
  });

  it('toolInput 为 JSON 字符串时从 path 键解析路径', () => {
    const files = projectFileActivity([
      fullToolEvent({ eventType: 'tool.started', seq: 1, tool: { toolName: 'read_file', toolInput: '{"path":"src/json.ts"}' } }),
    ]);
    expect(files[0]?.path).toBe('src/json.ts');
  });

  it('toolOutput 以省略号结尾（buildToolPayload 裁剪）时 truncated 为 true', () => {
    const files = projectFileActivity([
      fullToolEvent({
        eventType: 'tool.completed',
        seq: 1,
        tool: { toolName: 'list_files', toolInput: 'src', toolOutput: 'a.ts…', outputDetail: 'a'.repeat(400) },
      }),
    ]);
    expect(files[0]?.truncated).toBe(true);
  });
});

describe('projectAgentTree', () => {
  it('agent.spawned 记录 spawnedBy，agent.completed / agent.failed 收敛终态', () => {
    const tree = projectAgentTree([
      env({ eventType: 'agent.started', seq: 1, agentId: 'sisyphus', content: '编排' }),
      env({ eventType: 'agent.spawned', seq: 2, agentId: 'sisyphus', metadata: { targetAgentId: 'explore' } }),
      env({ eventType: 'agent.completed', seq: 3, agentId: 'explore', content: '检索完成' }),
      env({ eventType: 'agent.failed', seq: 4, agentId: 'coder', content: '编译失败' }),
    ]);

    expect(tree['sisyphus']).toMatchObject({ status: 'running', label: '编排' });
    expect(tree['explore']).toMatchObject({ status: 'completed', label: '检索完成', spawnedBy: 'sisyphus' });
    expect(tree['coder']).toMatchObject({ status: 'error', label: '编译失败' });
    expect(tree['coder']?.spawnedBy).toBeUndefined();
  });

  it('agent.handoff 把目标 Agent 置为 running 并带交接说明', () => {
    const tree = projectAgentTree([
      env({ eventType: 'agent.handoff', seq: 1, agentId: 'sisyphus', metadata: { targetAgentId: 'hephaestus' }, content: '交给 Hephaestus 实现' }),
    ]);
    expect(tree['hephaestus']).toMatchObject({ status: 'running', label: '交给 Hephaestus 实现' });
  });

  it('agent.stopped / agent.retry 映射为 stopped / retry', () => {
    const tree = projectAgentTree([
      env({ eventType: 'agent.stopped', seq: 1, agentId: 'a' }),
      env({ eventType: 'agent.retry', seq: 2, agentId: 'b', content: '重试中' }),
    ]);
    expect(tree['a']?.status).toBe('stopped');
    expect(tree['b']?.status).toBe('retry');
  });

  it('无 agent 事件时返回空树', () => {
    expect(projectAgentTree([env({ eventType: 'task.started', seq: 1 })])).toEqual({});
  });
});

describe('projectRetryState', () => {
  it('attempt.started → retry.scheduled → retry.started 收敛 attempt / status / delayMs', () => {
    const state = projectRetryState([
      env({ eventType: 'attempt.started', seq: 1, metadata: { attempt: 2, maxAttempts: 3 } }),
      env({ eventType: 'retry.scheduled', seq: 2, metadata: { attempt: 2, delayMs: 1500 } }),
      env({ eventType: 'retry.started', seq: 3, metadata: { attempt: 2 } }),
    ]);
    expect(state).toEqual({ attempt: 2, status: 'retrying', delayMs: 1500 });
  });

  it('retry.completed 收敛为 completed，retry.exhausted 收敛为 failed', () => {
    expect(
      projectRetryState([
        env({ eventType: 'attempt.started', seq: 1, metadata: { attempt: 1 } }),
        env({ eventType: 'retry.completed', seq: 2, metadata: { attempt: 1 } }),
      ]),
    ).toEqual({ attempt: 1, status: 'completed' });

    expect(
      projectRetryState([
        env({ eventType: 'attempt.started', seq: 1, metadata: { attempt: 1 } }),
        env({ eventType: 'retry.exhausted', seq: 2, metadata: { attempt: 1 } }),
      ]),
    ).toEqual({ attempt: 1, status: 'failed' });
  });

  it('无 attempt/retry 事件时返回 null', () => {
    expect(projectRetryState([env({ eventType: 'agent.started', seq: 1 })])).toBeNull();
  });
});

describe('hasFullToolPayload（packed-replay 检测器）', () => {
  it('完整工具载荷（toolInput/inputDetail）返回 true', () => {
    expect(
      hasFullToolPayload([
        fullToolEvent({ eventType: 'tool.started', seq: 1, tool: { toolName: 'read_file', toolInput: 'a.ts', inputDetail: { path: 'a.ts' } } }),
      ]),
    ).toBe(true);
  });

  it('packed 行只有 content、没有 tool 载荷时返回 false', () => {
    // 复刻 stream.ts readEvents 的 packed 剥离：payload 只剩 { content }
    expect(
      hasFullToolPayload([
        env({ eventType: 'tool.started', seq: 1, eventId: 'p1', content: 'read_file a.ts' }),
        env({ eventType: 'tool.completed', seq: 2, eventId: 'p2', parentEventId: 'p1', content: 'ok' }),
      ]),
    ).toBe(false);
  });

  it('混有 packed 形态即判 false', () => {
    expect(
      hasFullToolPayload([
        fullToolEvent({ eventType: 'tool.started', seq: 1, tool: { toolName: 'read_file', toolInput: 'a.ts' } }),
        env({ eventType: 'tool.completed', seq: 2, eventId: 'p2', parentEventId: 'tool-x', content: 'ok' }),
      ]),
    ).toBe(false);
  });

  it('完全没有 tool 事件时返回 false（无可展开载荷，UI 走降级路径）', () => {
    expect(hasFullToolPayload([env({ eventType: 'agent.message.delta', seq: 1, content: 'hi' })])).toBe(false);
  });
});
