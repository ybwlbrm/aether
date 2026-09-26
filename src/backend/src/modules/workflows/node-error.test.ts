/**
 * AEX-P0-017 —— 节点执行失败的结构化分类。
 *
 * lib/files.ts 与 lib/command/executor.ts 的契约是「错误以字符串返回」，
 * node-executors 必须把这类字符串还原为结构化失败（error + code），
 * 否则引擎会把失败误判为 completed。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeError } from '../../core/errors/index.js'
import {
  classifyCommandOutput,
  classifyToolOutput,
  createNodeExecutionError,
  nodeFailure,
} from './node-error.js'

describe('workflow node-error —— 工具输出失败分类（AEX-P0-017）', () => {
  it('executeFileTool 的 错误: 前缀被识别为失败并给出 code', () => {
    const detail = classifyToolOutput('错误: 文件不存在: /tmp/missing.txt')
    assert.ok(detail, '错误: 前缀必须被识别为失败')
    assert.equal(detail.code, 'TOOL_ERROR')
    assert.equal(detail.retryable, false)
  })

  it('未知工具 → TOOL_NOT_FOUND', () => {
    assert.equal(classifyToolOutput('未知工具: nope')?.code, 'TOOL_NOT_FOUND')
  })

  it('权限不足 → PERMISSION_DENIED', () => {
    assert.equal(classifyToolOutput('权限不足：当前为 Level 1（只读）模式')?.code, 'PERMISSION_DENIED')
  })

  it('工具执行错误 → TOOL_ERROR', () => {
    assert.equal(classifyToolOutput('工具执行错误: ENOENT')?.code, 'TOOL_ERROR')
  })

  it('成功输出不被误判为失败', () => {
    assert.equal(classifyToolOutput('文件已写入: C:/tmp/a.txt (12 字节)'), null)
    assert.equal(classifyToolOutput('文件内容 (C:/tmp/a.txt):\n```\nhello\n```'), null)
    assert.equal(classifyToolOutput('| 文件名 | 类型 | 大小 |\n| --- | --- | --- |'), null)
  })
})

describe('workflow node-error —— 系统命令输出失败分类（AEX-P0-017）', () => {
  it('错误: 前缀 → COMMAND_ERROR 且可重试（超时/进程崩溃属瞬时故障）', () => {
    const detail = classifyCommandOutput('错误: 命令执行超时（>30000ms），进程已被强制终止。')
    assert.equal(detail?.code, 'COMMAND_ERROR')
    assert.equal(detail?.retryable, true)
  })

  it('安全限制 → SECURITY_BLOCKED 不可重试', () => {
    const detail = classifyCommandOutput('安全限制：命令 "rm" 不在允许列表内')
    assert.equal(detail?.code, 'SECURITY_BLOCKED')
    assert.equal(detail?.retryable, false)
  })

  it('权限不足 → PERMISSION_DENIED 不可重试', () => {
    assert.equal(classifyCommandOutput('权限不足：当前为 Level 1（只读）模式')?.code, 'PERMISSION_DENIED')
  })

  it('命令执行异常 → COMMAND_ERROR 可重试', () => {
    assert.equal(classifyCommandOutput('命令执行异常: spawn ENOENT')?.retryable, true)
  })

  it('正常执行输出（含退出码）不被误判为失败', () => {
    assert.equal(classifyCommandOutput('命令执行完成（退出码 0）\n--- stdout ---\nok'), null)
    assert.equal(classifyCommandOutput('已停止：运行已取消（aborted），命令进程已终止'), null)
  })
})

describe('workflow node-error —— 结构化失败构造与重试错误', () => {
  it('nodeFailure 同时填充 output 与 error（引擎据此判 failed）', () => {
    const result = nodeFailure('错误: 文件不存在', { code: 'TOOL_ERROR', retryable: false })
    assert.equal(result.output, '错误: 文件不存在')
    assert.equal(result.error, '错误: 文件不存在')
    assert.equal(result.code, 'TOOL_ERROR')
    assert.equal(result.retryable, false)
  })

  it('nodeFailure 无 detail 时不产生多余键', () => {
    const result = nodeFailure('工具节点缺少 name 配置')
    assert.deepEqual(Object.keys(result).sort(), ['error', 'output'])
  })

  it('createNodeExecutionError 保留 code/retryable/statusCode 供 isToolRetryable 判定', () => {
    const error = createNodeExecutionError('节点 a 执行失败', {
      code: 'NETWORK_ERROR',
      retryable: true,
      statusCode: 503,
    })
    assert.ok(error instanceof RuntimeError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.retryable, true)
    assert.equal(
      Reflect.get(error, 'statusCode'),
      503,
      'statusCode 需作为可枚举属性暴露给 isToolRetryable',
    )
  })

  it('createNodeExecutionError 未给 statusCode 时不注入该属性', () => {
    const error = createNodeExecutionError('节点 a 执行失败', { code: 'TOOL_ERROR' })
    assert.equal(Reflect.get(error, 'statusCode'), undefined)
  })

  it('createNodeExecutionError 由 5xx statusCode 派生 retryable（不覆盖 code 判定）', () => {
    // Given: 只给 statusCode，不给 retryable —— RuntimeError 永远带 boolean retryable，
    // 若不预派生，isToolRetryable 会在读 code/statusCode 之前就返回 false
    const error = createNodeExecutionError('节点 a 执行失败', {
      code: 'MEDIA_ERROR',
      statusCode: 502,
    })
    assert.equal(error.retryable, true)
  })
})
