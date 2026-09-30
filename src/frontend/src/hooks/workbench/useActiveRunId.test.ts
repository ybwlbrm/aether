/**
 * T21 `useActiveRunId` —— Workbench 拿到真实 run 的唯一入口（TDD：先 RED）。
 *
 * 数据源：workspace.conversationId（store/workspace.ts）+ runStore.getRunsForConversation（T8）。
 * 解析规则：
 *   ① runStore.activeRunId 命中本会话的 run → 用它
 *   ② 否则回退到本会话的最后一个 run（runIdsByConversation 的追加序 = 摄入序）
 *   ③ 本会话没有任何 run → { runId: null, status: null }（不伪造 run）
 *
 * ## 为什么 store 接线不用 react-dom/server 断言
 * zustand v5 的 `useStore` 把 `getInitialState()` 作为 `useSyncExternalStore` 的
 * **server snapshot**，静态渲染只读得到 store 的初始态（永远空），断言不了摄入后的 run。
 * 因此接线部分直接用真实 store 的 reader（`getRunsForConversation`）驱动纯解析函数断言，
 * React 层只留一条"空态返回值形状"的静态渲染断言。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunStatus } from '@pacc/shared';

import type { RunDto } from '../../api/runs';
import { useRunStore } from '../../store/runStore';
import { useWorkspaceStore } from '../../store/workspace';
import { resolveActiveRun, useActiveRunId } from './useActiveRunId';

const CONV_A = 'conv-a';
const CONV_B = 'conv-b';
const TS = '2026-01-01T00:00:00.000Z';

function runDto(partial: Partial<RunDto> & Pick<RunDto, 'id' | 'conversationId'>): RunDto {
  return {
    status: 'running',
    mode: 'normal',
    rootAgentId: null,
    startedAt: TS,
    completedAt: null,
    endReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    error: null,
    metadata: {},
    createdAt: TS,
    ...partial,
  };
}

/** 走真实 store 摄入后端快照（runStore 不伪造 run：必须先有快照）。 */
function ingest(id: string, conversationId: string, status: RunStatus): void {
  useRunStore.getState().ingestSnapshot(runDto({ id, conversationId, status }));
}

/** hook 内部那一行的等价物：当前会话的 run（按摄入序）。 */
function currentConversationRuns(): ReturnType<ReturnType<typeof useRunStore.getState>['getRunsForConversation']> {
  const { conversationId } = useWorkspaceStore.getState();
  return useRunStore.getState().getRunsForConversation(conversationId ?? '');
}

beforeEach(() => {
  useRunStore.setState({ runsById: {}, runIdsByConversation: {}, activeRunId: null, lastSyncedAt: null });
  useWorkspaceStore.setState({ conversationId: null });
});

// ---------- 纯解析 ----------

describe('resolveActiveRun', () => {
  it('activeRunId 命中本会话的 run 时用该 run', () => {
    const runs = [
      runDto({ id: 'r1', conversationId: CONV_A, status: 'completed' }),
      runDto({ id: 'r2', conversationId: CONV_A, status: 'running' }),
    ];

    expect(resolveActiveRun(runs, 'r1')).toEqual({ runId: 'r1', status: 'completed' });
  });

  it('activeRunId 为空时回退到最后一个 run 及其状态', () => {
    const runs = [
      runDto({ id: 'r1', conversationId: CONV_A, status: 'completed' }),
      runDto({ id: 'r2', conversationId: CONV_A, status: 'running' }),
    ];

    expect(resolveActiveRun(runs, null)).toEqual({ runId: 'r2', status: 'running' });
  });

  it('activeRunId 指向别的会话时不串会话，回退到本会话最后一个 run', () => {
    const runs = [runDto({ id: 'r1', conversationId: CONV_A, status: 'failed' })];

    expect(resolveActiveRun(runs, 'other-run')).toEqual({ runId: 'r1', status: 'failed' });
  });

  it('没有任何 run 时返回 null（不伪造 run）', () => {
    expect(resolveActiveRun([], 'r1')).toEqual({ runId: null, status: null });
  });
});

// ---------- workspace.conversationId × runStore 接线 ----------

describe('useActiveRunId 的数据接线', () => {
  it('workspace.conversationId 无 active run 时回退到最后一个 run', () => {
    ingest('r1', CONV_A, 'completed');
    ingest('r2', CONV_A, 'running');
    useWorkspaceStore.getState().setConversationId(CONV_A);

    expect(currentConversationRuns().map(run => run.id)).toEqual(['r1', 'r2']);
    expect(resolveActiveRun(currentConversationRuns(), useRunStore.getState().activeRunId)).toEqual({
      runId: 'r2',
      status: 'running',
    });
  });

  it('setActiveRun 指定的 run 优先于回退', () => {
    ingest('r1', CONV_A, 'completed');
    ingest('r2', CONV_A, 'running');
    useWorkspaceStore.getState().setConversationId(CONV_A);
    useRunStore.getState().setActiveRun('r1');

    expect(resolveActiveRun(currentConversationRuns(), useRunStore.getState().activeRunId)).toEqual({
      runId: 'r1',
      status: 'completed',
    });
  });

  it('切换 conversationId 后只读该会话的 run', () => {
    ingest('r1', CONV_A, 'completed');
    ingest('r9', CONV_B, 'failed');
    useWorkspaceStore.getState().setConversationId(CONV_B);

    expect(resolveActiveRun(currentConversationRuns(), null)).toEqual({ runId: 'r9', status: 'failed' });
  });

  it('会话无 run 时不借用别的会话的 run', () => {
    ingest('r9', CONV_B, 'failed');
    useWorkspaceStore.getState().setConversationId(CONV_A);

    expect(currentConversationRuns()).toEqual([]);
    expect(resolveActiveRun(currentConversationRuns(), 'r9')).toEqual({ runId: null, status: null });
  });

  it('未选会话（conversationId 为 null）时返回全 null', () => {
    ingest('r9', CONV_B, 'failed');

    expect(currentConversationRuns()).toEqual([]);
    expect(resolveActiveRun(currentConversationRuns(), null)).toEqual({ runId: null, status: null });
  });
});

// ---------- hook 返回值契约 ----------

describe('useWorkbenchRunId hook 契约', () => {
  it('静态渲染返回可序列化的两字段结构（不抛错）', () => {
    function Probe(): ReturnType<typeof createElement> {
      const { runId, status } = useActiveRunId();
      return createElement('span', null, JSON.stringify({ runId, status }));
    }

    expect(renderToStaticMarkup(createElement(Probe))).toContain('{&quot;runId&quot;:null,&quot;status&quot;:null}');
  });
});
