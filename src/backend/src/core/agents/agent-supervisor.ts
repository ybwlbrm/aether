/**
 * Agent Supervisor — Aether 2.0 Supervisor Agent (P1-26)
 *
 * Supervises worker AgentRuntime instances: task creation, capacity/budget
 * enforcement, status tracking, and waitForAll completion barriers.
 *
 * Tasks are executed immediately against a registered worker runtime when the
 * budget allows; otherwise the supervisor throws SUPERVISOR_CAPACITY.
 *
 * Transport-agnostic: no Fastify, no SSE, no React — pure TypeScript.
 */

import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../errors/index.js';
import { AgentRuntime } from './agent-runtime.js';
import type { AgentDefinition } from './agent-definition.js';
import type { AgentContext } from './agent-context.js';

/** Supervisor configuration */
export interface SupervisorConfig {
  /** Maximum concurrently running tasks (across all workers) */
  maxConcurrentTasks: number;
  /** Optional per-agent budget enforcement */
  budget?: AgentDefinition['limits'];
}

/** Task lifecycle statuses tracked by the supervisor */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Internal task record */
interface TaskRecord {
  id: string;
  agentId: string;
  task: unknown;
  status: TaskStatus;
  result?: unknown;
  error?: string;
}

/**
 * Supervisor agent — extends AgentRuntime and manages worker task execution.
 *
 * Usage:
 *   const supervisor = new SupervisorAgent(definition, context, { maxConcurrentTasks: 4 });
 *   await supervisor.start();
 *   supervisor.registerWorker('planner', plannerRuntime);
 *   const taskId = await supervisor.createTask({ agentId: 'planner', task: { ... } });
 *   await supervisor.waitForAll();
 */
export class SupervisorAgent extends AgentRuntime {
  private readonly config: SupervisorConfig;
  private readonly workers = new Map<string, AgentRuntime>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly activeByAgent = new Map<string, number>();

  constructor(definition: AgentDefinition, context: AgentContext, config?: SupervisorConfig) {
    super(definition, context, definition.id);
    this.config = config ?? { maxConcurrentTasks: 8 };
  }

  /**
   * Registers a worker runtime so tasks for `agentId` can be executed.
   * The worker is started lazily by createTask before the first task runs.
   *
   * @param agentId - Agent id the worker executes
   * @param runtime - The AgentRuntime instance to invoke runTask on
   */
  registerWorker(agentId: string, runtime: AgentRuntime): void {
    this.workers.set(agentId, runtime);
  }

  /**
   * Creates a task and (when a worker + budget is available) runs it immediately.
   *
   * @param payload - { agentId: target worker, task: input for runTask }
   * @returns The task id
   * @throws RuntimeError SUPERVISOR_CAPACITY when the concurrent-task budget is exceeded
   */
  async createTask(payload: { agentId: string; task: unknown }): Promise<string> {
    const { agentId, task } = payload;
    const taskId = randomUUID();

    const activeTotal = this.#activeTotal();
    const perAgentMax = this.config.budget?.maxParallelTasks ?? this.config.maxConcurrentTasks;
    const activeForAgent = this.activeByAgent.get(agentId) ?? 0;

    if (activeTotal >= this.config.maxConcurrentTasks || activeForAgent >= perAgentMax) {
      throw new RuntimeError('Supervisor capacity exceeded', {
        code: 'SUPERVISOR_CAPACITY',
        retryable: false,
        context: {
          agentId,
          maxConcurrentTasks: this.config.maxConcurrentTasks,
          perAgentMax,
          activeTotal,
          activeForAgent,
        },
      });
    }

    const record: TaskRecord = { id: taskId, agentId, task, status: 'pending' };
    this.tasks.set(taskId, record);

    const worker = this.workers.get(agentId);
    if (worker === undefined) {
      // No worker registered — task stays pending (caller may register later)
      return taskId;
    }

    // Execute the task against the worker (ensure it is started first)
    this.activeByAgent.set(agentId, activeForAgent + 1);
    record.status = 'running';
    const run = async (): Promise<unknown> => {
      if (!worker.isRunning) {
        await worker.start();
      }
      return worker.runTask(task as Record<string, unknown>);
    };
    void run()
      .then((result) => {
        record.status = 'completed';
        record.result = result;
      })
      .catch((error: unknown) => {
        record.status = 'failed';
        record.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        const current = this.activeByAgent.get(agentId) ?? 1;
        if (current <= 1) this.activeByAgent.delete(agentId);
        else this.activeByAgent.set(agentId, current - 1);
      });

    return taskId;
  }

  /**
   * Returns the current status of a task.
   *
   * @param taskId - Task id returned by createTask
   * @throws RuntimeError TASK_NOT_FOUND for unknown ids
   */
  taskStatus(taskId: string): TaskStatus {
    const record = this.tasks.get(taskId);
    if (record === undefined) {
      throw new RuntimeError(`task not found: ${taskId}`, {
        code: 'TASK_NOT_FOUND',
        retryable: false,
        context: { taskId },
      });
    }
    return record.status;
  }

  /** Number of currently running (or pending) tasks */
  get activeCount(): number {
    return this.#activeTotal();
  }

  /**
   * Resolves once every tracked task reaches a terminal state
   * (completed or failed). Tasks that are still pending because no worker
   * was registered will remain pending forever — use with registered workers.
   */
  async waitForAll(): Promise<void> {
    const wait = async (): Promise<void> => {
      const inFlight = [...this.tasks.values()].filter(
        (t) => t.status === 'running' || t.status === 'pending',
      );
      if (inFlight.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await wait();
    };
    await wait();
  }

  #activeTotal(): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (record.status === 'running' || record.status === 'pending') count += 1;
    }
    return count;
  }
}