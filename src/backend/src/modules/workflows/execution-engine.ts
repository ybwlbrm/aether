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
  const { workflowId, nodes, edges, input, config, executeNode, db, saveDb, request } = opts;

  if (nodes.length === 0) {
    throw new Error('工作流没有节点，无法执行');
  }

  const { runId, now } = await createWorkflowRunInternal(workflowId, nodes[0]?.id, db, saveDb, config);

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
    // 构建边图用于条件分支遍历
    const edgeMap = new Map<string, { source: string; target: string }[]>();
    for (const e of edges) {
      if (!edgeMap.has(e.source)) edgeMap.set(e.source, []);
      edgeMap.get(e.source)!.push(e);
    }
    // P0-1 修复：所有入度为 0 的节点（并行根节点）都必须入队执行。
    // 原实现 queue = [ordered[0].id] 只取第一个根，多根 DAG 中其余根节点
    // 及其下游节点被静默跳过，工作流结果不完整却仍标记 completed。
    // 若拓扑排序失败（有环回退原始顺序），则全部节点视为根，BFS 以 visited 去重。
    const indegreeCount = new Map<string, number>(nodes.map(n => [n.id, 0]));
    for (const e of edges) {
      if (indegreeCount.has(e.target)) indegreeCount.set(e.target, (indegreeCount.get(e.target) || 0) + 1);
    }
    const orderedSet = new Set(ordered.map(n => n.id));
    const allOrdered = orderedSet.size === nodes.length; // 拓扑成功
    const visited = new Set<string>();
    const queue = ordered
      .filter(n => allOrdered ? (indegreeCount.get(n.id) || 0) === 0 : true)
      .map(n => n.id);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const node = nodes.find(n => n.id === nodeId);
      if (!node) continue;

      db.update(workflowRuns).set({ currentNodeId: node.id }).where(eq(workflowRuns.id, runId)).run();
      const { output, data } = await executeNode(node, config, context);
      results[node.id] = { label: node.label, type: node.type, output, data };
      context[node.id] = output;

      // P1-14 修复：客户端断开连接时中止执行（避免浪费 AI 调用与副作用）
      // 使用 socket.destroyed（TCP 连接断开 = 客户端已断开）而非 request.raw.destroyed
      // （后者在请求体接收完毕后即被设为 true，不适合本场景）
      if (request.raw.socket?.destroyed) {
        failed = true;
        errorMsg = '客户端已断开连接，工作流执行中止';
        break;
      }

      // 条件节点：根据 data.passed 决定走哪条边
      // 边约定：第一条出边为 true 分支，第二条出边为 false 分支
      if (node.type === 'condition') {
        const passed = !!(data as any)?.passed;
        const outEdges = edgeMap.get(node.id) || [];
        if (passed) {
          // 条件通过：走第一条边（true 分支）
          if (outEdges.length > 0 && !visited.has(outEdges[0].target)) {
            queue.push(outEdges[0].target);
          }
        } else {
          // 条件不通过：走第二条边（false 分支），如果没有第二条边则跳过
          if (outEdges.length > 1 && !visited.has(outEdges[1].target)) {
            queue.push(outEdges[1].target);
          }
        }
      } else {
        // 普通节点：走所有出边
        const outEdges = edgeMap.get(node.id) || [];
        for (const e of outEdges) {
          if (!visited.has(e.target)) queue.push(e.target);
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
  saveDb(config);

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
import { workflowRuns } from '../../db/schema/index.js';
import { randomUUID } from 'node:crypto';

async function createWorkflowRunInternal(workflowId: string, firstNodeId: string | undefined, db: any, saveDb: (config: any) => void, config: any) {
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.insert(workflowRuns).values({
    id: runId,
    workflowId,
    status: 'running',
    currentNodeId: firstNodeId,
    results: '{}',
    startedAt: now,
  }).run();
  saveDb(config);
  return { runId, now };
}