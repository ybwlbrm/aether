/**
 * P0-016 回归测试 —— toolResult/commandResult 必须区分成功与失败。
 *
 * AEX-MASTER-REMEDIATION 2026-09-26 审计发现：
 * node-executors.ts 的 toolResult/commandResult 把成功输出也包装成
 * nodeFailure(output, undefined) → error 字段被填成 output 本身，
 * 导致工作流中所有 tool/system 节点无条件判 failed（run 恒为 failed）。
 *
 * 正确语义：
 * - 成功输出（无失败前缀）→ { output }（无 error 字段）→ 引擎判 completed
 * - 失败输出（命中前缀词表）→ nodeFailure(output, detail) → 引擎判 failed
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolResult, commandResult } from './node-executors.js'

describe('workflow node-executors —— toolResult 成功/失败区分（P0-016 回归）', () => {
  it('成功输出（文件读取）不含 error 字段 → 引擎判 completed', () => {
    const result = toolResult('文件内容 (C:/tmp/a.txt):\n```\nhello\n```')
    assert.equal(typeof result.output, 'string')
    assert.equal(result.error, undefined, '成功输出绝不能设置 error 字段，否则节点被误判为 failed')
    assert.equal(result.code, undefined)
  })

  it('成功输出（文件写入）不含 error 字段', () => {
    const result = toolResult('文件已写入: C:/tmp/a.txt (12 字节)')
    assert.equal(result.error, undefined)
  })

  it('失败输出（错误: 前缀）保留 error + code', () => {
    const result = toolResult('错误: 文件不存在: /tmp/missing.txt')
    assert.equal(result.error, '错误: 文件不存在: /tmp/missing.txt')
    assert.equal(result.code, 'TOOL_ERROR')
  })

  it('失败输出（权限不足）保留 error + code', () => {
    const result = toolResult('权限不足：当前为 Level 1（只读）模式')
    assert.equal(result.code, 'PERMISSION_DENIED')
  })
})

describe('workflow node-executors —— commandResult 成功/失败区分（P0-016 回归）', () => {
  it('成功输出（含退出码）不含 error 字段 → 引擎判 completed', () => {
    const result = commandResult('命令执行完成（退出码 0）\n--- stdout ---\nok')
    assert.equal(result.error, undefined, '成功输出绝不能设置 error 字段')
  })

  it('失败输出（命令超时）保留 error + code + retryable', () => {
    const result = commandResult('错误: 命令执行超时（>30000ms），进程已被强制终止。')
    assert.equal(result.error, '错误: 命令执行超时（>30000ms），进程已被强制终止。')
    assert.equal(result.code, 'COMMAND_ERROR')
    assert.equal(result.retryable, true)
  })

  it('失败输出（安全限制）保留 error + code', () => {
    const result = commandResult('安全限制：命令 "rm" 不在允许列表内')
    assert.equal(result.code, 'SECURITY_BLOCKED')
    assert.equal(result.retryable, false)
  })
})
