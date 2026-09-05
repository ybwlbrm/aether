/**
 * executeWorkflow event emission tests (Phase 9 — §57 workflow events)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb } from '../../db/client.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import { executeWorkflow } from './execution-engine.js';
import type { WorkflowNode, WorkflowEdge } from './types.js';

let cfg: BackendConfig;
let dir: string;

/** A minimal fake request whose raw.socket is never destroyed */
const fakeRequest = {
  raw: { socket: { destroyed: false } },
} as unknown as { raw: { socket: { destroyed: boolean } } };

/** Drizzle-compatible chainable query stub backed by an in-memory map */
function makeDb() {
  const runs = new Map<string, Record<string, unknown>>();
  const db = {
    _runs: runs,
    insert: () => ({ values: (v: Record<string, unknown>) => ({ run: () => { runs.set(v.id as string, v); } }) }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({ run: () => {
          for (const run of runs.values()) Object.assign(run, patch);
        } }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => {
            const first = runs.values().next().value;
            return first ? { currentNodeId: first.currentNodeId ?? null } : undefined;
          },
        }),
      }),
    }),
  };
  return db;
}

function node(id: string, label: string, type: WorkflowNode['type'] = 'tool'): WorkflowNode {
  return { id, label, type } as WorkflowNode;
}

function chain(...ids: string[]): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    edges.push({ id: `e${i}`, source: ids[i], target: ids[i + 1] } as WorkflowEdge);
  }
  return edges;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-wf-events-'));
  cfg = makeTestConfig(dir);
  await runMigrations(cfg);
  await initDb(cfg);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('executeWorkflow — event emission (§57)', () => {
  it('emits started → node.started → node.completed → completed in order', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const nodes = [node('a', 'Node A', 'tool'), node('b', 'Node B', 'tool')];

    const result = await executeWorkflow({
      workflowId: 'wf-1',
      nodes,
      edges: chain('a', 'b'),
      input: { x: 1 },
      config: cfg as never,
      db: makeDb() as never,
      saveDb: () => {},
      request: fakeRequest as never,
      executeNode: async (n) => ({ output: `out-${n.id}` }),
      onEvent: (type, payload) => events.push({ type, payload }),
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(
      events.map((e) => e.type),
      ['workflow.started', 'workflow.node.started', 'workflow.node.completed', 'workflow.node.started', 'workflow.node.completed', 'workflow.completed'],
    );

    // Payload fields
    assert.equal(events[0].payload.workflowId, 'wf-1');
    assert.ok(events[0].payload.runId);
    assert.equal(events[1].payload.nodeId, 'a');
    assert.equal(events[1].payload.nodeType, 'tool');
    assert.equal(events[2].payload.nodeId, 'a');
    assert.equal(events[3].payload.nodeId, 'b');
    assert.equal(events[5].payload.resultCount, 2);
  });

  it('emits workflow.failed when a node throws', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const nodes = [node('a', 'Node A', 'tool')];

    const result = await executeWorkflow({
      workflowId: 'wf-2',
      nodes,
      edges: [],
      input: {},
      config: cfg as never,
      db: makeDb() as never,
      saveDb: () => {},
      request: fakeRequest as never,
      executeNode: async () => { throw new Error('boom'); },
      onEvent: (type, payload) => events.push({ type, payload }),
    });

    assert.equal(result.status, 'failed');
    assert.equal(events.at(-1)!.type, 'workflow.failed');
    assert.equal((events.at(-1)!.payload.error as string).includes('boom'), true);
  });

  it('does not emit events when onEvent is omitted (backward compatible)', async () => {
    const nodes = [node('a', 'Node A', 'tool')];
    const result = await executeWorkflow({
      workflowId: 'wf-3',
      nodes,
      edges: [],
      input: {},
      config: cfg as never,
      db: makeDb() as never,
      saveDb: () => {},
      request: fakeRequest as never,
      executeNode: async (n) => ({ output: `out-${n.id}` }),
    });

    assert.equal(result.status, 'completed');
    // results keyed by node id carry the executeNode output
    const entryA = result.results.a as { output?: string };
    assert.equal(entryA.output, 'out-a');
  });
});