/**
 * T6 数据修复步骤（repair-steps）单元测试。
 *
 * 覆盖口径：
 * - 孤立消息：清理无对应 conversation 的历史脏数据，正常消息必须保留
 * - 幽灵序号占位行：活跃 Run 的 __seq_claim 绝不删除（防 seq 回退破坏直播流）
 * - 陈旧 Run：崩溃遗留的 running → interrupted，新鲜 Run 不动
 * - 临时文件：只删 >1h 的 pacc.db.tmp.*，.bak / .corrupt.* 永不删除
 * - 批次语义：单步失败不中断后续步骤；ids 只执行指定步骤；事务失败整体回滚
 *
 * 所有用例都在 mkdtemp 临时目录 + 内存 sql.js 上运行，绝不触碰用户 data/pacc.db。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { initDb, getDb, setDbForTest } from '../../db/client.js'
import { runMigrations } from '../../db/migrate.js'
import { conversations, events, messages, providers, runs } from '../../db/schema/index.js'
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js'
import type { BackendConfig } from '../../config/index.js'
import {
  REPAIR_STEPS,
  repairDatabaseFlush,
  repairGhostSequenceClaims,
  repairOrphanMessages,
  repairOrphanTempFiles,
  repairStaleRuns,
  runRepairSteps,
} from './repair-steps.js'

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

let dir: string
let cfg: BackendConfig

function nowIso(): string {
  return new Date().toISOString()
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function seedConversation(id: string): void {
  getDb().insert(conversations).values({
    id,
    title: id,
    providerId: null,
    model: 'test-model',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }).run()
}

function seedRun(id: string, status: 'created' | 'running' | 'interrupted'): void {
  getDb().insert(runs).values({
    id,
    status,
    mode: 'normal',
    createdAt: nowIso(),
    lastUpdatedAt: nowIso(),
  }).run()
}

/** 插入一条序号占位行（模拟 allocate() 成功后进程崩溃、来不及写入真实事件） */
function insertClaim(runId: string, seq: number): void {
  getDb().insert(events).values({
    id: `claim-${runId}-${seq}`,
    runId,
    seq,
    eventType: '__seq_claim',
    eventVersion: 1,
    payload: '{}',
    createdAt: nowIso(),
  }).run()
}

function claimIdsOf(runId: string): string[] {
  return getDb()
    .select({ id: events.id })
    .from(events)
    .where(eq(events.runId, runId))
    .all()
    .map(row => row.id)
}

function messageIds(): string[] {
  return getDb()
    .select({ id: messages.id })
    .from(messages)
    .all()
    .map(row => row.id)
    .sort()
}

function runStatusOf(id: string): string | undefined {
  return getDb()
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, id))
    .get()?.status
}

/**
 * 当前 schema 已给 messages.conversation_id / events.run_id 加了外键，
 * 而"孤立行"只可能来自迁移前的历史脏数据 —— 造数据时必须临时关闭外键。
 */
function withForeignKeysDisabled(fn: () => void): void {
  const db = getDb()
  db.run('PRAGMA foreign_keys = OFF')
  try {
    fn()
  } finally {
    db.run('PRAGMA foreign_keys = ON')
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-repair-'))
  cfg = makeTestConfig(dir)
  await runMigrations(cfg)
  setDbForTest(await initDb(cfg))
})

after(() => {
  setDbForTest(null)
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.delete(events).run()
  db.delete(messages).run()
  db.delete(runs).run()
  db.delete(conversations).run()
})

describe('selfcheck/repair-steps', () => {
  it('repairOrphanMessages 删除无对应会话的消息，保留正常消息', () => {
    const db = getDb()
    seedConversation('conv-keep')
    db.insert(messages).values({
      id: 'msg-keep',
      conversationId: 'conv-keep',
      role: 'user',
      content: '正常消息',
      createdAt: nowIso(),
    }).run()
    withForeignKeysDisabled(() => {
      db.insert(messages).values([
        { id: 'msg-orphan-1', conversationId: 'conv-gone', role: 'user', content: '孤立 1', createdAt: nowIso() },
        { id: 'msg-orphan-2', conversationId: 'conv-gone', role: 'assistant', content: '孤立 2', createdAt: nowIso() },
      ]).run()
    })

    const result = repairOrphanMessages({ config: cfg })

    assert.equal(result.id, 'orphan-messages')
    assert.equal(result.outcome, 'fixed')
    assert.equal(result.changed, 2)
    assert.deepEqual(messageIds(), ['msg-keep'], '只清理孤立消息，正常消息必须保留')
  })

  it('repairOrphanMessages 无孤立消息时 outcome=already-healthy 且 changed=0', () => {
    const db = getDb()
    seedConversation('conv-ok')
    db.insert(messages).values({
      id: 'msg-ok',
      conversationId: 'conv-ok',
      role: 'user',
      content: '正常消息',
      createdAt: nowIso(),
    }).run()

    const result = repairOrphanMessages({ config: cfg })

    assert.equal(result.outcome, 'already-healthy')
    assert.equal(result.changed, 0)
    assert.deepEqual(messageIds(), ['msg-ok'])
  })

  it('repairGhostSequenceClaims 保留活跃 Run 的占位行（防 seq 回退破坏直播流）', () => {
    seedRun('run-live', 'running')
    insertClaim('run-live', 1)

    const result = repairGhostSequenceClaims({ config: cfg })

    assert.equal(result.outcome, 'already-healthy')
    assert.equal(result.changed, 0)
    assert.deepEqual(claimIdsOf('run-live'), ['claim-run-live-1'], '活跃 Run 的占位行绝不能删除')
    assert.equal(runStatusOf('run-live'), 'running')
  })

  it('repairGhostSequenceClaims 删除已终止 Run 的悬空占位行', () => {
    seedRun('run-dead', 'interrupted')
    insertClaim('run-dead', 1)

    const result = repairGhostSequenceClaims({ config: cfg })

    assert.equal(result.outcome, 'fixed')
    assert.equal(result.changed, 1)
    assert.deepEqual(claimIdsOf('run-dead'), [], '已终止 Run 不可能再分配序号，占位行可安全清理')
  })

  it('repairGhostSequenceClaims 删除 run_id 无对应 runs 行的占位行', () => {
    withForeignKeysDisabled(() => insertClaim('run-vanished', 1))

    const result = repairGhostSequenceClaims({ config: cfg })

    assert.equal(result.outcome, 'fixed')
    assert.equal(result.changed, 1)
    assert.deepEqual(claimIdsOf('run-vanished'), [])
  })

  it('repairStaleRuns 把陈旧 running Run 标记为 interrupted，新鲜 Run 不动', () => {
    const db = getDb()
    db.insert(runs).values([
      { id: 'run-stale', status: 'running', mode: 'normal', createdAt: isoAgo(TWO_HOURS_MS), lastUpdatedAt: isoAgo(TWO_HOURS_MS) },
      { id: 'run-fresh', status: 'running', mode: 'normal', createdAt: nowIso(), lastUpdatedAt: nowIso() },
    ]).run()

    const result = repairStaleRuns({ config: cfg })

    assert.equal(result.outcome, 'fixed')
    assert.equal(result.changed, 1)
    assert.equal(runStatusOf('run-stale'), 'interrupted')
    assert.equal(runStatusOf('run-fresh'), 'running', '新鲜 Run 不在 stale lease 内，不能动')
  })

  it('repairOrphanTempFiles 删除陈旧 pacc.db.tmp.*，保留新鲜临时文件与 .bak / .corrupt.*', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pacc-repair-tmpfiles-'))
    const staleTmp = join(tmpDir, 'pacc.db.tmp.stale')
    const freshTmp = join(tmpDir, 'pacc.db.tmp.fresh')
    writeFileSync(staleTmp, 'stale')
    writeFileSync(freshTmp, 'fresh')
    writeFileSync(join(tmpDir, 'pacc.db.bak'), 'migration snapshot')
    writeFileSync(join(tmpDir, 'pacc.db.corrupt.1700000000000'), 'corrupt backup')
    const oldTime = new Date(Date.now() - TWO_HOURS_MS)
    utimesSync(staleTmp, oldTime, oldTime)

    const result = repairOrphanTempFiles({ config: makeTestConfig(tmpDir) })

    assert.equal(result.outcome, 'fixed')
    assert.equal(result.changed, 1)
    assert.equal(existsSync(staleTmp), false, '超过 1h 的落盘临时文件应清理')
    assert.equal(existsSync(freshTmp), true, '1h 内的临时文件可能正在落盘，不能删')
    assert.equal(existsSync(join(tmpDir, 'pacc.db.bak')), true, '迁移快照永不删除')
    assert.equal(existsSync(join(tmpDir, 'pacc.db.corrupt.1700000000000')), true, '损坏库备份永不删除')
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('repairDatabaseFlush 强制落盘后数据库文件存在且可读', async () => {
    getDb().insert(providers).values({
      id: 'p-flush',
      name: 'flush-test',
      type: 'openai',
      apiKey: 'enc:test',
      models: JSON.stringify(['m']),
      capabilities: JSON.stringify(['text']),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }).run()

    const result = repairDatabaseFlush({ config: cfg })

    assert.notEqual(result.outcome, 'failed')
    assert.equal(existsSync(cfg.dbPath), true)
    const buffer = readFileSync(cfg.dbPath)
    assert.ok(buffer.length > 0, '落盘文件不能为空')
    const SQL = await initSqlJs()
    const reopened = new SQL.Database(buffer)
    const tables = reopened.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
    assert.equal(tables[0]?.values.length, 1, '落盘内容必须是可读的 SQLite 库')
    reopened.close()
  })

  it('runRepairSteps 单步失败不中断后续步骤（失败步骤 outcome=failed）', async () => {
    const brokenRoot = mkdtempSync(join(tmpdir(), 'pacc-repair-broken-'))
    const brokenDataDir = join(brokenRoot, 'data')
    mkdirSync(brokenDataDir)
    // dbPath 指向一个目录 → rename 与直写都失败 → 落盘步骤必然 failed
    mkdirSync(join(brokenDataDir, 'pacc.db'))
    const brokenCfg: BackendConfig = {
      ...cfg,
      dataDir: brokenDataDir,
      dbPath: join(brokenDataDir, 'pacc.db'),
    }

    const results = await runRepairSteps({ config: brokenCfg })

    assert.equal(results.length, REPAIR_STEPS.length, '失败步骤不得缩短批次')
    const failed = results.filter(result => result.outcome === 'failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0]?.id, 'database-flush')
    const failedIndex = results.findIndex(result => result.id === 'database-flush')
    assert.deepEqual(
      results.slice(failedIndex + 1).map(result => result.id),
      ['orphan-messages', 'stale-runs', 'orphan-workflow-runs', 'ghost-seq-claims', 'in-memory-caches', 'orphan-temp-files', 'sync_runtime'],
      '失败步骤之后的所有步骤必须照常执行',
    )
    rmSync(brokenRoot, { recursive: true, force: true })
  })

  it('runRepairSteps ids 过滤只执行指定步骤', async () => {
    const results = await runRepairSteps({ config: cfg }, ['orphan-temp-files'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.id, 'orphan-temp-files')
  })

  it('repairOrphanMessages 事务失败时整体回滚，不留下部分删除', () => {
    const db = getDb()
    withForeignKeysDisabled(() => {
      db.insert(messages).values([
        { id: 'msg-tx-a', conversationId: 'conv-gone', role: 'user', content: 'a', createdAt: nowIso() },
        { id: 'msg-tx-b', conversationId: 'conv-gone', role: 'user', content: 'b', createdAt: nowIso() },
      ]).run()
    })
    db.run(
      "CREATE TRIGGER trg_block_msg_delete BEFORE DELETE ON messages WHEN OLD.id = 'msg-tx-b' BEGIN SELECT RAISE(ABORT, 'blocked-by-test'); END",
    )

    const result = repairOrphanMessages({ config: cfg })
    db.run('DROP TRIGGER trg_block_msg_delete')

    assert.equal(result.outcome, 'failed')
    assert.match(result.detail, /blocked-by-test/)
    assert.deepEqual(messageIds(), ['msg-tx-a', 'msg-tx-b'], '事务失败必须整体回滚')
  })
})