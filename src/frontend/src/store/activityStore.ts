import type { AgentEventEnvelope, AgentEventType, EventStatus } from '@pacc/shared';
import { create } from 'zustand';

/**
 * Activity Store — Event-driven Agent Activity Stream 的前端状态层。
 * - 单一事件源：eventsByConv[convId] 按 seq 有序
 * - appendEvent 按 seq 去重追加（SSE 实时 + 回放共用）
 * - 投影函数（纯计算）：消息列表 / Activity Stream / 任务进度
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

/** 增量投影缓存：每个会话的 TaskCard 状态 + 最后处理的 seq */
interface TaskCardCacheEntry {
  card: TaskCard | null;
  lastProcessedSeq: number;
}

interface ActivityState {
  eventsByConv: Record<string, AgentEventEnvelope[]>;
  /** seq 游标（用于回放增量 catch-up） */
  cursorByConv: Record<string, number>;
  /** TaskCard 增量投影缓存 */
  taskCardCache: Record<string, TaskCardCacheEntry>;

  appendEvent: (convId: string, event: AgentEventEnvelope) => void;
  appendEvents: (convId: string, events: AgentEventEnvelope[]) => void;
  replaceEvents: (convId: string, events: AgentEventEnvelope[]) => void;
  clearConv: (convId: string) => void;
  getEvents: (convId: string) => AgentEventEnvelope[];
  getLastSeq: (convId: string) => number;
  /** 投影：Activity Stream 条目列表 */
  projectActivity: (convId: string) => AgentEventEnvelope[];
  /** 投影：任务进度 */
  projectTaskProgress: (convId: string) => TaskProgressState | null;
  /** 投影：最终回答文本（agent.message.delta 累积，按 agentId 分） */
  projectReplies: (convId: string) => Map<string, string>;
  /** 投影：任务进度卡（task 生命周期 + 步骤链 + 流式思考 + Agent 输出） */
  projectTaskCard: (convId: string) => TaskCard | null;
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

export const useActivityStore = create<ActivityState>((set, get) => ({
  eventsByConv: {},
  cursorByConv: {},
  taskCardCache: {},

  appendEvent: (convId, event) => {
    const list = get().eventsByConv[convId] ?? [];
    // P0-08/EVT-003：去重身份统一走 getEventIdentity（eventId 优先，回退 sessionId+taskId+seq）
    const identity = getEventIdentity(event);
    const isDup = list.some(e => getEventIdentity(e) === identity);
    if (isDup) return;
    list.push(event);
    const sorted = sortBySeq(list);
    set(s => ({
      eventsByConv: { ...s.eventsByConv, [convId]: sorted },
      cursorByConv: { ...s.cursorByConv, [convId]: Math.max(s.cursorByConv[convId] ?? 0, event.seq) },
      taskCardCache: { ...s.taskCardCache, [convId]: { ...s.taskCardCache[convId], lastProcessedSeq: -1 } },
    }));
  },

  appendEvents: (convId, events) => {
    if (events.length === 0) return;
    const list = get().eventsByConv[convId] ?? [];
    // P0-17/EVT-003：统一身份（与 appendEvent 同一函数），杜绝双入口键不一致
    const known = new Set(list.map(e => getEventIdentity(e)));
    for (const ev of events) {
      const key = getEventIdentity(ev);
      if (known.has(key)) continue;
      known.add(key);
      list.push(ev);
    }
    const sorted = sortBySeq(list);
    const maxSeq = sorted.length > 0 ? sorted[sorted.length - 1].seq : (get().cursorByConv[convId] ?? 0);
    set(s => ({
      eventsByConv: { ...s.eventsByConv, [convId]: sorted },
      cursorByConv: { ...s.cursorByConv, [convId]: maxSeq },
      taskCardCache: { ...s.taskCardCache, [convId]: { ...s.taskCardCache[convId], lastProcessedSeq: -1 } },
    }));
  },

  replaceEvents: (convId, events) => {
    const sorted = sortBySeq(events);
    const maxSeq = sorted.length > 0 ? sorted[sorted.length - 1].seq : 0;
    set(s => ({
      eventsByConv: { ...s.eventsByConv, [convId]: sorted },
      cursorByConv: { ...s.cursorByConv, [convId]: maxSeq },
      taskCardCache: { ...s.taskCardCache, [convId]: { card: null, lastProcessedSeq: -1 } },
    }));
  },

  clearConv: (convId) => {
    set(s => {
      const { [convId]: _drop, ...rest } = s.eventsByConv;
      const cursors = { ...s.cursorByConv };
      delete cursors[convId];
      const cache = { ...s.taskCardCache };
      delete cache[convId];
      return { eventsByConv: rest, cursorByConv: cursors, taskCardCache: cache };
    });
  },

  getEvents: (convId) => get().eventsByConv[convId] ?? [],
  getLastSeq: (convId) => get().cursorByConv[convId] ?? 0,

  projectActivity: (convId) => {
    return get().eventsByConv[convId] ?? [];
  },

  projectTaskProgress: (convId) => {
    return projectTaskProgress(get().eventsByConv[convId] ?? []);
  },

  projectReplies: (convId) => {
    const events = get().eventsByConv[convId] ?? [];
    const replies = new Map<string, string>();
    // 按 agentId 累积最终回答；agent.message.completed 时替换为完整值
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
    const events = get().eventsByConv[convId] ?? [];
    if (events.length === 0) return null;

    const cache = get().taskCardCache[convId];
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
        taskCardCache: { ...s.taskCardCache, [convId]: { card: newCard, lastProcessedSeq: maxSeq } },
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