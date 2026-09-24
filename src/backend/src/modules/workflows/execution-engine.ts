import type { WorkflowNode, WorkflowEdge } from './types.js';

/** 按边关系做拓扑排序；有环时返回 null（调用方应 fail-fast，LC-020） */
export function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] | null {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const indegree = new Map(nodes.map(n => [n.id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) || 0) + 1);
  }
  const queue = nodes.filter(n => (indegree.get(n.id) || 0) === 0).map(n => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) || []) {
      const d = (indegree.get(next) || 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) return null; // 有环 → 无法拓扑排序
  return order.map(id => byId.get(id)!).filter(Boolean);
}

/** 执行工作流核心逻辑 */
export interface ExecuteWorkflowOptions {
  workflowId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  input?: Record<string, unknown>;
  config: any; // BackendConfig
  executeNode: (node: WorkflowNode, config: any, context: Record<string, unknown>) => Promise<{ output: string; data?: unknown }>;
  db: any; // Database instance
  saveDb: (config: any) => void;
  request: any; // Fastify request for socket check
  /**
   * Optional event sink for workflow lifecycle events (Aether 2.0 §57):
   *   workflow.started / workflow.node.started / workflow.node.completed /
   *   workflow.completed / workflow.failed
   * Emitted with { workflowId, runId, nodeId?, nodeType?, ... } payloads.
   * Backward-compatible: callers that omit it get no events.
   */
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export interface ExecuteWorkflowResult {
  runId: string;
  status: 'completed' | 'failed';
  results: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export async function executeWorkflow(opts: ExecuteWorkflowOptions): Promise<ExecuteWorkflowResult> {
  const { workflowId, nodes, edges, input, config, executeNode, db, saveDb, request, onEvent } = opts;

  if (nodes.length === 0) {
    throw new Error('工作流没有节点，无法执行');
  }

  const { runId, now } = await createWorkflowRunInternal(workflowId, nodes[0]?.id, db, saveDb, config);

  // 事件：工作流开始（Aether 2.0 §57）
  const emit = (type: string, payload: Record<string, unknown>): void => {
    onEvent?.(type, { workflowId, runId, ...payload });
  };
  emit('workflow.started', { startedAt: now, nodeCount: nodes.length });

  const results: Record<string, unknown> = {};
  const context: Record<string, unknown> = { ...(input || {}) };
  let failed = false;
  let errorMsg: string | undefined;

  try {
    const ordered = topoSort(nodes, edges);
    if (!ordered) {
      // LC-020 修复：检测到循环依赖 → fail-fast，不再按原顺序执行（会死循环/错乱）
      throw new Error('工作流存在循环依赖，无法执行。请检查节点连接关系。');
    }
    // §41 修复：受控并行 DAG —— 所有入度为 0 的节点同时就绪，依赖满足后逐波执行，
    // 最多 maxParallelTasks 个节点并发（由 config.workflowMaxParallel 控制）。
    const edgeMap = new Map<string, WorkflowEdge[]>();
    for (const e of edges) {
      if (!edgeMap.has(e.source)) edgeMap.set(e.source, []);
      edgeMap.get(e.source)!.push(e);
    }
    const indegree = new Map<string, number>(nodes.map(n => [n.id, 0]));
    for (const e of edges) {
      if (indegree.has(e.target)) indegree.set(e.target, (indegree.get(e.target) || 0) + 1);
    }
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const MAX_PARALLEL = typeof (config as { workflowMaxParallel?: unknown })?.workflowMaxParallel === 'number'
      ? (config as { workflowMaxParallel: number }).workflowMaxParallel
      : 4; // 默认最多 4 个节点并行

    // ready 队列：入度 0 的根节点
    const ready = ordered.filter(n => (indegree.get(n.id) || 0) === 0).map(n => n.id);
    const visited = new Set<string>();
    // pendingCount: 正在执行的节点数；用 Promise 队列实现受控并发
    let runningCount = 0;
    const waitForSlot = async (): Promise<void> => {
      while (runningCount >= MAX_PARALLEL) {
        await new Promise(r => setTimeout(r, 5));
      }
    };

    // 逐波执行：每次取一批 ready 节点，全部完成后统一推进下游（Dependency Join）
    while (ready.length > 0) {
      // 取出当前波次（受 maxParallel 限制）
      const wave: string[] = [];
      while (ready.length > 0 && wave.length < MAX_PARALLEL) {
        const id = ready.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        wave.push(id);
      }
      if (wave.length === 0) break;

      // 并行执行本波节点
      const waveResults = await Promise.all(wave.map(async (nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) return;
        await waitForSlot();
        runningCount++;
        try {
          db.update(workflowRuns).set({ currentNodeId: node.id }).where(eq(workflowRuns.id, runId)).run();
          emit('workflow.node.started', { nodeId: node.id, nodeType: node.type, nodeLabel: node.label });
          const { output, data } = await executeNode(node, config, context);
          results[node.id] = { label: node.label, type: node.type, output, data };
          context[node.id] = output;
          emit('workflow.node.completed', { nodeId: node.id, nodeType: node.type, nodeLabel: node.label });
          return { node, data };
        } finally {
          runningCount--;
        }
      }));

      // 客户端断开中止
      if (request.raw.socket?.destroyed) {
        failed = true;
        errorMsg = '客户端已断开连接，工作流执行中止';
        break;
      }

      // Dependency Join：本波全部完成后，推进满足依赖的下一波
      for (const waveResult of waveResults) {
        if (!waveResult) continue;
        const { node, data } = waveResult;
        const passed = node.type === 'condition' ? !!(data as { passed?: boolean } | null | undefined)?.passed : null;
        const outEdges = edgeMap.get(node.id) || [];
        for (const e of outEdges) {
          // §42 修复：条件边显式化 —— 用 edge.condition 而非"第一条=true/第二条=false"
          if (e.condition === 'passed' && passed !== true) continue;
          if (e.condition === 'failed' && passed !== false) continue;
          if (node.type === 'condition' && !e.condition) continue; // 条件节点只走显式条件边
          if (!visited.has(e.target)) {
            const d = (indegree.get(e.target) || 1) - 1;
            indegree.set(e.target, d);
            if (d === 0) ready.push(e.target);
          }
        }
        // 无条件边（普通节点）直接推进下游
        if (node.type !== 'condition') {
          for (const e of outEdges) {
            if (!visited.has(e.target)) {
              const d = (indegree.get(e.target) || 1) - 1;
              indegree.set(e.target, d);
              if (d === 0) ready.push(e.target);
            }
          }
        }
      }
    }
  } catch (e: unknown) {
    failed = true;
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  const completedAt = new Date().toISOString();
  db.update(workflowRuns).set({
    status: failed ? 'failed' : 'completed',
    currentNodeId: failed ? db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()?.currentNodeId : undefined,
    results: JSON.stringify(results),
    error: errorMsg,
    completedAt,
  }).where(eq(workflowRuns.id, runId)).run();
  // P0-05 收口：工作流 Run 终态统一走 RunLifecycleManager 状态机
  try {
    const lifecycle = new RunLifecycleManager(db);
    if (failed) {
      lifecycle.transition(runId, 'fail', { error: errorMsg, endReason: 'error' });
    } else {
      lifecycle.transition(runId, 'complete', { endReason: 'completed' });
    }
  } catch (e: unknown) {
    console.warn('[Workflow] runs 终态写入失败（不影响工作流执行）:',
      e instanceof Error ? e.message : String(e));
  }
  saveDb(config);

  // 事件：工作流结束（§57 workflow.completed / workflow.failed）
  if (failed) {
    emit('workflow.failed', { error: errorMsg, completedAt });
  } else {
    emit('workflow.completed', { completedAt, resultCount: Object.keys(results).length });
  }

  return {
    runId,
    status: failed ? 'failed' : 'completed',
    results,
    error: errorMsg,
    startedAt: now,
    completedAt,
  };
}

// 需要导入的依赖
import { eq } from 'drizzle-orm';
import { workflowRuns, runs } from '../../db/schema/index.js';
import { RunLifecycleManager } from '../../core/runtime/index.js';
import { runInTransaction, saveDb } from '../../db/client.js';
import { randomUUID } from 'node:crypto';

/**
 * 整改计划第 10 章（P1）：在同一事务内原子创建 runs 与 workflow_runs。
 * 任一失败整体回滚 —— 不允许"runs 创建失败仅 warning 后继续"（会产生 orphan workflowRun）。
 * 失败时抛出，由调用方（executeWorkflow）统一走 failed 分支。
 */
async function createWorkflowRunInternal(workflowId: string, firstNodeId: string | undefined, db: any, saveDb: (config: any) => void, config: any) {
  const runId = randomUUID();
  const now = new Date().toISOString();
  runInTransaction(config, () => {
    // P0-04/P0-05 收口：Workflow 也进入统一 Run 架构（runs 表 + RunLifecycleManager 状态机）
    // 整改计划第 10 章：runs 行创建失败 → 抛出（触发整体回滚），不再吞错继续
    const lifecycle = new RunLifecycleManager(db);
    lifecycle.createAndStart({
      runId,
      conversationId: null,
      mode: 'workflow',
      rootAgentId: 'workflow',
      metadata: { workflowId, firstNodeId },
    });
    db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      status: 'running',
      currentNodeId: firstNodeId,
      results: '{}',
      startedAt: now,
    }).run();
  });
  saveDb(config);
  return { runId, now };
}

/**
 * 整改计划第 10 章（P1）：启动时 orphan repair ——
 * 找出 workflow_runs 中 status='running' 但 runs 表无对应行（或 runs 已是终态）的
 * orphan 记录，标记为 failed（error='orphan repair'）。返回修复数量。
 */
export function repairOrphanWorkflowRuns(db: any, config: any): number {
  try {
    const orphan = (db.select().from(workflowRuns)
      .where(eq(workflowRuns.status, 'running')).all() as Array<{ id: string }>)
      .filter((wr) => {
        const run = db.select().from(runs).where(eq(runs.id, wr.id)).get() as { status: string } | undefined;
        // runs 行缺失，或 runs 已是终态（completed/failed/cancelled/interrupted）→ orphan
        return !run || !['running', 'waiting', 'created'].includes(run.status);
      });
    for (const wr of orphan) {
      db.update(workflowRuns).set({
        status: 'failed',
        error: 'orphan repair: runs 记录缺失或已终止',
        completedAt: new Date().toISOString(),
      }).where(eq(workflowRuns.id, wr.id)).run();
    }
    if (orphan.length > 0) saveDb(config);
    return orphan.length;
  } catch (e) {
    console.warn('[Workflow] orphan repair 执行失败:', e instanceof Error ? e.message : String(e));
    return 0;
  }
}