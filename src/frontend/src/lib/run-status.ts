/**
 * Run 状态展示模型（AEX-P0-002）。
 *
 * 权威状态集合来自 `@pacc/shared` 的 RUN_STATUSES，本文件只负责"展示层元数据"，
 * 禁止在此重复定义状态字符串。
 *
 * 动作标志严格镜像后端**路由层** allow-list（src/backend/src/modules/runs/routes.ts）：
 *   - start   ['created']
 *   - pause   ['running']
 *   - resume  ['waiting']                    ← 路由层只允许 waiting
 *   - cancel  ['running','waiting','retry_waiting','retrying','verifying']
 *
 * 注意：RunLifecycleManager 允许 resume 从 retrying 触发，但路由层拒绝。
 * UI 以路由层为准，否则会发出必然 409 的请求。
 */
import { RUN_TERMINAL_STATUSES, type RunStatus } from '@pacc/shared';

/** 语义色调，供设计系统映射到具体色板 */
export type RunStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** 单个 Run 状态的完整展示元数据 */
export interface RunStatusMeta {
  /** 中文展示标签 */
  label: string;
  /** 语义色调 */
  tone: RunStatusTone;
  /** 是否为终态（吸收态，不可再迁出） */
  terminal: boolean;
  /** 是否处于进行中（用于骨架屏 / 忙碌指示） */
  busy: boolean;
  /** 路由层 cancel 是否接受 */
  cancellable: boolean;
  /** 路由层 pause 是否接受 */
  pausable: boolean;
  /** 路由层 resume 是否接受 */
  resumable: boolean;
  /** 对应 tokens.css 中的 CSS 变量名 */
  tokenVar: string;
}

/** 终态集合（吸收态），取自 shared 权威定义 */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(RUN_TERMINAL_STATUSES);

/** 进行中状态：执行、等待、重试等待、重试、校验 */
const BUSY_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'running',
  'waiting',
  'retry_waiting',
  'retrying',
  'verifying',
]);

/** 路由层 cancel allow-list */
const CANCELLABLE: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'running',
  'waiting',
  'retry_waiting',
  'retrying',
  'verifying',
]);

/** 11 态 → 展示元数据。Record<RunStatus, ...> 保证新增状态时编译期报错。 */
export const RUN_STATUS_META: Record<RunStatus, RunStatusMeta> = {
  created: {
    label: '已创建',
    tone: 'neutral',
    terminal: false,
    busy: false,
    cancellable: false,
    pausable: false,
    resumable: false,
    tokenVar: '--status-created',
  },
  running: {
    label: '执行中',
    tone: 'info',
    terminal: false,
    busy: true,
    cancellable: true,
    pausable: true,
    resumable: false,
    tokenVar: '--status-running',
  },
  waiting: {
    label: '等待中',
    tone: 'warning',
    terminal: false,
    busy: true,
    cancellable: true,
    pausable: false,
    resumable: true,
    tokenVar: '--status-waiting',
  },
  retry_waiting: {
    label: '等待重试',
    tone: 'warning',
    terminal: false,
    busy: true,
    cancellable: true,
    pausable: false,
    resumable: false,
    tokenVar: '--status-retry-waiting',
  },
  retrying: {
    label: '重试中',
    tone: 'warning',
    terminal: false,
    busy: true,
    cancellable: true,
    pausable: false,
    resumable: false,
    tokenVar: '--status-retrying',
  },
  verifying: {
    label: '校验中',
    tone: 'info',
    terminal: false,
    busy: true,
    cancellable: true,
    pausable: false,
    resumable: false,
    tokenVar: '--status-verifying',
  },
  completed: {
    label: '已完成',
    tone: 'success',
    terminal: true,
    busy: false,
    cancellable: false,
    pausable: false,
    resumable: false,
    tokenVar: '--status-completed',
  },
  failed: {
    label: '失败',
    tone: 'danger',
    terminal: true,
    busy: false,
    cancellable: false,
    pausable: false,
    resumable: false,
    tokenVar: '--status-failed',
  },
  cancelled: {
    label: '已取消',
    tone: 'neutral',
    terminal: true,
    busy: false,
    cancellable: false,
    pausable: false,
    resumable: false,
    tokenVar: '--status-cancelled',
  },
  interrupted: {
    label: '已中断',
    tone: 'warning',
    terminal: true,
    busy: false,
    cancellable: false,
    pausable: false,
    resumable: false,
    tokenVar: '--status-interrupted',
  },
  budget_exceeded: {
    label: '预算超限',
    tone: 'danger',
    terminal: true,
    busy: false,
    cancellable: false,
    pausable: false,
    resumable: false,
    tokenVar: '--status-budget-exceeded',
  },
};

/**
 * 合法状态迁移表，镜像后端 VALID_RUN_TRANSITIONS
 * （src/backend/src/core/runtime/run.ts）。用于前端预判可达状态。
 */
const NEXT_RUN_STATUSES: Record<RunStatus, readonly RunStatus[]> = {
  created: ['running'],
  running: [
    'waiting',
    'retry_waiting',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'budget_exceeded',
  ],
  waiting: [
    'running',
    'retry_waiting',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'budget_exceeded',
  ],
  retry_waiting: ['retrying', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
  retrying: ['running', 'waiting', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
  verifying: ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  budget_exceeded: [],
};

/** 从某状态可迁移到的下一批状态（终态返回空数组） */
export function nextRunStatuses(status: RunStatus): readonly RunStatus[] {
  return NEXT_RUN_STATUSES[status];
}

/**
 * Run 生命周期事件类型 → 迁移后的状态。
 *
 * 键为普通 string 而非联合类型，使 v1 的 8 态闭集可以在不改动本文件签名的前提下
 * 继续扩宽（后端新增 run.* 事件时只需追加一行）。
 */
export const RUN_EVENT_TYPE_TO_STATUS: Record<string, RunStatus> = {
  'run.created': 'created',
  'run.started': 'running',
  'run.paused': 'waiting',
  'run.resumed': 'running',
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
  'run.interrupted': 'interrupted',
};

/**
 * 判断事件类型是否为 Run 生命周期事件（8 个 run.* 事件）。
 *
 * 判定为 string-keyed：入参是运行时字符串（来自 SSE），不做类型断言。
 * 用 Object.hasOwn 而非 `in`，避免把 Object 原型链上的键误判为生命周期事件。
 */
export function isRunLifecycleEventType(t: string): boolean {
  return Object.hasOwn(RUN_EVENT_TYPE_TO_STATUS, t);
}

/** 某状态是否为终态（吸收态） */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 某状态是否处于进行中 */
export function isBusyRunStatus(status: RunStatus): boolean {
  return BUSY_STATUSES.has(status);
}
