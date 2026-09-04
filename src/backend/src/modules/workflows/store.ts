import { getDb, saveDb } from '../../db/client.js';
import { workflows, workflowRuns } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BackendConfig } from '../../config/index.js';
import type { WorkflowNode, WorkflowEdge } from './types.js';

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

/** 更新工作流运行状态 */
export async function updateWorkflowRun(runId: string, updates: {
  status?: 'running' | 'completed' | 'failed';
  currentNodeId?: string;
  results?: Record<string, unknown>;
  error?: string;
  completedAt?: string;
}, config: BackendConfig) {
  const db = getDb();
  const dbUpdates: {
    status?: 'running' | 'completed' | 'failed';
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

/** 获取工作流运行记录 */
export async function getWorkflowRuns(workflowId: string) {
  const db = getDb();
  const rows = db.select().from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.startedAt))
    .all();
  return rows.map(r => ({
    id: r.id,
    workflowId: r.workflowId,
    status: r.status,
    currentNodeId: r.currentNodeId,
    results: parseJson<Record<string, unknown>>(r.results, {}),
    error: r.error,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  }));
}