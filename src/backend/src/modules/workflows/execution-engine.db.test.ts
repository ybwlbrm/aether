import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
import { eq } from 'drizzle-orm'
import * as schema from '../../db/schema/index.js'
import { runs, workflows, workflowRuns } from '../../db/schema/index.js'
import { runMigrations } from '../../db/migrate.js'
import type { getDb } from '../../db/client.js'
import { RunLifecycleManager } from '../../core/runtime/index.js'
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js'
import type { BackendConfig } from '../../config/index.js'
import {
  executeWorkflow,
  type ExecuteWorkflowOptions,
  type ExecuteWorkflowResult,
} from './execution-engine.js'
import { createWorkflowRunInternal } from './store.js'
import type { WorkflowNode } from './types.js'

type WorkflowDatabase = ReturnType<typeof getDb>
type NodeExecutor = ExecuteWorkflowOptions['executeNode']

type TestDatabase = {
  readonly db: WorkflowDatabase
  readonly config: BackendConfig
  readonly sqlDb: SqlJsDatabase
  readonly cleanup: () => void
}

type RunWorkflowInput = {
  readonly database: TestDatabase
  readonly workflowId: string
  readonly nodes: WorkflowNode[]
  readonly executor: NodeExecutor
  readonly signal?: AbortSignal
}

async function createTestDatabase(): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'aether-workflow-db-'))
  const config = makeTestConfig(dir)
  await runMigrations(config)
  const SQL = await initSqlJs()
  const sqlDb = new SQL.Database(readFileSync(config.dbPath))
  sqlDb.run('PRAGMA foreign_keys = ON')
  const db: WorkflowDatabase = drizzle(sqlDb, { schema })
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

function seedWorkflow(db: WorkflowDatabase, workflowId: string): void {
  const now = new Date().toISOString()
  db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    nodes: '[]',
    edges: '[]',
    trigger: 'manual',
    createdAt: now,
    updatedAt: now,
  }).run()
}

function node(id: string): WorkflowNode {
  return { id, type: 'tool', label: id, config: {} }
}

function runWorkflow(input: RunWorkflowInput): Promise<ExecuteWorkflowResult> {
  const options: ExecuteWorkflowOptions = {
    workflowId: input.workflowId,
    nodes: input.nodes,
    edges: [],
    input: {},
    config: input.database.config,
    executeNode: input.executor,
    db: input.database.db,
    saveDb: () => {},
    request: { raw: { socket: { destroyed: false } } },
    ...(input.signal ? { signal: input.signal } : {}),
  }
  return executeWorkflow(options)
}

function runStatus(db: WorkflowDatabase, runId: string): string | undefined {
  return db.select().from(runs).where(eq(runs.id, runId)).get()?.status
}

function workflowRunStatus(db: WorkflowDatabase, runId: string): string | undefined {
  return db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()?.status
}

describe('workflow executeWorkflow — 真实 SQLite 终态一致性', () => {
  it('成功执行时 runs 与 workflow_runs 都写入 completed', async () => {
    const database = await createTestDatabase()
    try {
      seedWorkflow(database.db, 'workflow-success')
      const result = await runWorkflow({
        database,
        workflowId: 'workflow-success',
        nodes: [node('a')],
        executor: async (current) => ({ output: `out-${current.id}` }),
      })

      assert.equal(result.status, 'completed')
      assert.equal(runStatus(database.db, result.runId), 'completed')
      assert.equal(workflowRunStatus(database.db, result.runId), 'completed')
    } finally {
      database.cleanup()
    }
  })

  it('单节点失败时两张运行表与返回值都写入 failed', async () => {
    const database = await createTestDatabase()
    try {
      seedWorkflow(database.db, 'workflow-failure')
      const result = await runWorkflow({
        database,
        workflowId: 'workflow-failure',
        nodes: [node('a')],
        executor: async () => ({ output: 'node failed', error: 'node failed' }),
      })

      assert.equal(result.status, 'failed')
      assert.equal(result.results.a?.status, 'failed')
      assert.match(result.results.a?.error ?? '', /node failed/)
      assert.equal(runStatus(database.db, result.runId), 'failed')
      assert.equal(workflowRunStatus(database.db, result.runId), 'failed')
    } finally {
      database.cleanup()
    }
  })

  it('执行中取消时返回值与两张运行表保持 cancelled', async () => {
    const database = await createTestDatabase()
    try {
      seedWorkflow(database.db, 'workflow-cancelled')
      const controller = new AbortController()
      let markStarted = (): void => {}
      let releaseNode = (): void => {}
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const released = new Promise<void>((resolve) => { releaseNode = resolve })
      const runPromise = runWorkflow({
        database,
        workflowId: 'workflow-cancelled',
        nodes: [node('a')],
        signal: controller.signal,
        executor: async () => {
          markStarted()
          await released
          return { output: 'node finished after cancellation' }
        },
      })
      await started
      controller.abort()
      releaseNode()
      const result = await runPromise

      assert.equal(result.status, 'cancelled')
      assert.equal(runStatus(database.db, result.runId), 'cancelled')
      assert.equal(workflowRunStatus(database.db, result.runId), 'cancelled')
    } finally {
      database.cleanup()
    }
  })

  it('外部已取消的 Run 发生非法转移时仍返回 cancelled', async () => {
    const database = await createTestDatabase()
    try {
      seedWorkflow(database.db, 'workflow-external-cancel')
      const result = await runWorkflow({
        database,
        workflowId: 'workflow-external-cancel',
        nodes: [node('a')],
        executor: async () => {
          const currentRun = database.db.select().from(runs).get()
          if (!currentRun) throw new Error('workflow run not found')
          new RunLifecycleManager(database.db).transition(currentRun.id, 'cancel', {
            error: 'external cancellation',
          })
          return { output: 'node completed' }
        },
      })

      assert.equal(result.status, 'cancelled')
      assert.equal(runStatus(database.db, result.runId), 'cancelled')
      assert.equal(workflowRunStatus(database.db, result.runId), 'cancelled')
    } finally {
      database.cleanup()
    }
  })

  it('runs 终态写入失败时 executeWorkflow 返回 failed 并保留失败信息', async () => {
    const database = await createTestDatabase()
    try {
      seedWorkflow(database.db, 'workflow-terminal-write-failure')
      database.sqlDb.run(`
        CREATE TRIGGER fail_completed_run_terminal
        BEFORE UPDATE OF status ON runs
        WHEN NEW.status = 'completed'
        BEGIN
          SELECT RAISE(ABORT, 'forced terminal write failure');
        END
      `)
      const result = await runWorkflow({
        database,
        workflowId: 'workflow-terminal-write-failure',
        nodes: [node('a')],
        executor: async () => ({ output: 'done' }),
      })

      assert.equal(result.status, 'failed')
      assert.match(result.error ?? '', /forced terminal write failure/)
      assert.equal(runStatus(database.db, result.runId), 'failed')
      assert.equal(workflowRunStatus(database.db, result.runId), 'failed')
    } finally {
      database.cleanup()
    }
  })

  it('runs 终态回退写入也失败时 executeWorkflow 抛错且事务不产生半终态', async () => {
    const database = await createTestDatabase()
    try {
      seedWorkflow(database.db, 'workflow-terminal-rollback')
      const runPromise = runWorkflow({
        database,
        workflowId: 'workflow-terminal-rollback',
        nodes: [node('a')],
        executor: async () => {
          database.sqlDb.run(`
            CREATE TRIGGER block_all_run_terminal
            BEFORE UPDATE OF status ON runs
            WHEN OLD.status = 'running'
            BEGIN
              SELECT RAISE(ABORT, 'forced run terminal fallback failure');
            END
          `)
          return { output: 'done' }
        },
      })

      await assert.rejects(runPromise, /forced run terminal fallback failure/)
      assert.equal(runStatus(database.db, database.db.select().from(runs).get()?.id ?? ''), 'running')
      assert.equal(workflowRunStatus(database.db, database.db.select().from(runs).get()?.id ?? ''), 'running')
    } finally {
      database.cleanup()
    }
  })

  it('workflow_runs 终态更新失败时 executeWorkflow 抛错并回滚 runs', async () => {
    const database = await createTestDatabase()
    try {
      seedWorkflow(database.db, 'workflow-run-terminal-rollback')
      database.sqlDb.run(`
        CREATE TRIGGER block_completed_workflow_run_terminal
        BEFORE UPDATE OF status ON workflow_runs
        WHEN NEW.status = 'completed'
        BEGIN
          SELECT RAISE(ABORT, 'forced workflow run terminal failure');
        END
      `)
      const runPromise = runWorkflow({
        database,
        workflowId: 'workflow-run-terminal-rollback',
        nodes: [node('a')],
        executor: async () => ({ output: 'done' }),
      })

      await assert.rejects(runPromise, /forced workflow run terminal failure/)
      const currentRun = database.db.select().from(runs).get()
      assert.equal(currentRun?.status, 'running')
      assert.equal(workflowRunStatus(database.db, currentRun?.id ?? ''), 'running')
    } finally {
      database.cleanup()
    }
  })

  it('workflow_runs 插入失败时注入 db 的 runs 创建一起回滚', async () => {
    const database = await createTestDatabase()
    try {
      await assert.rejects(() => createWorkflowRunInternal({
        workflowId: 'missing-workflow',
        firstNodeId: 'a',
        config: database.config,
        db: database.db,
        saveDb: () => {},
      }))

      assert.equal(database.db.select().from(runs).all().length, 0)
    } finally {
      database.cleanup()
    }
  })
})
