import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import { workflowNodeRuns, workflows } from '../../db/schema/index.js';
import { runMigrations } from '../../db/migrate.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import type { getDb } from '../../db/client.js';
import { topoSort, executeWorkflow } from './execution-engine.js';
import type { ExecuteWorkflowOptions, ExecuteWorkflowResult } from './execution-engine.js';
import type { WorkflowNode, WorkflowEdge } from './types.js';

type WorkflowDatabase = ReturnType<typeof getDb>

describe('workflows topoSort — 拓扑排序与环检测', () => {
  const node = (id: string) => ({ id, type: 'tool' as const, label: id, config: {} });

  it('DAG 正常拓扑排序', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const order = topoSort(nodes, edges);
    assert.ok(order, '应为有效的拓扑序');
    assert.equal(order!.length, 3);
    assert.ok(order!.findIndex(n => n.id === 'a') < order!.findIndex(n => n.id === 'b'));
    assert.ok(order!.findIndex(n => n.id === 'b') < order!.findIndex(n => n.id === 'c'));
  });

  it('多根 DAG：全部根节点入队', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [
      { id: 'e1', source: 'a', target: 'c' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const order = topoSort(nodes, edges);
    assert.ok(order, '应为有效的拓扑序');
    assert.equal(order!.length, 3);
  });

  it('环检测：循环依赖返回 null（fail-fast，LC-020）', () => {
    const nodes = [node('a'), node('b')];
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ];
    assert.equal(topoSort(nodes, edges), null, '循环依赖必须返回 null 以触发 fail-fast');
  });

  it('自环：单节点自引用同样返回 null', () => {
    const nodes = [node('a')];
    const edges = [{ id: 'e1', source: 'a', target: 'a' }];
    assert.equal(topoSort(nodes, edges), null);
  });

  it('孤立节点：无环图正常排序', () => {
    const nodes = [node('a'), node('b')];
    assert.equal(topoSort(nodes, [])?.length, 2);
  });
});

describe('workflows executeWorkflow — §41 受控并行 DAG + §42 条件边显式化', () => {
  const node = (id: string, type: 'tool' | 'condition' = 'tool') => ({ id, type, label: id, config: {} });
  const edge = (id: string, source: string, target: string, condition?: 'passed' | 'failed') => ({
    id, source, target, ...(condition ? { condition } : {}),
  });

  type TestNode = ReturnType<typeof node>
  type TestNodeResult = {
    readonly output: string
    readonly data?: unknown
    readonly error?: string
  }

  /** 最小 executeWorkflow 上下文：用空 db/saveDb 桩 */
  function makeOpts(
    nodes: TestNode[],
    edges: ReturnType<typeof edge>[],
    executeNode: (node: TestNode) => Promise<TestNodeResult | string>,
    signal?: AbortSignal,
  ) {
    const fakeDb = {
      update: () => ({ set: () => ({ where: () => ({ run: () => {} }) }) }),
      select: () => ({ from: () => ({ where: () => ({ get: () => ({ status: 'running' }) }) }) }),
      insert: () => ({ values: () => ({ run: () => {} }) }),
    }
    return {
      workflowId: 'wf-test',
      nodes,
      edges,
      input: {},
      config: { workflowMaxParallel: 2 },
      executeNode: (n: TestNode, _cfg: unknown, _ctx: Record<string, unknown>) => executeNode(n),
      db: {
        ...fakeDb,
        transaction: (fn: (tx: typeof fakeDb) => unknown): unknown => fn(fakeDb),
      },
      saveDb: () => {},
      request: { raw: { socket: { destroyed: false } } },
      onEvent: () => {},
      signal,
    } as never
  }

  it('§41: 多根并行节点均执行（非串行首根）', async () => {
    const executed: string[] = [];
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [
      edge('e1', 'a', 'c'),
      edge('e2', 'b', 'c'),
    ];
    const result = await executeWorkflow(makeOpts(nodes, edges, async (n) => {
      executed.push(n.id);
      return { output: `out-${n.id}` };
    }));
    assert.equal(result.status, 'completed');
    assert.ok(executed.includes('a') && executed.includes('b') && executed.includes('c'),
      `三个节点都应执行，实际: ${executed.join(',')}`);
  });

  it('§42: 条件边显式化 — passed 边走，failed 边不走', async () => {
    const executed: string[] = [];
    const nodes = [
      node('cond', 'condition'),
      node('yes'),
      node('no'),
    ];
    const edges = [
      edge('e1', 'cond', 'yes', 'passed'),
      edge('e2', 'cond', 'no', 'failed'),
    ];
    const result = await executeWorkflow(makeOpts(nodes, edges, async (n) => {
      executed.push(n.id);
      if (n.type === 'condition') return { output: '', data: { passed: true } };
      return { output: `out-${n.id}` };
    }));
    assert.equal(result.status, 'completed');
    assert.ok(executed.includes('yes'), 'passed 边目标应执行');
    assert.ok(!executed.includes('no'), 'failed 边目标不应执行（条件边显式化）');
  });

  it('Workflow 第十八部分：diamond join — D 必须等 B 和 C 全部完成', async () => {
    const executed: string[] = [];
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [
      edge('e1', 'a', 'b'),
      edge('e2', 'a', 'c'),
      edge('e3', 'b', 'd'),
      edge('e4', 'c', 'd'),
    ];
    const order: string[] = [];
    const result = await executeWorkflow(makeOpts(nodes, edges, async (n) => {
      // 模拟 b/c 慢执行：记录完成顺序，断言 d 在 b 和 c 之后
      order.push(n.id);
      await new Promise(r => setTimeout(r, n.id === 'b' ? 20 : n.id === 'c' ? 5 : 0));
      return { output: `out-${n.id}` };
    }));
    assert.equal(result.status, 'completed', 'diamond join 应正常完成');
    assert.ok(executed.length >= 4 || order.length >= 4, '四个节点都应执行');
    const idxD = order.indexOf('d');
    const idxB = order.indexOf('b');
    const idxC = order.indexOf('c');
    assert.ok(idxD > idxB && idxD > idxC,
      `D 必须等 B 和 C 全部完成（依赖 join），实际顺序: ${order.join(' → ')}`);
  });

  it('Workflow 第十八部分：multi-parent join — A/B 双父，B 未完成 D 不运行', async () => {
    const executed: string[] = [];
    const nodes = [node('a'), node('b'), node('d')];
    const edges = [
      edge('e1', 'a', 'd'),
      edge('e2', 'b', 'd'),
    ];
    // 模拟 b 执行抛错（节点失败不应导致 d 提前运行后整体仍 completed 的假象）
    const result = await executeWorkflow(makeOpts(nodes, edges, async (n) => {
      executed.push(n.id);
      if (n.id === 'b') throw new Error('b 失败（模拟）');
      return { output: `out-${n.id}` };
    }));
    // b 抛错 → 执行引擎将 b 标记为失败，d 不应提前运行（依赖 b）
    assert.ok(executed.includes('a'), 'a 应执行');
    assert.ok(executed.includes('b'), 'b 应执行（随后失败）');
    assert.ok(!executed.includes('d'), 'b 失败时 d 不应运行（multi-parent join 保护）');
  });

  it('节点返回错误字符串时 workflow 终态为 failed', async () => {
    // Given: 首个节点返回结构化错误标记，后继节点仍可被调度
    const executed: string[] = []
    const nodes = [node('a'), node('b')]
    const edges = [edge('e1', 'a', 'b')]
    const errorOutput = 'AI 调用失败: provider unavailable'

    // When
    const result = await executeWorkflow(makeOpts(nodes, edges, async (n) => {
      executed.push(n.id)
      if (n.id === 'a') return { output: errorOutput, error: errorOutput }
      return { output: `out-${n.id}` }
    }))

    // Then
    assert.equal(result.status, 'failed')
    // AEX-P0-017：error 保留节点自身原文，并附机器可读 code
    assert.deepEqual(result.results.a, {
      label: 'a',
      type: 'tool',
      output: errorOutput,
      status: 'failed',
      error: errorOutput,
      code: 'NODE_EXECUTION_FAILED',
    })
    assert.ok(!executed.includes('b'), '失败节点的下游不应继续执行')
  })

  it('同波节点单点抛错时等待其余节点收尾并阻断下游', async () => {
    // Given: a/b 同波，a 等 b 启动后抛错；c 依赖 a+b
    const executed: string[] = []
    let markBStarted = (): void => {}
    let releaseB = (): void => {}
    const bStarted = new Promise<void>((resolve) => { markBStarted = resolve })
    const bReleased = new Promise<void>((resolve) => { releaseB = resolve })
    const nodes = [node('a'), node('b'), node('c')]
    const edges = [edge('a-c', 'a', 'c'), edge('b-c', 'b', 'c')]

    // When
    const runPromise = executeWorkflow(makeOpts(nodes, edges, async (current) => {
      executed.push(current.id)
      if (current.id === 'a') {
        await bStarted
        throw new Error('a failed')
      }
      if (current.id === 'b') {
        markBStarted()
        await bReleased
      }
      return { output: `out-${current.id}` }
    }))
    await bStarted
    setImmediate(releaseB)
    const result = await runPromise

    // Then
    assert.equal(result.status, 'failed')
    assert.equal((result.results.a as { status?: string } | undefined)?.status, 'failed')
    assert.match(String((result.results.a as { error?: string } | undefined)?.error), /a failed/)
    assert.equal((result.results.b as { status?: string } | undefined)?.status, 'completed')
    assert.ok(!executed.includes('c'), '失败波次不得调度下游节点')
  })

  it('旧 executor 返回裸字符串时保守标记 failed', async () => {
    // Given
    const nodes = [node('legacy'), node('downstream')]
    const edges = [edge('legacy-downstream', 'legacy', 'downstream')]

    // When
    const result = await executeWorkflow(makeOpts(nodes, edges, async (current) =>
      current.id === 'legacy' ? 'legacy output' : { output: 'should not run' }
    ))

    // Then
    assert.equal(result.status, 'failed')
    assert.equal((result.results.legacy as { status?: string } | undefined)?.status, 'failed')
    assert.match(String((result.results.legacy as { error?: string } | undefined)?.error), /未结构化/)
  })

  it('取消后不再推进后续节点', async () => {
    // Given: 首个节点运行中，第二个节点位于下一波
    const controller = new AbortController()
    const executed: string[] = []
    const nodes = [node('a'), node('b')]
    const edges = [edge('e1', 'a', 'b')]
    let markStarted = (): void => {}
    let releaseFirst = (): void => {}
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve })
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve })

    // When: 首节点未结束时取消，再允许当前波次收尾
    const runPromise = executeWorkflow(makeOpts(nodes, edges, async (n) => {
      executed.push(n.id)
      if (n.id === 'a') {
        markStarted()
        await firstReleased
      }
      return { output: `out-${n.id}` }
    }, controller.signal))
    await firstStarted
    controller.abort()
    releaseFirst()
    const result = await runPromise

    // Then
    assert.equal(result.status, 'cancelled')
    assert.notEqual(result.status, 'completed')
    assert.ok(!executed.includes('b'), '取消后下一波节点不应执行')
  })
});

/**
 * AEX-P0-015 / P0-017 / P0-018 —— 节点级持久化 + 结构化错误 + 节点重试。
 * 用真实 sql.js（与 execution-engine.db.test.ts 一致）而非内存桩，
 * 因为断言对象是 workflow_node_runs 的真实行与 FK 行为。
 */
describe('workflow executeWorkflow — 节点级持久化与重试（AEX-P0-015/017/018）', () => {
  type NodeRunDatabase = {
    readonly db: WorkflowDatabase
    readonly config: BackendConfig
    readonly sqlDb: SqlJsDatabase
    readonly cleanup: () => void
  }

  const WORKFLOW_ID = 'wf-node-runs'

  async function createNodeRunDatabase(): Promise<NodeRunDatabase> {
    const dir = mkdtempSync(join(tmpdir(), 'aether-wf-node-run-'))
    const config = makeTestConfig(dir)
    await runMigrations(config)
    const SQL = await initSqlJs()
    const sqlDb = new SQL.Database(readFileSync(config.dbPath))
    sqlDb.run('PRAGMA foreign_keys = ON')
    const db: WorkflowDatabase = drizzle(sqlDb, { schema })
    const now = new Date().toISOString()
    db.insert(workflows).values({
      id: WORKFLOW_ID,
      name: WORKFLOW_ID,
      description: '',
      nodes: '[]',
      edges: '[]',
      trigger: 'manual',
      createdAt: now,
      updatedAt: now,
    }).run()
    return {
      db,
      config,
      sqlDb,
      cleanup: () => {
        sqlDb.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  const nodeOf = (id: string): WorkflowNode => ({ id, type: 'tool', label: id, config: {} })

  function runOn(
    database: NodeRunDatabase,
    nodes: WorkflowNode[],
    options: {
      readonly executeNode: ExecuteWorkflowOptions['executeNode']
      readonly edges?: WorkflowEdge[]
      readonly signal?: AbortSignal
      readonly onEvent?: ExecuteWorkflowOptions['onEvent']
    },
  ): Promise<ExecuteWorkflowResult> {
    return executeWorkflow({
      workflowId: WORKFLOW_ID,
      nodes,
      edges: options.edges ?? [],
      input: {},
      config: Object.assign({}, database.config, { workflowNodeRetryBaseDelayMs: 1 }),
      executeNode: options.executeNode,
      db: database.db,
      saveDb: () => {},
      request: { raw: { socket: { destroyed: false } } },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    })
  }

  function nodeRunRows(db: WorkflowDatabase, runId: string) {
    return db.select().from(workflowNodeRuns)
      .where(eq(workflowNodeRuns.workflowRunId, runId))
      .all()
  }

  function nodeRunRow(db: WorkflowDatabase, runId: string, nodeId: string) {
    return db.select().from(workflowNodeRuns).where(and(
      eq(workflowNodeRuns.workflowRunId, runId),
      eq(workflowNodeRuns.nodeId, nodeId),
    )).get()
  }

  it('P0-015: 并行节点各自独立成行（互不覆盖），状态/attempt 正确', async () => {
    // Given: 同波并行的两个节点
    const database = await createNodeRunDatabase()
    try {
      // When
      const result = await runOn(database, [nodeOf('a'), nodeOf('b')], {
        executeNode: async (current) => ({ output: `out-${current.id}` }),
      })

      // Then: 每节点一行，status=completed / attempt=1 / retryCount=0
      assert.equal(result.status, 'completed')
      const rows = nodeRunRows(database.db, result.runId)
      assert.equal(rows.length, 2, `每个节点应独立成行，实际 ${rows.length} 行`)
      for (const id of ['a', 'b']) {
        const row = nodeRunRow(database.db, result.runId, id)
        assert.ok(row, `节点 ${id} 应有独立行`)
        assert.equal(row!.status, 'completed')
        assert.equal(row!.attempt, 1)
        assert.equal(row!.retryCount, 0)
        assert.equal(row!.output, `out-${id}`)
        assert.ok(row!.startedAt, 'startedAt 应写入')
        assert.ok(row!.completedAt, 'completedAt 应写入')
        assert.equal(row!.error, null)
      }
    } finally {
      database.cleanup()
    }
  })

  it('P0-017 回归: 节点返回结构化失败时写 failed 行而非 completed', async () => {
    // Given: tool 节点返回 executeFileTool 的 错误: 前缀输出（已结构化为 error + code）
    const database = await createNodeRunDatabase()
    try {
      // When
      const result = await runOn(database, [nodeOf('a')], {
        executeNode: async () => ({
          output: '错误: 文件不存在: /tmp/missing.txt',
          error: '错误: 文件不存在: /tmp/missing.txt',
          code: 'TOOL_ERROR',
        }),
      })

      // Then
      assert.equal(result.status, 'failed')
      assert.equal(result.results.a?.status, 'failed')
      assert.equal(result.results.a?.code, 'TOOL_ERROR')
      const row = nodeRunRow(database.db, result.runId, 'a')
      assert.equal(row?.status, 'failed')
      assert.match(String(row?.error), /错误: 文件不存在/)
      assert.ok(row?.completedAt, '失败节点也应写入 completedAt')
    } finally {
      database.cleanup()
    }
  })

  it('P0-018: 可重试节点失败后重试成功 → retryCount=1 且最终 completed', async () => {
    // Given: 首次返回 NETWORK_ERROR（可重试），第二次成功
    const database = await createNodeRunDatabase()
    try {
      let attempts = 0
      const events: Array<{ type: string; payload: Record<string, unknown> }> = []

      // When
      const result = await runOn(database, [nodeOf('a')], {
        onEvent: (type, payload) => { events.push({ type, payload }) },
        executeNode: async () => {
          attempts += 1
          if (attempts === 1) {
            return { output: '', error: '网络暂时不可用', code: 'NETWORK_ERROR', retryable: true }
          }
          return { output: 'ok' }
        },
      })

      // Then
      assert.equal(attempts, 2, '可重试失败应触发第二次尝试')
      assert.equal(result.status, 'completed')
      const row = nodeRunRow(database.db, result.runId, 'a')
      assert.equal(row?.status, 'completed')
      assert.equal(row?.retryCount, 1)
      assert.equal(row?.attempt, 2)
      assert.equal(row?.output, 'ok')
      const retryTypes = events.map((event) => event.type).filter((type) => type.includes('retry'))
      assert.ok(retryTypes.includes('workflow.node.retry.scheduled'),
        `应通过 onEvent 发出 retry.scheduled，实际: ${events.map((e) => e.type).join(',')}`)
      assert.ok(retryTypes.includes('workflow.node.retry.completed'),
        '重试成功后应发出 retry.completed')
    } finally {
      database.cleanup()
    }
  })

  it('P0-018: 不可重试失败不重试（attempt 保持 1）', async () => {
    // Given: 确定性失败（TOOL_ERROR / retryable=false）
    const database = await createNodeRunDatabase()
    try {
      let attempts = 0

      // When
      const result = await runOn(database, [nodeOf('a')], {
        executeNode: async () => {
          attempts += 1
          return { output: '未知工具: nope', error: '未知工具: nope', code: 'TOOL_NOT_FOUND', retryable: false }
        },
      })

      // Then
      assert.equal(attempts, 1, '不可重试失败不应重复执行')
      assert.equal(result.status, 'failed')
      const row = nodeRunRow(database.db, result.runId, 'a')
      assert.equal(row?.retryCount, 0)
      assert.equal(row?.attempt, 1)
      assert.equal(row?.status, 'failed')
    } finally {
      database.cleanup()
    }
  })

  it('P0-015/016: 取消后不再推进后续节点，且不为未执行节点建行', async () => {
    // Given: 节点 a 运行中取消，节点 b 在下一波
    const database = await createNodeRunDatabase()
    try {
      const controller = new AbortController()
      let markStarted = (): void => {}
      let releaseNode = (): void => {}
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const released = new Promise<void>((resolve) => { releaseNode = resolve })

      // When: a → b 有边，b 位于下一波
      const runPromise = runOn(database, [nodeOf('a'), nodeOf('b')], {
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        signal: controller.signal,
        executeNode: async (current) => {
          if (current.id === 'a') {
            markStarted()
            await released
          }
          return { output: `out-${current.id}` }
        },
      })
      await started
      controller.abort()
      releaseNode()
      const result = await runPromise

      // Then
      assert.equal(result.status, 'cancelled')
      const rows = nodeRunRows(database.db, result.runId)
      assert.equal(rows.length, 1, `只为已启动节点建行，实际 ${rows.length} 行`)
      assert.equal(rows[0]?.nodeId, 'a')
      assert.equal(nodeRunRow(database.db, result.runId, 'b'), undefined, '未执行的节点不应有行')
    } finally {
      database.cleanup()
    }
  })

  it('P0-016: 请求断开（socket.destroyed）→ cancelled 终态而非 failed', async () => {
    // Given: 首节点完成后连接已断开
    const database = await createNodeRunDatabase()
    try {
      const request = { raw: { socket: { destroyed: false } } }
      const result = await executeWorkflow({
        workflowId: WORKFLOW_ID,
        nodes: [nodeOf('a')],
        edges: [],
        input: {},
        config: Object.assign({}, database.config, { workflowNodeRetryBaseDelayMs: 1 }),
        executeNode: async (current) => {
          request.raw.socket.destroyed = true
          return { output: `out-${current.id}` }
        },
        db: database.db,
        saveDb: () => {},
        request,
      })

      // Then: 断开等同取消，不是失败
      assert.equal(result.status, 'cancelled')
      assert.equal(
        database.db.select().from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, result.runId)).get()?.status,
        'cancelled',
      )
    } finally {
      database.cleanup()
    }
  })
});
