/**
 * T15 `useRunStream` —— 把一条 Run 绑定到真实传输的行为契约（TDD：先 RED）。
 *
 * 传输序列（runId 变更时）：
 *   catch-up(GET /runs/:id/events?afterSeq=) → live(GET /runs/:id/stream, Last-Event-ID=nextSeq)
 *   → 流关闭后 **恰好一次** GET /runs/:id 读权威终态。
 *
 * ## 为什么测 `createRunStreamSession` 而不是直接 render hook
 * 本仓库没有 DOM 测试环境（无 jsdom / happy-dom / @testing-library），组件测试一律走
 * `react-dom/server` 静态渲染（见 status-pill.test.tsx），那条路径**不执行 effect** ——
 * 而本 hook 的全部行为都在 effect 里。因此传输逻辑必须落在一层可独立驱动的核心上，
 * hook 本身只负责把它接到 `useSyncExternalStore`。本文件因此：
 *   - 逐条验证传输会话（即 hook effect 的全部行为，零删减）
 *   - 额外用一次静态渲染验证 hook 的返回值契约（不跑 effect，不发请求）
 *
 * 依赖全部 mock（`runsApi` 对象 + `streamRunEvents`），不发真实请求。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentEvent } from '@pacc/shared';

import { runsApi, type RunDto } from '../api/runs';
import { streamRunEvents, type RunStreamEvent, type StreamRunEventsOptions } from '../api/sse';
import { useActivityStore } from '../store/activityStore';
import { useRunStore } from '../store/runStore';
import { createRunStreamSession, useRunStream, type RunStreamSession } from './useRunStream';

// vi.mock 被 vitest 提升到所有 import 之前，静态 import 拿到的就是下面这层替身
vi.mock('../api/runs', () => ({
  runsApi: { fetchRunEvents: vi.fn(), getRun: vi.fn() },
}));

vi.mock('../api/sse', () => ({
  streamRunEvents: vi.fn(),
}));

// ---------- 夹具 ----------

const RUN_ID = 'run-1';
const CONV_ID = 'conv-1';
const TASK_ID = 'task-1';
const TS = '2026-01-01T00:00:00.000Z';

/** 每个夹具内联字面量 type，让 TS 对该分支的 payload 做真实校验（无 any、无类型断言）。 */
function startedEvent(seq: number): AgentEvent {
  return {
    eventId: `e-${seq}`,
    sessionId: CONV_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    agentId: 'sisyphus',
    timestamp: TS,
    seq,
    type: 'run.started',
    version: 2,
    payload: {},
  };
}

function completedEvent(seq: number): AgentEvent {
  return {
    eventId: `e-${seq}`,
    sessionId: CONV_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    agentId: 'sisyphus',
    timestamp: TS,
    seq,
    type: 'run.completed',
    version: 2,
    payload: { endReason: 'completed', tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
  };
}

function runDto(partial: Partial<RunDto> = {}): RunDto {
  return {
    id: RUN_ID,
    conversationId: CONV_ID,
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

function agentFrame(ev: AgentEvent): RunStreamEvent {
  return { kind: 'agent', eventId: String(ev.seq), eventName: ev.type, data: ev };
}

// ---------- 测试装置 ----------

interface StreamArgs {
  runId: string;
  options: StreamRunEventsOptions;
}

let streamArgs: StreamArgs[] = [];
let onStreamOpen: ((options: StreamRunEventsOptions) => void) | undefined;
/** 供 stream mock 在"开流瞬间"回读会话状态 —— catch-up 必须已经落地。 */
const probe: { session: RunStreamSession | null } = { session: null };

/** 流 mock：只登记参数并永挂起，由测试显式驱动 onEvent / onClose（模拟真实传输的推进）。 */
function installStream(): void {
  vi.mocked(streamRunEvents).mockImplementation((runId, options) => {
    streamArgs.push({ runId, options });
    onStreamOpen?.(options);
    return new Promise<void>(() => {});
  });
}

function startSession(): RunStreamSession {
  probe.session = createRunStreamSession(RUN_ID);
  return probe.session;
}

function liveOptions(): StreamRunEventsOptions {
  const opened = streamArgs.at(-1);
  if (opened === undefined) throw new Error('live stream was never opened');
  return opened.options;
}

/** 让 mock 的 promise 回调与 await 链跑完（不用 sleep 猜时间，只排空微任务队列）。 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

/** activityStore 是 v1 envelope 协议、按 conversationId 读取（Workbench/Thread 的读法）。 */
function ingestedSeqs(): number[] {
  return useActivityStore.getState().getEvents(CONV_ID).map(ev => ev.seq);
}

beforeEach(() => {
  vi.clearAllMocks();
  useRunStore.setState({ runsById: {}, runIdsByConversation: {}, activeRunId: null, lastSyncedAt: null });
  // 全量重置：clearConv 不清 _eventIdentitySetByRun（既有实现），残留的身份集合会让后续用例的
  // 同 eventId 事件被 appendEvent 静默丢弃 → 用例间互相污染。
  useActivityStore.setState({
    eventsByRun: {},
    cursorByRun: {},
    _eventIdentitySetByRun: {},
    taskCardCache: {},
    reasoningCache: {},
    runMetaById: {},
    runsByConversation: {},
  });
  // runStore 只接受已知 run（不伪造占位快照）：先喂一份后端快照，事件才有投影对象
  useRunStore.getState().ingestSnapshot(runDto({ status: 'created' }));
  streamArgs = [];
  onStreamOpen = undefined;
  probe.session = null;
  vi.mocked(runsApi.getRun).mockResolvedValue(
    runDto({ status: 'completed', completedAt: TS, endReason: 'completed' }),
  );
  installStream();
});

// ---------- 传输序列 ----------

describe('useRunStream 传输会话', () => {
  it('(a) 先应用 catch-up 页，再打开 live 流（第一帧前历史已落地）', async () => {
    const order: string[] = [];
    let seqAtLiveOpen = -1;
    vi.mocked(runsApi.fetchRunEvents).mockImplementation(async () => {
      order.push('catch-up');
      return { events: [startedEvent(1), startedEvent(2)], nextSeq: 2 };
    });
    onStreamOpen = options => {
      order.push('live');
      seqAtLiveOpen = probe.session?.getSnapshot().lastSeq ?? -1;
      expect(options.lastEventId).toBe('2');
    };

    const session = startSession();
    await settle();

    expect(order).toEqual(['catch-up', 'live']);
    expect(seqAtLiveOpen).toBe(2);
    expect(session.getSnapshot().lastSeq).toBe(2);
    expect(ingestedSeqs()).toEqual([1, 2]);
  });

  it('(b) 丢弃 seq 不超过游标的 live 帧（重放去重）', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [startedEvent(1), startedEvent(2)], nextSeq: 2 });
    const session = startSession();
    await settle();

    const { onEvent } = liveOptions();
    onEvent(agentFrame(startedEvent(3)));
    expect(session.getSnapshot().lastSeq).toBe(3);

    onEvent(agentFrame(startedEvent(2))); // 重放帧：seq <= 游标 → 丢弃，游标不得回退
    expect(session.getSnapshot().lastSeq).toBe(3);

    onEvent(agentFrame(completedEvent(4)));
    expect(session.getSnapshot().lastSeq).toBe(4);

    // 重放的终态帧同样不得再次推进（否则断线续传会把状态机来回拽）
    onEvent(agentFrame(completedEvent(4)));
    expect(session.getSnapshot().lastSeq).toBe(4);
    expect(session.getSnapshot().status).toBe('completed');
    expect(ingestedSeqs()).toEqual([1, 2, 3, 4]);
  });

  it('(c) 流关闭时恰好读取一次 getRun 权威终态', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [], nextSeq: 0 });
    const session = startSession();
    await settle();

    const { onClose } = liveOptions();
    onClose({ reason: 'completed', lastEventId: '0' });
    onClose({ reason: 'completed', lastEventId: '0' }); // 传输层重复回调：flag 必须挡住第二次
    await settle();

    expect(runsApi.getRun).toHaveBeenCalledTimes(1);
    expect(runsApi.getRun).toHaveBeenCalledWith(RUN_ID);
    expect(session.getSnapshot().status).toBe('completed');
    expect(useRunStore.getState().getRun(RUN_ID)?.status).toBe('completed');
    expect(session.getSnapshot().isLive).toBe(false);
  });

  it('(d) retry() 从最后已知 seq 重开（重新走 catch-up → live）', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [startedEvent(1), startedEvent(2)], nextSeq: 2 });
    const session = startSession();
    await settle();
    liveOptions().onEvent(agentFrame(startedEvent(3)));

    session.retry();
    await settle();

    expect(runsApi.fetchRunEvents).toHaveBeenNthCalledWith(1, RUN_ID, { afterSeq: 0 });
    expect(runsApi.fetchRunEvents).toHaveBeenNthCalledWith(2, RUN_ID, { afterSeq: 3 });
    expect(streamArgs).toHaveLength(2);
    expect(streamArgs[1].options.lastEventId).toBe('3');
    expect(session.getSnapshot().error).toBeNull();
  });

  it('(e) dispose 时 abort 流且不发 getRun 快照', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [], nextSeq: 0 });
    const session = startSession();
    await settle();
    const { signal, onClose } = liveOptions();

    session.dispose();
    expect(signal.aborted).toBe(true);

    onClose({ reason: 'aborted' });
    await settle();
    expect(runsApi.getRun).not.toHaveBeenCalled();
  });

  it('(f) 传输失败时暴露 error 并保持 retry 可调，而不是伪造终态', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [], nextSeq: 0 });
    const session = startSession();
    await settle();

    const { onError, onClose } = liveOptions();
    onError(new Error('SSE 流中断'));
    onClose({ reason: 'failed' });
    await settle();

    expect(session.getSnapshot().error).toBeInstanceOf(Error);
    expect(session.getSnapshot().error?.message).toBe('SSE 流中断');
    expect(session.getSnapshot().isLive).toBe(false);

    session.retry();
    await settle();
    expect(streamArgs).toHaveLength(2);
    expect(session.getSnapshot().error).toBeNull();
  });

  it('(g) 首帧之前 isCatchingUp=true，live 帧到达后转 false', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [startedEvent(1)], nextSeq: 1 });
    const session = startSession();

    expect(session.getSnapshot().isCatchingUp).toBe(true);
    await settle();
    // 流已打开但首帧未到：仍在补齐（开流本身不证明拿到了 live 数据）
    expect(session.getSnapshot().isCatchingUp).toBe(true);

    liveOptions().onEvent(agentFrame(startedEvent(2)));
    expect(session.getSnapshot().isCatchingUp).toBe(false);
  });

  it('(h) live 帧到达后 isLive=true，流关闭后回 false', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [], nextSeq: 0 });
    const session = startSession();
    expect(session.getSnapshot().isLive).toBe(false);
    await settle();

    const { onEvent, onClose } = liveOptions();
    onEvent(agentFrame(startedEvent(1)));
    expect(session.getSnapshot().isLive).toBe(true);

    onClose({ reason: 'completed' });
    expect(session.getSnapshot().isLive).toBe(false);
  });

  it('同一条事件同时喂给 runStore（状态投影）与 activityStore（v1 envelope 摄入）', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [startedEvent(1)], nextSeq: 1 });
    const session = startSession();
    await settle();
    liveOptions().onEvent(agentFrame(completedEvent(2)));

    // runStore：状态由事件推进，游标单调
    expect(useRunStore.getState().getRun(RUN_ID)?.status).toBe('completed');
    expect(useRunStore.getState().getRun(RUN_ID)?.lastEventSeq).toBe(2);
    // activityStore：Workbench/Thread 读的 v1 envelope 投影
    expect(ingestedSeqs()).toEqual([1, 2]);
    expect(useActivityStore.getState().getEvents(CONV_ID).map(ev => ev.eventType)).toEqual([
      'session.started',
      'session.closed',
    ]);
    // hook 自己不另存状态机：status 直接回读 runStore
    expect(session.getSnapshot().status).toBe('completed');
  });

  it('未知事件名（sse 层 kind:unknown）不进入任一 store，也不中断流', async () => {
    vi.mocked(runsApi.fetchRunEvents).mockResolvedValue({ events: [], nextSeq: 0 });
    const session = startSession();
    await settle();

    const { onEvent } = liveOptions();
    onEvent({ kind: 'unknown', eventId: '9', eventName: 'run.budget_exceeded', data: { nope: true } });
    onEvent(agentFrame(startedEvent(1)));

    expect(ingestedSeqs()).toEqual([1]);
    expect(session.getSnapshot().lastSeq).toBe(1);
  });
});

// ---------- hook 返回值契约 ----------

describe('useRunStream hook 契约', () => {
  it('未绑定 run 时返回完整的空快照与可调 retry（不抛错、不发请求）', () => {
    function Probe(): ReturnType<typeof createElement> {
      const { status, lastSeq, isLive, isCatchingUp, error, retry } = useRunStream(null);
      return createElement(
        'span',
        { className: 'probe' },
        JSON.stringify({ status, lastSeq, isLive, isCatchingUp, error, retry: typeof retry }),
      );
    }

    const markup = renderToStaticMarkup(createElement(Probe));

    // 静态渲染会把 " 转义成 &quot;，这里按渲染后的真实产物断言
    expect(markup).toContain(
      '{&quot;status&quot;:null,&quot;lastSeq&quot;:0,&quot;isLive&quot;:false,&quot;isCatchingUp&quot;:false,&quot;error&quot;:null,&quot;retry&quot;:&quot;function&quot;}',
    );
    expect(streamArgs).toHaveLength(0);
    expect(runsApi.fetchRunEvents).not.toHaveBeenCalled();
  });
});
