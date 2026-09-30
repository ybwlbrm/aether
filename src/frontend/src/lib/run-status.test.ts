import { describe, it, expect } from 'vitest';
import { RUN_STATUSES, RUN_TERMINAL_STATUSES, type RunStatus } from '@pacc/shared';
import {
  RUN_STATUS_META,
  nextRunStatuses,
  isRunLifecycleEventType,
  RUN_EVENT_TYPE_TO_STATUS,
} from './run-status';

/** 后端路由层 allow-list（src/backend/src/modules/runs/routes.ts）。
 *  UI 必须按路由层而非 manager 层，否则会发出必然 409 的请求。 */
const ROUTE_CANCELLABLE: readonly RunStatus[] = [
  'running',
  'waiting',
  'retry_waiting',
  'retrying',
  'verifying',
];
const ROUTE_PAUSABLE: readonly RunStatus[] = ['running'];
const ROUTE_RESUMABLE: readonly RunStatus[] = ['waiting'];

const BUSY: readonly RunStatus[] = [
  'running',
  'waiting',
  'retry_waiting',
  'retrying',
  'verifying',
];

describe('RUN_STATUS_META', () => {
  it('覆盖全部 11 个 RunStatus', () => {
    expect(Object.keys(RUN_STATUS_META).sort()).toEqual([...RUN_STATUSES].sort());
    expect(RUN_STATUSES).toHaveLength(11);
  });

  it('terminal 标志与 RUN_TERMINAL_STATUSES 完全一致', () => {
    const authoritative = new Set<RunStatus>(RUN_TERMINAL_STATUSES);
    for (const status of RUN_STATUSES) {
      expect(RUN_STATUS_META[status].terminal).toBe(authoritative.has(status));
    }
    expect(RUN_STATUS_META.completed.terminal).toBe(true);
    expect(RUN_STATUS_META.budget_exceeded.terminal).toBe(true);
    expect(RUN_STATUS_META.running.terminal).toBe(false);
  });

  it('busy 标志仅覆盖 5 个进行中状态', () => {
    const busyStatuses = RUN_STATUSES.filter((s) => RUN_STATUS_META[s].busy);
    expect(busyStatuses).toEqual([...BUSY]);
  });

  it('动作标志严格镜像路由层 allow-list', () => {
    for (const status of RUN_STATUSES) {
      const meta = RUN_STATUS_META[status];
      expect(meta.cancellable).toBe(ROUTE_CANCELLABLE.includes(status));
      expect(meta.pausable).toBe(ROUTE_PAUSABLE.includes(status));
      expect(meta.resumable).toBe(ROUTE_RESUMABLE.includes(status));
    }
  });

  it('retrying 不可 resume（manager 允许但路由层拒绝，UI 不得暴露）', () => {
    expect(RUN_STATUS_META.retrying.resumable).toBe(false);
    expect(RUN_STATUS_META.waiting.resumable).toBe(true);
    expect(RUN_STATUS_META.running.resumable).toBe(false);
  });

  it('终态不提供任何动作', () => {
    for (const status of RUN_TERMINAL_STATUSES) {
      const meta = RUN_STATUS_META[status];
      expect(meta.cancellable).toBe(false);
      expect(meta.pausable).toBe(false);
      expect(meta.resumable).toBe(false);
    }
  });

  it('每个状态都有非空 label 与 tokenVar', () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_STATUS_META[status].label.length).toBeGreaterThan(0);
      expect(RUN_STATUS_META[status].tokenVar).toMatch(/^--status-/);
    }
  });

  it('Record 穷尽性：缺少 key 必须编译报错', () => {
    // @ts-expect-error —— 故意省略 10 个 key，断言 Record<RunStatus, ...> 要求全部 11 态
    const incomplete: Record<RunStatus, true> = { created: true };
    expect(incomplete.created).toBe(true);
  });

  it('Record 穷尽性：非法 key 必须编译报错', () => {
    const extra: Partial<typeof RUN_STATUS_META> = {
      // @ts-expect-error —— 故意写入不存在的状态名
      archived: RUN_STATUS_META.created,
    };
    expect(Object.keys(extra)).toEqual(['archived']);
  });
});

describe('nextRunStatuses', () => {
  it('镜像后端 VALID_RUN_TRANSITIONS', () => {
    expect(nextRunStatuses('created')).toEqual(['running']);
    expect(nextRunStatuses('running')).toEqual([
      'waiting',
      'retry_waiting',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'budget_exceeded',
    ]);
    expect(nextRunStatuses('waiting')).toEqual([
      'running',
      'retry_waiting',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'budget_exceeded',
    ]);
    expect(nextRunStatuses('retry_waiting')).toEqual([
      'retrying',
      'failed',
      'cancelled',
      'interrupted',
      'budget_exceeded',
    ]);
    expect(nextRunStatuses('retrying')).toEqual([
      'running',
      'waiting',
      'failed',
      'cancelled',
      'interrupted',
      'budget_exceeded',
    ]);
    expect(nextRunStatuses('verifying')).toEqual([
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'budget_exceeded',
    ]);
  });

  it('5 个终态为吸收态，迁移列表为空', () => {
    for (const status of RUN_TERMINAL_STATUSES) {
      expect(nextRunStatuses(status)).toEqual([]);
    }
  });

  it('全部 11 态均有定义且只产出合法状态', () => {
    for (const status of RUN_STATUSES) {
      const next = nextRunStatuses(status);
      expect(Array.isArray(next)).toBe(true);
      for (const candidate of next) {
        expect(RUN_STATUSES).toContain(candidate);
      }
    }
  });
});

describe('isRunLifecycleEventType', () => {
  it('接受 8 个 run.* 生命周期事件', () => {
    for (const type of [
      'run.created',
      'run.started',
      'run.paused',
      'run.resumed',
      'run.completed',
      'run.failed',
      'run.cancelled',
      'run.interrupted',
    ]) {
      expect(isRunLifecycleEventType(type)).toBe(true);
    }
  });

  it('拒绝非生命周期事件', () => {
    expect(isRunLifecycleEventType('run.progress')).toBe(false);
    expect(isRunLifecycleEventType('tool.called')).toBe(false);
    expect(isRunLifecycleEventType('message.delta')).toBe(false);
    expect(isRunLifecycleEventType('')).toBe(false);
  });

  it('不误判 Object 原型链上的属性名', () => {
    expect(isRunLifecycleEventType('toString')).toBe(false);
    expect(isRunLifecycleEventType('constructor')).toBe(false);
    expect(isRunLifecycleEventType('hasOwnProperty')).toBe(false);
  });
});

describe('RUN_EVENT_TYPE_TO_STATUS', () => {
  it('覆盖 8 个 run.* 事件到状态映射', () => {
    expect(RUN_EVENT_TYPE_TO_STATUS).toEqual({
      'run.created': 'created',
      'run.started': 'running',
      'run.paused': 'waiting',
      'run.resumed': 'running',
      'run.completed': 'completed',
      'run.failed': 'failed',
      'run.cancelled': 'cancelled',
      'run.interrupted': 'interrupted',
    });
  });

  it('映射目标全部是合法 RunStatus', () => {
    for (const type of Object.keys(RUN_EVENT_TYPE_TO_STATUS)) {
      expect(isRunLifecycleEventType(type)).toBe(true);
      expect(RUN_STATUSES).toContain(RUN_EVENT_TYPE_TO_STATUS[type]);
    }
  });
});
