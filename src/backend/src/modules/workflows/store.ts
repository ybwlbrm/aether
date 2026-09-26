import { getDb, saveDb } from '../../db/client.js'
import { workflows, workflowRuns, workflowNodeRuns, runs } from '../../db/schema/index.js'
import { eq, desc, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BackendConfig } from '../../config/index.js';
import { RunLifecycleManager } from '../../core/runtime/index.js'
import { closeDanglingNodeRuns } from './node-run-store.js'
import type { WorkflowNode, WorkflowEdge, WorkflowNodeRun } from './types.js';

type WorkflowDatabase = ReturnType<typeof getDb>

/** 解析 JSON 列（容错空值/非法 JSON） */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** 获取所有工作流 */
export async function getAllWorkflows() {
  const db = getDb();
  const rows = db.select().from(workflows).all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description || '',
    nodes: parseJson<WorkflowNode[]>(r.nodes, []),
    edges: parseJson<WorkflowEdge[]>(r.edges, []),
    trigger: r.trigger,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** 创建工作流 */
export async function createWorkflow(data: {
  name: string;
  description?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  trigger?: 'manual' | 'schedule' | 'webhook';
}, config: BackendConfig) {
  if (!data.name || !data.name.trim()) {
    throw new Error('工作流名称不能为空');
  }
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.insert(workflows).values({
    id,
    name: data.name.trim(),
    description: data.description || '',
    nodes: JSON.stringify(data.nodes || []),
    edges: JSON.stringify(data.edges || []),
    trigger: data.trigger || 'manual',
    createdAt: now,
    updatedAt: now,
  }).run();
  saveDb(config);
  return {
    id, name: data.name.trim(), description: data.description || '',
    nodes: data.nodes || [], edges: data.edges || [],
    trigger: data.trigger || 'manual', createdAt: now, updatedAt: now,
  };
}

/** 获取单个工作流 */
export async function getWorkflowById(id: string) {
  const db = getDb();
  const row = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    nodes: parseJson<WorkflowNode[]>(row.nodes, []),
    edges: parseJson<WorkflowEdge[]>(row.edges, []),
    trigger: row.trigger,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 更新工作流 */
export async function updateWorkflow(id: string, data: {
  name?: string;
  description?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  trigger?: 'manual' | 'schedule' | 'webhook';
}, config: BackendConfig) {
  const db = getDb();
  const existing = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!existing) return null;
  const now = new Date().toISOString();
  // 名称非空校验（与创建一致）
  if (data.name !== undefined && (!data.name || !data.name.trim())) {
    throw new Error('工作流名称不能为空');
  }
  db.update(workflows).set({
    name: data.name !== undefined ? data.name.trim() : existing.name,
    description: data.description !== undefined ? data.description : existing.description,
    nodes: data.nodes !== undefined ? JSON.stringify(data.nodes) : existing.nodes,
    edges: data.edges !== undefined ? JSON.stringify(data.edges) : existing.edges,
    trigger: data.trigger !== undefined ? data.trigger : existing.trigger,
    updatedAt: now,
  }).where(eq(workflows.id, id)).run();
  saveDb(config);
  const row = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    nodes: parseJson<WorkflowNode[]>(row.nodes, []),
    edges: parseJson<WorkflowEdge[]>(row.edges, []),
    trigger: row.trigger,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 删除工作流 */
export async function deleteWorkflow(id: string, config: BackendConfig): Promise<boolean> {
  const db = getDb();
  const existing = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!existing) return false;
  // 级联删除运行记录
  db.delete(workflowRuns).where(eq(workflowRuns.workflowId, id)).run();
  db.delete(workflows).where(eq(workflows.id, id)).run();
  saveDb(config);
  return true;
}

/** 创建工作流运行记录 */
export async function createWorkflowRun(workflowId: string, firstNodeId: string | undefined, config: BackendConfig) {
  const db = getDb();
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

type CreateWorkflowRunInput = {
  readonly workflowId: string
  readonly firstNodeId: string | undefined
  readonly config: BackendConfig
  readonly db: WorkflowDatabase
  readonly saveDb: (config: BackendConfig) => void
}

/** 在同一事务内原子创建 runs 与 workflow_runs，避免遗留孤儿运行记录。 */
export async function createWorkflowRunInternal(input: CreateWorkflowRunInput): Promise<{ runId: string; now: string }> {
  const { workflowId, firstNodeId, config, db } = input
  const runId = randomUUID()
  const now = new Date().toISOString()
  db.transaction((tx) => {
    const lifecycle = new RunLifecycleManager(tx)
    lifecycle.createAndStart({
      runId,
      conversationId: null,
      mode: 'workflow',
      rootAgentId: 'workflow',
      metadata: { workflowId, firstNodeId },
    })
    tx.insert(workflowRuns).values({
      id: runId,
      workflowId,
      status: 'running',
      currentNodeId: firstNodeId,
      results: '{}',
      startedAt: now,
    }).run()
  })
  input.saveDb(config)
  return { runId, now }
}

/** 启动时修复 workflow_runs 与 runs 状态不一致的孤儿记录。 */
export function repairOrphanWorkflowRuns(db: WorkflowDatabase, config: BackendConfig): number {
  try {
    const orphan = db.select().from(workflowRuns)
      .where(eq(workflowRuns.status, 'running'))
      .all()
      .filter(workflowRun => {
        const run = db.select().from(runs).where(eq(runs.id, workflowRun.id)).get()
        return !run || !['running', 'waiting', 'created'].includes(run.status)
      })
    for (const workflowRun of orphan) {
      db.update(workflowRuns).set({
        status: 'failed',
        error: 'orphan repair: runs 记录缺失或已终止',
        completedAt: new Date().toISOString(),
      }).where(eq(workflowRuns.id, workflowRun.id)).run()
    }
    // AEX-P0-015：父 run 已收口，停在 running 的节点行也必须收口
    closeDanglingNodeRuns(db, orphan.map(workflowRun => workflowRun.id))
    if (orphan.length > 0) saveDb(config)
    return orphan.length
  } catch (error: unknown) {
    console.warn('[Workflow] orphan repair 执行失败:', error instanceof Error ? error.message : String(error))
    return 0
  }
}

/** 更新工作流运行状态 */
export async function updateWorkflowRun(runId: string, updates: {
    status?: 'running' | 'completed' | 'failed' | 'cancelled';
  currentNodeId?: string;
  results?: Record<string, unknown>;
  error?: string;
  completedAt?: string;
}, config: BackendConfig) {
  const db = getDb();
  const dbUpdates: {
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
    currentNodeId?: string;
    results?: string;
    error?: string;
    completedAt?: string;
  } = {
    status: updates.status,
    currentNodeId: updates.currentNodeId,
    error: updates.error,
    completedAt: updates.completedAt,
  };
  if (updates.results !== undefined) {
    dbUpdates.results = JSON.stringify(updates.results);
  }
  db.update(workflowRuns).set(dbUpdates).where(eq(workflowRuns.id, runId)).run();
  saveDb(config);
}

/** AEX-P0-015：把 workflow_node_runs 行投影为对外的节点态 */
function toNodeRunView(row: typeof workflowNodeRuns.$inferSelect): WorkflowNodeRun {
  return {
    nodeId: row.nodeId,
    status: row.status,
    attempt: row.attempt,
    retryCount: row.retryCount,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

/** 批量读取一组运行的节点态，按 workflowRunId 分组（一次查询，避免 N+1） */
function groupNodeRunsByRunId(
  db: WorkflowDatabase,
  runIds: readonly string[],
): Map<string, WorkflowNodeRun[]> {
  if (runIds.length === 0) return new Map()
  const grouped = new Map<string, WorkflowNodeRun[]>()
  const rows = db.select().from(workflowNodeRuns)
    .where(inArray(workflowNodeRuns.workflowRunId, [...runIds]))
    .all()
  for (const row of rows) {
    const list = grouped.get(row.workflowRunId) ?? []
    list.push(toNodeRunView(row))
    grouped.set(row.workflowRunId, list)
  }
  return grouped
}

/** 获取工作流运行记录（每个 run 携带 nodeRuns 节点态聚合，AEX-P0-015） */
export async function getWorkflowRuns(workflowId: string) {
  const db = getDb();
  const rows = db.select().from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.startedAt))
    .all();
  const nodeRunsByRunId = groupNodeRunsByRunId(db, rows.map(r => r.id));
  return rows.map(r => ({
    id: r.id,
    workflowId: r.workflowId,
    status: r.status,
    currentNodeId: r.currentNodeId,
    results: parseJson<Record<string, unknown>>(r.results, {}),
    nodeRuns: nodeRunsByRunId.get(r.id) ?? [],
    error: r.error,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  }));
}