/**
 * 自检模块（selfcheck）单元测试 —— 覆盖诉求3「一键修复」新增的端点与报告构建。
 *
 * 覆盖口径：
 * - buildSelfCheckReport：未配置同步时「远程同步」必须是 error 且 summary.passed=false
 *   （这是前端「一键修复」按钮的显隐信号），且既有检查名一个都不能因重构丢失
 * - POST /api/selfcheck/repair：未知步骤 id → 400（不静默忽略，避免前端误以为已修复）
 * - runRepairSteps：['sync_runtime'] 未配置时 skipped 且不抛错；ids 过滤只跑指定步骤
 *
 * 本文件用裸 Fastify 实例 + inject（无监听端口），只注册 selfcheck 路由 —— 不走
 * buildApp，因而也不需要 auth-guard / 静态资源，与 runs/routes.test.ts 的做法一致。
 * 所有用例都在 mkdtemp 临时目录上运行，绝不触碰用户 data/pacc.db。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendConfig } from '../../config/index.js'
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js'
import { registerSelfCheckRoutes } from './index.js'
import { buildSelfCheckReport } from './selfcheck-report.js'
import { runRepairSteps } from './repair-steps.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

let dir: string
let cfg: BackendConfig
let app: FastifyInstance

interface ReportBody {
  timestamp: string
  summary: { total: number; ok: number; warn: number; error: number; passed: boolean }
  checks: { name: string; status: 'ok' | 'warn' | 'error'; detail: string }[]
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-selfcheck-'))
  cfg = makeTestConfig(dir)
  app = Fastify()
  registerSelfCheckRoutes(app, cfg)
  await app.ready()
})

after(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('selfcheck/buildSelfCheckReport', () => {
  it('未配置同步时「远程同步」为 error 且 summary.passed=false', async () => {
    const report = await buildSelfCheckReport(cfg)

    const sync = report.checks.find(check => check.name === '远程同步')
    assert.ok(sync, '必须包含「远程同步」检查项')
    assert.equal(sync.status, 'error')
    assert.equal(sync.detail, '未配置同步，手机端无法下发命令（请在「设置 → 同步」中连接 Supabase）')
    assert.equal(report.summary.passed, false, '未配置同步是 error 级信号，报告不得判为通过')
    assert.equal(report.summary.error, report.checks.filter(check => check.status === 'error').length)
    assert.equal(report.summary.total, report.checks.length)
  })

  it('既有检查名一个都不能因重构丢失（回归保护）', async () => {
    const report = await buildSelfCheckReport(cfg)
    const names = report.checks.map(check => check.name)

    for (const expected of ['数据库文件', '设置文件', 'AI Provider', '数据完整性', '远程同步', '依赖完整性']) {
      assert.ok(names.includes(expected), `缺少既有检查项: ${expected}`)
    }
    assert.ok(!names.includes('数据目录'), 'dataDir 存在时不再输出「数据目录」检查项')
    assert.ok(!names.includes(''), '检查项名称不得为空')
  })

  it('GET /api/selfcheck 返回同一份报告结构', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/selfcheck' })
    assert.equal(res.statusCode, 200)

    const body = res.json() as ReportBody
    assert.equal(body.summary.total, body.checks.length)
    assert.equal(body.summary.passed, false)
    assert.ok(body.checks.some(check => check.name === '远程同步'))
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)), 'timestamp 必须是可解析的 ISO 时间')
  })
})

describe('selfcheck/repair', () => {
  it('POST /api/selfcheck/repair 未知步骤 id → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/selfcheck/repair',
      headers: JSON_HEADERS,
      payload: { steps: ['not-a-real-step'] },
    })

    assert.equal(res.statusCode, 400)
    const body = res.json() as { error: { message: string } }
    assert.equal(body.error.message, '未知的修复步骤: not-a-real-step')
  })

  it('POST /api/selfcheck/repair 合法步骤 → 200 且 summary 按 outcome 分组', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/selfcheck/repair',
      headers: JSON_HEADERS,
      payload: { steps: ['sync_runtime'] },
    })

    assert.equal(res.statusCode, 200)
    const body = res.json() as {
      summary: { total: number; fixed: number; alreadyHealthy: number; skipped: number; failed: number }
      steps: { id: string; outcome: string }[]
      selfcheck: ReportBody
    }
    assert.equal(body.summary.total, 1)
    assert.equal(body.steps[0]?.id, 'sync_runtime')
    assert.equal(body.summary.fixed + body.summary.alreadyHealthy + body.summary.skipped + body.summary.failed, body.summary.total)
    assert.ok(body.selfcheck.checks.some(check => check.name === '远程同步'), '修复后必须回传同一份自检报告')
  })
})

describe('selfcheck/runRepairSteps', () => {
  it("runRepairSteps(['sync_runtime']) 未配置同步时 → skipped 且不抛错", async () => {
    const results = await runRepairSteps({ config: cfg }, ['sync_runtime'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.id, 'sync_runtime')
    assert.equal(results[0]?.outcome, 'skipped')
    assert.equal(results[0]?.changed, 0)
  })

  it("runRepairSteps(['db_flush']) → 只执行 1 步（id 允许下划线写法）", async () => {
    const results = await runRepairSteps({ config: cfg }, ['db_flush'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.id, 'database-flush')
  })
})