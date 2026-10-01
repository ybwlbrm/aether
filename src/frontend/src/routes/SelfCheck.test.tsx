import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as SelfCheckModule from './SelfCheck'
import type { RepairReport } from '../api/client'

const SOURCE_PATH = fileURLToPath(new URL('./SelfCheck.tsx', import.meta.url))

const REPAIR_REPORT: RepairReport = {
  timestamp: '2026-01-01T00:00:00.000Z',
  summary: { total: 4, fixed: 1, alreadyHealthy: 1, skipped: 1, failed: 1 },
  steps: [
    { id: 'stale-runs', label: '崩溃遗留 Run 恢复', outcome: 'fixed', changed: 2, detail: '标记 2 个崩溃遗留 Run 为 interrupted' },
    { id: 'ghost-seq-claims', label: '幽灵序号占位行清理', outcome: 'already-healthy', changed: 0, detail: '无幽灵序号占位行' },
    { id: 'sync_runtime', label: '恢复同步监听', outcome: 'skipped', changed: 0, detail: '未配置同步' },
    { id: 'database-flush', label: '数据库落盘', outcome: 'failed', changed: 0, detail: '落盘失败: disk full' },
  ],
  selfcheck: {
    timestamp: '2026-01-01T00:00:05.000Z',
    summary: { total: 2, ok: 1, warn: 0, error: 1, passed: false },
    checks: [
      { name: '数据库文件', status: 'ok', detail: '1024.0 KB' },
      { name: '远程同步', status: 'error', detail: '未配置同步' },
    ],
  },
}

describe('SelfCheck — 一键修复 UI', () => {
  it('同时渲染「重新检查」与「一键修复」两个操作入口', () => {
    const { SelfCheck } = SelfCheckModule
    // useEffect 在 renderToStaticMarkup 下不执行（SSR 无副作用），
    // 因此首屏静态标记即可断言两个按钮都在 PageHeader action 里。
    const markup = renderToStaticMarkup(<SelfCheck />)

    expect(markup).toContain('重新检查')
    expect(markup).toContain('一键修复')
    // 两个按钮并列在同一个 action 容器里
    expect(markup).toContain('btn btn-ghost')
    expect(markup).toContain('btn btn-primary')
    expect(markup).toContain('lucide-wrench')
  })

  it('修复结果面板逐条渲染步骤标签、detail 与 outcome 中文标签', () => {
    const markup = renderToStaticMarkup(<SelfCheckModule.RepairResultPanel report={REPAIR_REPORT} />)

    expect(markup).toContain('修复结果')
    expect(markup).toContain('共 4 步')
    expect(markup).toContain('崩溃遗留 Run 恢复')
    expect(markup).toContain('标记 2 个崩溃遗留 Run 为 interrupted')
    expect(markup).toContain('无幽灵序号占位行')
    expect(markup).toContain('已修复')
    expect(markup).toContain('已健康')
    expect(markup).toContain('已跳过')
    expect(markup).toContain('失败')
    expect(markup).toContain('落盘失败: disk full')
  })

  it('SelfCheck 源码不含 any 类型标注', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8')
    expect(source).not.toContain(': any')
    expect(source).not.toContain('any[]')
  })
})