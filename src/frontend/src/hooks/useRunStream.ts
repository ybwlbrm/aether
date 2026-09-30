/**
 * T15 `useRunStream` —— 把一条 Run 绑定到真实传输。
 *
 * ## 唯一数据来源（不变量）
 * 权威状态只有两个入口，二者都是**真实后端数据**，没有乐观值、没有本地计时器推断：
 *   1. `runsApi.getRun(runId)` —— 服务端 RunDto 快照（`runStore.ingestSnapshot`）
 *   2. 真实 v2 `AgentEvent` 流（`runStore.applyLifecycleEvent`）
 * 本 hook **不持有自己的状态机**：`status` 每次都从 `runStore` 回读，因此不可能与 store 漂移。
 *
 * ## 传输序列（runId 变更 / retry 时）
 *   ① catch-up：`runsApi.fetchRunEvents(runId, { afterSeq: lastKnownSeq })` 摄入历史页，游标取 nextSeq
 *   ② live：`streamRunEvents(runId, { lastEventId: nextSeq, signal })`
 *   ③ 流关闭：读一次 `runsApi.getRun(runId)` 拿权威终态
 *
 * ③ 是**强制项而非防御代码**：服务端推完终态事件即主动关闭连接，而 `run.budget_exceeded`
 * 没有对应的 v2 事件帧（T3 发现）—— close + 快照是唯一能拿到完整终态的组合。
 * `aborted`（我们主动取消：卸载 / runId 变更）不发快照。
 *
 * ## 事件扇出：一条事件同时进两个 store
 * - `runStore.applyLifecycleEvent(ev)`：按 `ev.runId` 精确索引，驱动状态 / retryState
 * - `activityStore.appendEvent(ev.sessionId, toLegacy(ev))`：Workbench / Thread / 通知读的 v1 投影。
 *   v2 `BaseEvent.sessionId` 即 conversationId（shared 协议），因此 convId 取事件自带值：
 *   会话切换后仍在飞的旧事件不会写进新会话的索引。
 *
 * ## 为什么拆成 session + hook 两层
 * 本仓库没有 DOM 测试环境，组件测试走 `react-dom/server` 静态渲染（不执行 effect）——
 * 而本 hook 的全部行为都在 effect 里。传输逻辑因此落在一层可独立驱动的核心
 * （`createRunStreamSession`），hook 只负责把它接到 `useSyncExternalStore`。见 useRunStream.test.ts。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { toLegacy, type AgentEvent, type RunStatus } from '@pacc/shared';
import { runsApi } from '../api/runs';
import { streamRunEvents } from '../api/sse';
import { useActivityStore } from '../store/activityStore';
import { useRunStore } from '../store/runStore';

/** 会话对外暴露的权威视图。全部字段为快照值，`getSnapshot` 返回引用稳定。 */
export interface RunStreamSnapshot {
  /** 权威状态：只来自 runStore（事件推进 / getRun 快照）；无快照则 null，不伪造。 */
  status: RunStatus | null;
  /** 已消费到的最大 seq（去重游标 + Last-Event-ID 续传游标）。 */
  lastSeq: number;
  /** live 流是否处于连接态。 */
  isLive: boolean;
  /** 是否还在补齐：建会话起为 true，收到第一帧 live（或流结束 / 失败）后转 false。 */
  isCatchingUp: boolean;
  error: Error | null;
}

export interface RunStreamSession {
  getSnapshot: () => RunStreamSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** 从最后已知 seq 重开（重新走 catch-up → live）。 */
  retry: () => void;
  /** 卸载：abort 流、清监听。不发终态快照（见文件头 ③）。 */
  dispose: () => void;
}

export interface UseRunStreamResult extends RunStreamSnapshot {
  retry: () => void;
}

const NOOP_UNSUBSCRIBE = (): (() => void) => () => {};

/** 没有 run 可绑定：isCatchingUp 为 false（无事可做）。 */
const IDLE_NO_RUN: RunStreamSnapshot = { status: null, lastSeq: 0, isLive: false, isCatchingUp: false, error: null };
/** 刚切换 runId、session 尚未建立：仍需补齐，避免闪一帧"不忙"。 */
const IDLE_PENDING: RunStreamSnapshot = { status: null, lastSeq: 0, isLive: false, isCatchingUp: true, error: null };

/** `useSyncExternalStore` 要求 getSnapshot 引用稳定：值相同时不得产生新对象。 */
function isSameSnapshot(a: RunStreamSnapshot, b: RunStreamSnapshot): boolean {
  return (
    a.status === b.status &&
    a.lastSeq === b.lastSeq &&
    a.isLive === b.isLive &&
    a.isCatchingUp === b.isCatchingUp &&
    a.error === b.error
  );
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * 建立一条 Run 的传输会话：catch-up → live → 关闭读终态。
 *
 * 立即启动 catch-up（返回时传输已在飞）。`retry` 复用同一条会话、沿用同一个游标。
 */
export function createRunStreamSession(runId: string): RunStreamSession {
  const listeners = new Set<() => void>();

  let snapshot: RunStreamSnapshot = {
    ...IDLE_PENDING,
    status: useRunStore.getState().getRun(runId)?.status ?? null,
  };
  let lastSeq = 0;
  /** 传输代次：每次重开自增。旧代次的回调（含 abort 后的 onClose）一律作废。 */
  let generation = 0;
  let disposed = false;
  let terminalSnapshotTaken = false;
  let controller: AbortController | null = null;

  const patch = (next: Partial<RunStreamSnapshot>): void => {
    const merged: RunStreamSnapshot = { ...snapshot, ...next };
    if (isSameSnapshot(snapshot, merged)) return;
    snapshot = merged;
    for (const listener of listeners) listener();
  };

  const isStale = (attempt: number): boolean => disposed || attempt !== generation;

  /** 状态只从 runStore 回读：本 hook 不持有第二份状态，避免两处真相。 */
  const statusFromStore = (): RunStatus | null => useRunStore.getState().getRun(runId)?.status ?? null;

  /**
   * 单条 v2 事件 → 两个 store。
   * seq 单调递增，`seq <= lastSeq` 的重放帧直接丢弃（catch-up 与 live 天然会重叠）。
   */
  const ingest = (ev: AgentEvent): void => {
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    useRunStore.getState().applyLifecycleEvent(ev);
    useActivityStore.getState().appendEvent(ev.sessionId, toLegacy(ev));
    patch({ lastSeq, status: statusFromStore() });
  };

  /** 流关闭后的权威终态读取（强制项，见文件头 ③）。 */
  const readTerminalSnapshot = async (attempt: number): Promise<void> => {
    // flag 在 await 之前落定 → 重复 close 只可能读到一次
    if (terminalSnapshotTaken) return;
    terminalSnapshotTaken = true;
    try {
      const dto = await runsApi.getRun(runId);
      if (isStale(attempt)) return;
      useRunStore.getState().ingestSnapshot(dto, lastSeq);
      patch({ status: statusFromStore() });
    } catch (cause: unknown) {
      if (isStale(attempt)) return;
      patch({ error: toError(cause) });
    }
  };

  const start = async (fromSeq: number): Promise<void> => {
    const attempt = ++generation;
    const current = new AbortController();
    controller = current;
    terminalSnapshotTaken = false;
    patch({ isLive: false, isCatchingUp: true, error: null });
    try {
      // ① catch-up：一页历史。服务端默认 limit=1000，超出部分由 ② 的 live 流按 seq 续发补齐
      //    （lastEventId = nextSeq ⇒ 服务端只发 seq > nextSeq），因此单页不会丢事件。
      const page = await runsApi.fetchRunEvents(runId, { afterSeq: fromSeq });
      if (isStale(attempt)) return;
      for (const ev of page.events) ingest(ev);
      lastSeq = Math.max(lastSeq, page.nextSeq);
      patch({ lastSeq });

      // ② live。开流只代表已连接，不代表拿到了 live 数据 —— isCatchingUp 保持 true 直到第一帧
      patch({ isLive: true });
      await streamRunEvents(runId, {
        lastEventId: String(lastSeq),
        signal: current.signal,
        onEvent: frame => {
          if (isStale(attempt)) return;
          // sse 层已把未知事件名 / 非法载荷归入 kind:'unknown'（如闭集外的 run.budget_exceeded）：
          // 它们无法在零断言前提下进入两个 store 的闭集，跳过即可 —— 终态由 ③ 的快照兜底。
          if (frame.kind === 'agent') ingest(frame.data);
          patch({ isCatchingUp: false });
        },
        onError: error => {
          if (isStale(attempt)) return;
          patch({ error, isCatchingUp: false });
        },
        onClose: info => {
          if (isStale(attempt)) return;
          patch({ isCatchingUp: false, isLive: false });
          // aborted = 我们主动取消（卸载 / runId 变更 / retry），不发终态快照
          if (info.reason !== 'aborted') void readTerminalSnapshot(attempt);
        },
      });
    } catch (cause: unknown) {
      if (isStale(attempt)) return;
      patch({ error: toError(cause), isCatchingUp: false, isLive: false });
    }
  };

  const retry = (): void => {
    if (disposed) return;
    controller?.abort();
    void start(lastSeq);
  };

  void start(0);

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    retry,
    dispose: () => {
      disposed = true;
      controller?.abort();
      listeners.clear();
    },
  };
}

/**
 * 把一条 Run 绑定到真实传输。
 *
 * `runId` 变更 / 组件卸载即自动切换或销毁会话；同一 runId 多次渲染复用同一条会话。
 * 返回值形状稳定，可直接喂给状态标签 / spinner / 停止按钮。
 */
export function useRunStream(runId: string | null): UseRunStreamResult {
  const [entry, setEntry] = useState<{ runId: string; session: RunStreamSession } | null>(null);

  useEffect(() => {
    if (runId === null) {
      setEntry(null);
      return;
    }
    const session = createRunStreamSession(runId);
    setEntry({ runId, session });
    return () => { session.dispose(); };
  }, [runId]);

  // runId 已切换、effect 还没建立新会话的那一帧：返回 idle 而不是上一条 run 的快照
  const session = entry !== null && entry.runId === runId ? entry.session : null;
  const subscribe = useCallback(
    (listener: () => void): (() => void) => session?.subscribe(listener) ?? NOOP_UNSUBSCRIBE,
    [session],
  );
  const getSnapshot = useCallback(
    (): RunStreamSnapshot => session?.getSnapshot() ?? (runId === null ? IDLE_NO_RUN : IDLE_PENDING),
    [session, runId],
  );
  const retry = useCallback((): void => { session?.retry(); }, [session]);

  return { ...useSyncExternalStore(subscribe, getSnapshot, getSnapshot), retry };
}
