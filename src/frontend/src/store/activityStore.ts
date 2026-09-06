import type { AgentEventEnvelope, AgentEventType, EventStatus } from '@pacc/shared';
import { create } from 'zustand';

/**
 * Activity Store — Event-driven Agent Activity Stream 的前端状态层。
 * - 单一事件源：eventsByRun[runId] 按 seq 有序
 * - appendEvent 按 seq 去重追加（SSE 实时 + 回放共用）
 * - 投影函数（纯计算）：消息列表 / Activity Stream / 任务进度
 * - runsByConversation: 聚合索引（conversation 不再作为事件事实源）
 */

export interface TaskProgressState {
  taskId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  /** 当前处理步骤（工具/状态事件摘要） */
  currentStep?: string;
  steps: string[];
  startedAt?: string;
  completedAt?: string;
}

/** 任务卡步骤行（Agent 或工具，带状态） */
export interface TaskCardStep {
  key: string;
  agentId: string;
  label: string;
  kind: 'agent' | 'tool';
  state: 'running' | 'ok' | 'error';
  startedSeq: number;
  agentType?: string;
}

/** 任务进度卡投影（对齐 harness 的任务生命周期 UI） */
export interface TaskCard {
  taskId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  /** 结束原因（stop/tool_calls/max-tokens/error/aborted/max_turns/completed） */
  endReason?: string;
  steps: TaskCardStep[];
  /** 最新一条进行中的思考（流式 thinking 输出） */
  activeReasoning: string;
  /** 子 Agent 输出累积（agent.message.delta，按 agentId，供进行中展示） */
  agentOutputs: Map<string, string>;
  /** 任务执行计划（task.plan 事件内容，对齐 harness 的 plan 模式） */
  plan?: string;
}

/** 增量投影缓存：每个 run 的 TaskCard 状态 + 最后处理的 seq */
interface TaskCardCacheEntry {
  card: TaskCard | null;
  lastProcessedSeq: number;
}

/** Run 元数据（用于聚合索引与调试） */
export interface RunMeta {
  runId: string;
  conversationId: string;
  taskId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  endReason?: string;
}

/** 推理缓存：每个 run 下按 agentId 隔离的 reasoning 累积 */
interface ReasoningCacheEntry {
  byAgent: Map<string, string>;
  lastProcessedSeq: number;
}

interface ActivityState {
  // 核心状态：按 runId 索引
  eventsByRun: Record<string, AgentEventEnvelope[]>;
  cursorByRun: Record<string, number>;
  taskCardCache: Record<string, TaskCardCacheEntry>;
  reasoningCache: Record<string, ReasoningCacheEntry>;
  runMetaById: Record<string, RunMeta>;
  runsByConversation: Record<string, string[]>; // 聚合索引：convId -> runId[]

  // 核心操作
  appendEvent: (convId: string, event: AgentEventEnvelope) => void;
  appendEvents: (convId: string, events: AgentEventEnvelope[]) => void;
  replaceEvents: (convId: string, events: AgentEventEnvelope[]) => void;
  clearConv: (convId: string) => void;
  clearRun: (runId: string) => void;

  // 读取接口（保留 conv 便捷方法，内部按 run 聚合）
  getEvents: (convId: string) => AgentEventEnvelope[];
  getEventsByRun: (runId: string) => AgentEventEnvelope[];
  getLastSeq: (convId: string) => number;
  getLastSeqByRun: (runId: string) => number;
  getRunsForConversation: (convId: string) => string[];
  getRunMeta: (runId: string) => RunMeta | undefined;

  // 投影：Activity Stream 条目列表
  projectActivity: (convId: string) => AgentEventEnvelope[];
  projectActivityByRun: (runId: string) => AgentEventEnvelope[];
  // 投影：任务进度
  projectTaskProgress: (convId: string) => TaskProgressState | null;
  projectTaskProgressByRun: (runId: string) => TaskProgressState | null;
  // 投影：最终回答文本（agent.message.delta 累积，按 agentId 分）
  projectReplies: (convId: string) => Map<string, string>;
  projectRepliesByRun: (runId: string) => Map<string, string>;
  // 投影：任务进度卡（task 生命周期 + 步骤链 + 流式思考 + Agent 输出）
  projectTaskCard: (convId: string) => TaskCard | null;
  projectTaskCardByRun: (runId: string) => TaskCard | null;
}

function sortBySeq(events: AgentEventEnvelope[]): AgentEventEnvelope[] {
  return events.slice().sort((a, b) => a.seq - b.seq);
}

/**
 * P0-17/EVT-003: 统一事件身份（去重键）。
 * 优先级：eventId（全局唯一 UUID）→ 缺失时回退 sessionId+taskId+seq。
 * appendEvent 与 appendEvents 必须使用同一身份函数，否则重放/实时双入口行为不一致。
 */
export function getEventIdentity(ev: AgentEventEnvelope): string {
  return ev.eventId || `${ev.sessionId}::${ev.taskId}::${ev.seq}`;
}

/**
 * 从 envelope 推导 runKey。
 * 优先使用 envelope.runId（v2 协议）；v1 协议用 sessionId+taskId 组合生成稳定 run key。
 */
function getRunKey(ev: AgentEventEnvelope): string {
  // v2 协议有 runId 字段（通过 metadata 或扩展字段）
  const runId = (ev as any).runId;
  if (runId && typeof runId === 'string') {
    return runId;
  }
  // v1 兼容：用 sessionId + taskId 组合
  return `${ev.sessionId}:${ev.taskId}`;
}

/**
 * 从 envelope 推导 conversationId（用于维护 runsByConversation 索引）
 */
function getConversationId(ev: AgentEventEnvelope): string {
  return ev.sessionId;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  eventsByRun: {},
  cursorByRun: {},
  taskCardCache: {},
  reasoningCache: {},
  runMetaById: {},
  runsByConversation: {},

  appendEvent: (convId, event) => {
    const runKey = getRunKey(event);
    const list = get().eventsByRun[runKey] ?? [];
    // P0-08/EVT-003：去重身份统一走 getEventIdentity（eventId 优先，回退 sessionId+taskId+seq）
    const identity = getEventIdentity(event);
    const isDup = list.some(e => getEventIdentity(e) === identity);
    if (isDup) return;
    list.push(event);
    const sorted = sortBySeq(list);
    const maxSeq = sorted.length > 0 ? sorted[sorted.length - 1].seq : (get().cursorByRun[runKey] ?? 0);

    set(s => {
      // 更新 runsByConversation 聚合索引
      const runs = s.runsByConversation[convId] ?? [];
      const runExists = runs.includes(runKey);
      const newRuns = runExists ? runs : [...runs, runKey];

      // 更新 runMeta
      const existingMeta = s.runMetaById[runKey];
      const newMeta: RunMeta = existingMeta ?? {
        runId: runKey,
        conversationId: convId,
        taskId: event.taskId,
        sessionId: event.sessionId,
        startedAt: event.timestamp,
        status: 'running',
      };
      // 如果是任务边界事件，更新结束状态
      if (event.eventType === 'task.completed' || event.eventType === 'task.failed' || event.eventType === 'task.cancelled') {
        newMeta.status = event.eventType === 'task.failed' ? 'failed' : event.eventType === 'task.cancelled' ? 'cancelled' : 'completed';
        newMeta.endedAt = event.timestamp;
        newMeta.endReason = event.endReason;
      }

      return {
        eventsByRun: { ...s.eventsByRun, [runKey]: sorted },
        cursorByRun: { ...s.cursorByRun, [runKey]: maxSeq },
        taskCardCache: { ...s.taskCardCache, [runKey]: { ...s.taskCardCache[runKey], lastProcessedSeq: -1 } },
        reasoningCache: { ...s.reasoningCache, [runKey]: { ...s.reasoningCache[runKey], lastProcessedSeq: -1 } },
        runMetaById: { ...s.runMetaById, [runKey]: newMeta },
        runsByConversation: { ...s.runsByConversation, [convId]: newRuns },
      };
    });
  },

  appendEvents: (convId, events) => {
    if (events.length === 0) return;
    // 按 runKey 分组处理
    const byRun = new Map<string, AgentEventEnvelope[]>();
    for (const ev of events) {
      const runKey = getRunKey(ev);
      const arr = byRun.get(runKey) ?? [];
      arr.push(ev);
      byRun.set(runKey, arr);
    }

    set(s => {
      const newEventsByRun = { ...s.eventsByRun };
      const newCursorByRun = { ...s.cursorByRun };
      const newTaskCardCache = { ...s.taskCardCache };
      const newReasoningCache = { ...s.reasoningCache };
      const newRunMetaById = { ...s.runMetaById };
      const newRunsByConversation = { ...s.runsByConversation };

      for (const [runKey, runEvents] of byRun) {
        const list = newEventsByRun[runKey] ?? [];
        const known = new Set(list.map(e => getEventIdentity(e)));
        for (const ev of runEvents) {
          const key = getEventIdentity(ev);
          if (known.has(key)) continue;
          known.add(key);
          list.push(ev);
        }
        const sorted = sortBySeq(list);
        const maxSeq = sorted.length > 0 ? sorted[sorted.length - 1].seq : (newCursorByRun[runKey] ?? 0);

        newEventsByRun[runKey] = sorted;
        newCursorByRun[runKey] = maxSeq;
        newTaskCardCache[runKey] = { ...newTaskCardCache[runKey], lastProcessedSeq: -1 };
        newReasoningCache[runKey] = { ...newReasoningCache[runKey], lastProcessedSeq: -1 };

        // 更新 runsByConversation 聚合索引
        const runs = newRunsByConversation[convId] ?? [];
        if (!runs.includes(runKey)) {
          newRunsByConversation[convId] = [...runs, runKey];
        }

        // 更新 runMeta
        const existingMeta = newRunMetaById[runKey];
        const firstEv = runEvents[0];
        const newMeta: RunMeta = existingMeta ?? {
          runId: runKey,
          conversationId: convId,
          taskId: firstEv.taskId,
          sessionId: firstEv.sessionId,
          startedAt: firstEv.timestamp,
          status: 'running',
        };
        // 检查是否有任务边界事件
        for (const ev of runEvents) {
          if (ev.eventType === 'task.completed' || ev.eventType === 'task.failed' || ev.eventType === 'task.cancelled') {
            newMeta.status = ev.eventType === 'task.failed' ? 'failed' : ev.eventType === 'task.cancelled' ? 'cancelled' : 'completed';
            newMeta.endedAt = ev.timestamp;
            newMeta.endReason = ev.endReason;
            break;
          }
        }
        newRunMetaById[runKey] = newMeta;
      }

      return {
        eventsByRun: newEventsByRun,
        cursorByRun: newCursorByRun,
        taskCardCache: newTaskCardCache,
        reasoningCache: newReasoningCache,
        runMetaById: newRunMetaById,
        runsByConversation: newRunsByConversation,
      };
    });
  },

  replaceEvents: (convId, events) => {
    // 按 runKey 分组
    const byRun = new Map<string, AgentEventEnvelope[]>();
    for (const ev of events) {
      const runKey = getRunKey(ev);
      const arr = byRun.get(runKey) ?? [];
      arr.push(ev);
      byRun.set(runKey, arr);
    }

    set(s => {
      // 先清除该 conversation 下所有旧 run 的数据
      const oldRunIds = s.runsByConversation[convId] ?? [];
      const newEventsByRun = { ...s.eventsByRun };
      const newCursorByRun = { ...s.cursorByRun };
      const newTaskCardCache = { ...s.taskCardCache };
      const newReasoningCache = { ...s.reasoningCache };
      const newRunMetaById = { ...s.runMetaById };

      for (const runId of oldRunIds) {
        delete newEventsByRun[runId];
        delete newCursorByRun[runId];
        delete newTaskCardCache[runId];
        delete newReasoningCache[runId];
        delete newRunMetaById[runId];
      }

      const newRunsByConversation = { ...s.runsByConversation };
      // 重置该 conversation 的 runs 列表
      newRunsByConversation[convId] = [];

      for (const [runKey, runEvents] of byRun) {
        const sorted = sortBySeq(runEvents);
        const maxSeq = sorted.length > 0 ? sorted[sorted.length - 1].seq : 0;

        newEventsByRun[runKey] = sorted;
        newCursorByRun[runKey] = maxSeq;
        newTaskCardCache[runKey] = { card: null, lastProcessedSeq: -1 };
        newReasoningCache[runKey] = { byAgent: new Map(), lastProcessedSeq: -1 };

        // 更新 runsByConversation 聚合索引
        const runs = newRunsByConversation[convId] ?? [];
        if (!runs.includes(runKey)) {
          newRunsByConversation[convId] = [...runs, runKey];
        }

        // 更新 runMeta
        const firstEv = runEvents[0];
        const newMeta: RunMeta = {
          runId: runKey,
          conversationId: convId,
          taskId: firstEv.taskId,
          sessionId: firstEv.sessionId,
          startedAt: firstEv.timestamp,
          status: 'running',
        };
        for (const ev of runEvents) {
          if (ev.eventType === 'task.completed' || ev.eventType === 'task.failed' || ev.eventType === 'task.cancelled') {
            newMeta.status = ev.eventType === 'task.failed' ? 'failed' : ev.eventType === 'task.cancelled' ? 'cancelled' : 'completed';
            newMeta.endedAt = ev.timestamp;
            newMeta.endReason = ev.endReason;
            break;
          }
        }
        newRunMetaById[runKey] = newMeta;
      }

      return {
        eventsByRun: newEventsByRun,
        cursorByRun: newCursorByRun,
        taskCardCache: newTaskCardCache,
        reasoningCache: newReasoningCache,
        runMetaById: newRunMetaById,
        runsByConversation: newRunsByConversation,
      };
    });
  },

  clearConv: (convId) => {
    set(s => {
      const runIds = s.runsByConversation[convId] ?? [];
      const newEventsByRun = { ...s.eventsByRun };
      const newCursorByRun = { ...s.cursorByRun };
      const newTaskCardCache = { ...s.taskCardCache };
      const newReasoningCache = { ...s.reasoningCache };
      const newRunMetaById = { ...s.runMetaById };

      for (const runId of runIds) {
        delete newEventsByRun[runId];
        delete newCursorByRun[runId];
        delete newTaskCardCache[runId];
        delete newReasoningCache[runId];
        delete newRunMetaById[runId];
      }

      const newRunsByConversation = { ...s.runsByConversation };
      delete newRunsByConversation[convId];

      return {
        eventsByRun: newEventsByRun,
        cursorByRun: newCursorByRun,
        taskCardCache: newTaskCardCache,
        reasoningCache: newReasoningCache,
        runMetaById: newRunMetaById,
        runsByConversation: newRunsByConversation,
      };
    });
  },

  clearRun: (runId) => {
    set(s => {
      const newEventsByRun = { ...s.eventsByRun };
      const newCursorByRun = { ...s.cursorByRun };
      const newTaskCardCache = { ...s.taskCardCache };
      const newReasoningCache = { ...s.reasoningCache };
      const newRunMetaById = { ...s.runMetaById };

      delete newEventsByRun[runId];
      delete newCursorByRun[runId];
      delete newTaskCardCache[runId];
      delete newReasoningCache[runId];
      delete newRunMetaById[runId];

      // 从 runsByConversation 中移除
      const newRunsByConversation = { ...s.runsByConversation };
      for (const [convId, runs] of Object.entries(newRunsByConversation)) {
        newRunsByConversation[convId] = runs.filter(r => r !== runId);
      }

      return {
        eventsByRun: newEventsByRun,
        cursorByRun: newCursorByRun,
        taskCardCache: newTaskCardCache,
        reasoningCache: newReasoningCache,
        runMetaById: newRunMetaById,
        runsByConversation: newRunsByConversation,
      };
    });
  },

  getEvents: (convId) => {
    const runIds = get().runsByConversation[convId] ?? [];
    const allEvents: AgentEventEnvelope[] = [];
    for (const runId of runIds) {
      allEvents.push(...(get().eventsByRun[runId] ?? []));
    }
    return sortBySeq(allEvents);
  },

  getEventsByRun: (runId) => get().eventsByRun[runId] ?? [],

  getLastSeq: (convId) => {
    const runIds = get().runsByConversation[convId] ?? [];
    let maxSeq = 0;
    for (const runId of runIds) {
      maxSeq = Math.max(maxSeq, get().cursorByRun[runId] ?? 0);
    }
    return maxSeq;
  },

  getLastSeqByRun: (runId) => get().cursorByRun[runId] ?? 0,

  getRunsForConversation: (convId) => get().runsByConversation[convId] ?? [],

  getRunMeta: (runId) => get().runMetaById[runId],

  projectActivity: (convId) => {
    return get().getEvents(convId);
  },

  projectActivityByRun: (runId) => {
    return get().eventsByRun[runId] ?? [];
  },

  projectTaskProgress: (convId) => {
    const events = get().getEvents(convId);
    return projectTaskProgress(events);
  },

  projectTaskProgressByRun: (runId) => {
    const events = get().eventsByRun[runId] ?? [];
    return projectTaskProgress(events);
  },

  projectReplies: (convId) => {
    const events = get().getEvents(convId);
    const replies = new Map<string, string>();
    for (const ev of events) {
      if (ev.eventType === 'agent.message.delta' && typeof ev.content === 'string') {
        replies.set(ev.agentId, (replies.get(ev.agentId) ?? '') + ev.content);
      } else if (ev.eventType === 'agent.message.completed') {
        replies.set(ev.agentId, ev.content ?? '');
      }
    }
    return replies;
  },

  projectRepliesByRun: (runId) => {
    const events = get().eventsByRun[runId] ?? [];
    const replies = new Map<string, string>();
    for (const ev of events) {
      if (ev.eventType === 'agent.message.delta' && typeof ev.content === 'string') {
        replies.set(ev.agentId, (replies.get(ev.agentId) ?? '') + ev.content);
      } else if (ev.eventType === 'agent.message.completed') {
        replies.set(ev.agentId, ev.content ?? '');
      }
    }
    return replies;
  },

  projectTaskCard: (convId) => {
    const events = get().getEvents(convId);
    if (events.length === 0) return null;

    // 找到最新的 task.started 所在的 run
    let latestRunId: string | null = null;
    let latestStartedSeq = -1;
    for (const ev of events) {
      if (ev.eventType === 'task.started' && ev.seq > latestStartedSeq) {
        latestStartedSeq = ev.seq;
        latestRunId = getRunKey(ev);
      }
    }
    if (!latestRunId) return null;

    return get().projectTaskCardByRun(latestRunId);
  },

  projectTaskCardByRun: (runId) => {
    const events = get().eventsByRun[runId] ?? [];
    if (events.length === 0) return null;

    const cache = get().taskCardCache[runId];
    const lastProcessedSeq = cache?.lastProcessedSeq ?? -1;
    const maxSeq = events.length > 0 ? events[events.length - 1].seq : -1;

    // 缓存命中且已是最新：直接返回
    if (cache?.card && lastProcessedSeq >= maxSeq) {
      return cache.card;
    }

    // 定位最近一次 task.started（当前任务起点）
    let startedIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].eventType === 'task.started') { startedIdx = i; break; }
    }
    if (startedIdx === -1) return null;

    const startedEv = events[startedIdx];
    const startedSeq = startedEv.seq;

    // 若有新的 task.started 发生在上次处理之后，必须全量重算
    const needsFullRecompute = !cache?.card || lastProcessedSeq < startedSeq;

    let status: TaskCard['status'] = 'running';
    let endReason: string | undefined;
    let completedAt: string | undefined;

    let steps: TaskCardStep[] = [];
    let byAgent = new Map<string, TaskCardStep>();
    let activeReasoning = '';
    let lastAgentId = '';
    let agentOutputs = new Map<string, string>();
    let plan: string | undefined;
    // P1-02：按 agent 隔离的 reasoning 流（增量恢复时需要重建）
    let reasoningByAgent = new Map<string, string>();

    let processFromIdx: number;

    if (needsFullRecompute) {
      // 全量重算：从 task.started 开始
      processFromIdx = startedIdx;
    } else {
      // 增量：仅处理 lastProcessedSeq 之后的新事件
      processFromIdx = events.findIndex(e => e.seq > lastProcessedSeq);
      if (processFromIdx === -1) processFromIdx = events.length;

      // 恢复缓存状态
      if (cache?.card) {
        status = cache.card.status;
        endReason = cache.card.endReason;
        steps = cache.card.steps.map(s => ({ ...s })); // 浅拷贝步骤数组
        byAgent = new Map(cache.card.steps.map(s => [s.agentId, { ...s }]));
        activeReasoning = cache.card.activeReasoning;
        agentOutputs = new Map(cache.card.agentOutputs);
        plan = cache.card.plan;
        // 增量路径：从 events 中重建每个 agent 的 reasoning 历史（幂等重建）
        for (const e of events.slice(0, processFromIdx)) {
          if (e.eventType === 'agent.reasoning.delta' && e.content) {
            const prev = reasoningByAgent.get(e.agentId) ?? '';
            reasoningByAgent.set(e.agentId, (prev ? prev + '\n' : '') + e.content);
          }
        }
      }
    }

    // 处理事件增量
    for (let i = processFromIdx; i < events.length; i++) {
      const ev = events[i];

      if (ev.eventType === 'task.completed' || ev.eventType === 'task.failed') {
        status = ev.eventType === 'task.failed' ? 'failed' : 'completed';
        completedAt = ev.timestamp;
        endReason = ev.endReason;
        continue;
      }
      if (ev.eventType === 'task.cancelled') {
        status = 'cancelled'; completedAt = ev.timestamp;
        continue;
      }
      if (ev.eventType === 'task.plan' && ev.content) {
        plan = ev.content;
        continue;
      }
      if (ev.eventType === 'agent.started') {
        const existing = byAgent.get(ev.agentId);
        const row: TaskCardStep = existing ?? {
          key: `agent-${ev.agentId}`,
          agentId: ev.agentId,
          label: ev.agentType === 'orchestrator' && ev.agentId === 'sisyphus'
            ? (ev.content ? ev.content.slice(0, 40) : 'Sisyphus 编排')
            : `${ev.agentId} 运行中`,
          kind: 'agent',
          state: 'running',
          startedSeq: ev.seq,
          agentType: ev.agentType,
        };
        if (ev.content && row.state === 'running' && !row.label.includes(ev.agentId)) {
          row.label = ev.content.slice(0, 40);
        }
        if (!existing) { steps.push(row); byAgent.set(ev.agentId, row); }
        lastAgentId = ev.agentId;
        continue;
      }
      if (ev.eventType === 'agent.status' && ev.content) {
        const row = byAgent.get(ev.agentId);
        if (row) row.label = ev.content.slice(0, 60);
        lastAgentId = ev.agentId;
        continue;
      }
      if (ev.eventType === 'agent.completed' || ev.eventType === 'agent.error' || ev.eventType === 'agent.failed') {
        const row = byAgent.get(ev.agentId);
        if (row) {
          row.state = ev.eventType === 'agent.completed' ? 'ok' : 'error';
          if (ev.content && row.state === 'ok') row.label = `✓ ${ev.agentId}: ${ev.content.slice(0, 40)}`;
        }
        lastAgentId = ev.agentId;
        continue;
      }
      if (ev.eventType === 'agent.reasoning.delta' && ev.content) {
        // P1-02：reasoning 必须按 agent 隔离 —— 每个 agent 自己的推理流互不污染
        const prev = reasoningByAgent.get(ev.agentId) ?? '';
        const next = (prev ? prev + '\n' : '') + ev.content;
        reasoningByAgent.set(ev.agentId, next.length > 400 ? next.slice(-400) : next);
        // 当前活跃 agent 的 reasoning 才作为卡片活动区显示
        activeReasoning = reasoningByAgent.get(ev.agentId) ?? '';
        lastAgentId = ev.agentId;
        continue;
      }
      if (ev.eventType === 'agent.message.delta' && ev.content) {
        agentOutputs.set(ev.agentId, (agentOutputs.get(ev.agentId) ?? '') + ev.content);
        lastAgentId = ev.agentId;
        continue;
      }
      if (ev.eventType.startsWith('tool.')) continue;
    }

    const isFinal = status !== 'running';

    const newCard: TaskCard = {
      taskId: startedEv.taskId,
      status,
      endReason,
      steps: steps.slice(0, 20),
      activeReasoning: isFinal ? '' : activeReasoning,
      agentOutputs,
      plan,
    };

    // 更新缓存（仅当结果变化时，避免不必要的渲染）
    const cachedCard = cache?.card;
    const cardChanged = !cachedCard ||
      cachedCard.status !== newCard.status ||
      cachedCard.endReason !== newCard.endReason ||
      cachedCard.plan !== newCard.plan ||
      cachedCard.activeReasoning !== newCard.activeReasoning ||
      cachedCard.steps.length !== newCard.steps.length ||
      cachedCard.agentOutputs.size !== newCard.agentOutputs.size ||
      newCard.steps.some((s, i) => s.state !== cachedCard.steps[i]?.state || s.label !== cachedCard.steps[i]?.label) ||
      Array.from(newCard.agentOutputs.entries()).some(([k, v]) => cachedCard.agentOutputs.get(k) !== v);

    if (cardChanged) {
      set(s => ({
        taskCardCache: { ...s.taskCardCache, [runId]: { card: newCard, lastProcessedSeq: maxSeq } },
      }));
    }

    return newCard;
  },
}));

// ---- 纯工具：事件投影（SSE 解析已统一收敛到 api/streamClient.ts 的 parseSseFrame） ----

/** 事件类型细分——用于渲染判定 */
export function isToolEvent(type: AgentEventType): boolean {
  return type.startsWith('tool.');
}

export function isTaskBoundary(type: AgentEventType): boolean {
  return type === 'task.completed' || type === 'task.cancelled' || type === 'task.failed';
}

export interface ActivityRecord {
  kind: 'tool' | 'agent' | 'task' | 'message' | 'reasoning' | 'meta';
  status: EventStatus | 'queued';
  label?: string;
  target?: string;
  side?: string;
  message?: string;
  seq: number;
  agentId: string;
  parentEventId?: string;
}

/**
 * 语义层投影：事件流 → 紧凑 Activity 记录（供 ActivityStream 渲染）
 * 把 tool.started → tool.completed 折叠为一条持续更新的记录；agent.status 为独立记录。
 */
export function projectToRecords(events: AgentEventEnvelope[]): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  const byParent = new Map<string, ActivityRecord>();

  for (const ev of events) {
    switch (ev.eventType) {
      case 'tool.started': {
        const rec: ActivityRecord = {
          kind: 'tool', status: 'queued', label: ev.tool?.toolName, target: ev.tool?.toolInput,
          side: undefined, seq: ev.seq, agentId: ev.agentId,
        };
        records.push(rec);
        byParent.set(ev.eventId, rec);
        break;
      }
      case 'tool.completed': {
        const rec = ev.parentEventId ? byParent.get(ev.parentEventId) : undefined;
        if (rec) {
          rec.status = 'completed';
          rec.side = ev.tool?.toolOutput;
          if (ev.tool?.toolName) rec.label = ev.tool.toolName;
          if (ev.tool?.toolInput) rec.target = ev.tool.toolInput;
        } else {
          records.push({
            kind: 'tool', status: 'completed', label: ev.tool?.toolName, target: ev.tool?.toolInput,
            side: ev.tool?.toolOutput, seq: ev.seq, agentId: ev.agentId,
          });
        }
        break;
      }
      case 'tool.error': {
        const rec = ev.parentEventId ? byParent.get(ev.parentEventId) : undefined;
        if (rec) { rec.status = 'error'; rec.side = ev.tool?.error?.message ?? ev.content; }
        else records.push({
          kind: 'tool', status: 'error', label: ev.tool?.toolName, target: ev.tool?.toolInput,
          side: ev.tool?.error?.message, seq: ev.seq, agentId: ev.agentId,
        });
        break;
      }
      case 'tool.retry': {
        const rec = ev.parentEventId ? byParent.get(ev.parentEventId) : undefined;
        if (rec) { rec.status = 'retry'; rec.side = ev.content; }
        break;
      }
      case 'tool.progress': {
        const rec = ev.parentEventId ? byParent.get(ev.parentEventId) : undefined;
        if (rec) rec.status = 'running';
        break;
      }
      case 'agent.status':
        records.push({
          kind: 'agent', status: 'running', message: ev.content ?? '…', seq: ev.seq, agentId: ev.agentId,
        });
        break;
      case 'agent.started':
        records.push({
          kind: 'agent', status: 'running', message: ev.content ?? `${ev.agentId} 开始`, seq: ev.seq, agentId: ev.agentId,
        });
        break;
      case 'agent.reasoning.delta':
        if (ev.content) {
          records.push({
            kind: 'reasoning', status: 'running', message: ev.content, seq: ev.seq, agentId: ev.agentId,
          });
        }
        break;
      case 'agent.completed':
        records.push({
          kind: 'agent', status: 'completed', message: ev.content ?? '完成', seq: ev.seq, agentId: ev.agentId,
        });
        break;
      case 'agent.error':
      case 'agent.failed':
        records.push({
          kind: 'agent', status: 'error', message: ev.content ?? '失败', seq: ev.seq, agentId: ev.agentId,
        });
        break;
      case 'task.completed':
        records.push({ kind: 'task', status: 'completed', message: ev.content ?? '✓ 任务完成', seq: ev.seq, agentId: ev.agentId });
        break;
      case 'task.cancelled':
        records.push({ kind: 'task', status: 'cancelled', message: '■ 已停止', seq: ev.seq, agentId: ev.agentId });
        break;
      case 'task.failed':
        records.push({ kind: 'task', status: 'error', message: ev.content ?? '任务失败', seq: ev.seq, agentId: ev.agentId });
        break;
      case 'agent.message.delta':
      case 'agent.message.completed':
        // 最终回答不作为 Activity 行——由 projectReplies 单独投影
        break;
      default:
        break;
    }
  }
  return records;
}

/**
 * 投影：任务进度（供 ActivityStream 摘要卡使用）
 * P0-18：只有 task.completed / task.cancelled / task.failed 才能结束任务；
 * agent.completed 只是子 Agent 完成，绝不等于 Task 完成。
 */
export function projectTaskProgress(events: AgentEventEnvelope[]): TaskProgressState | null {
  if (events.length === 0) return null;
  // 找最近一次 task.started 定位当前任务
  let startedIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].eventType === 'task.started') { startedIdx = i; break; }
  }
  if (startedIdx === -1) return null;
  const active = events.slice(startedIdx);
  const steps: string[] = [];
  let status: TaskProgressState['status'] = 'running';
  let completedAt: string | undefined;
  let startedAt: string | undefined;
  let currentStep: string | undefined;
  for (const ev of active) {
    // P0-18：仅 task 生命周期事件可终结任务（agent.completed/agent.error 不终结）
    if (ev.eventType === 'task.completed') {
      status = 'completed'; completedAt = ev.timestamp; if (startedAt === undefined) startedAt = ev.timestamp;
      continue;
    }
    if (ev.eventType === 'task.cancelled') { status = 'cancelled'; completedAt = ev.timestamp; continue; }
    if (ev.eventType === 'task.failed') { status = 'failed'; completedAt = ev.timestamp; continue; }
    // 步骤：工具完成 / 状态事件
    if (ev.eventType === 'tool.completed' && ev.tool) {
      const label = `${ev.tool.toolName}${ev.tool.toolInput ? ` ${ev.tool.toolInput}` : ''}`;
      if (!steps.includes(label)) steps.push(label);
      currentStep = label;
    } else if (ev.eventType === 'agent.status' && ev.content && !ev.content.includes('正在分析任务')) {
      currentStep = ev.content;
    } else if (ev.eventType === 'task.started') {
      startedAt = ev.timestamp;
    }
  }
  return {
    taskId: active[0].taskId,
    status,
    currentStep,
    steps: steps.slice(-12),
    startedAt,
    completedAt,
  };
}