/**
 * AEX-P0-017 —— 节点执行失败的结构化化。
 *
 * lib/files.ts（executeFileTool）与 lib/command/executor.ts（executeCommand）的契约是
 * 「失败以字符串返回，不抛异常」。node-executors 若原样 `return { output }`，
 * 引擎只看 error 字段就会把失败判成 completed。本模块负责把这类字符串
 * 还原为结构化失败（error + code + retryable），并构造供重试控制器判定的错误对象。
 *
 * 前缀词表与两个 lib 的实际返回分支一一对应；新增返回分支必须同步登记。
 */

import { RuntimeError } from '../../core/errors/index.js'
import type { NodeExecutionResult, NodeFailureCode } from './types.js'

export interface NodeFailureDetail {
  readonly code: NodeFailureCode
  readonly retryable?: boolean
  readonly statusCode?: number
}

type FailurePattern = {
  /** 匹配用的前缀（对输出做 trimStart 后比较） */
  readonly prefix: string
  readonly code: NodeFailureCode
  readonly retryable: boolean
}

/** executeFileTool 的失败返回分支（src/lib/files.ts） */
const TOOL_FAILURE_PATTERNS: readonly FailurePattern[] = [
  { prefix: '错误:', code: 'TOOL_ERROR', retryable: false },
  { prefix: '错误：', code: 'TOOL_ERROR', retryable: false },
  { prefix: '工具执行错误:', code: 'TOOL_ERROR', retryable: false },
  { prefix: '工具执行错误：', code: 'TOOL_ERROR', retryable: false },
  { prefix: '未知工具:', code: 'TOOL_NOT_FOUND', retryable: false },
  { prefix: '未知工具：', code: 'TOOL_NOT_FOUND', retryable: false },
  { prefix: '权限不足:', code: 'PERMISSION_DENIED', retryable: false },
  { prefix: '权限不足：', code: 'PERMISSION_DENIED', retryable: false },
]

/**
 * executeCommand 的失败返回分支（src/lib/command/executor.ts）。
 * 超时 / spawn 异常属瞬时故障 → 可重试；安全与权限拦截是确定性拒绝 → 不可重试。
 */
const COMMAND_FAILURE_PATTERNS: readonly FailurePattern[] = [
  { prefix: '错误: 命令执行超时', code: 'COMMAND_ERROR', retryable: true },
  { prefix: '错误：命令执行超时', code: 'COMMAND_ERROR', retryable: true },
  { prefix: '命令执行异常:', code: 'COMMAND_ERROR', retryable: true },
  { prefix: '命令执行异常：', code: 'COMMAND_ERROR', retryable: true },
  { prefix: '错误:', code: 'COMMAND_ERROR', retryable: false },
  { prefix: '错误：', code: 'COMMAND_ERROR', retryable: false },
  { prefix: '安全限制:', code: 'SECURITY_BLOCKED', retryable: false },
  { prefix: '安全限制：', code: 'SECURITY_BLOCKED', retryable: false },
  { prefix: '权限不足:', code: 'PERMISSION_DENIED', retryable: false },
  { prefix: '权限不足：', code: 'PERMISSION_DENIED', retryable: false },
]

function matchFailure(output: string, patterns: readonly FailurePattern[]): NodeFailureDetail | null {
  const trimmed = output.trimStart()
  const hit = patterns.find((pattern) => trimmed.startsWith(pattern.prefix))
  if (!hit) return null
  return hit.retryable
    ? { code: hit.code, retryable: true }
    : { code: hit.code, retryable: false }
}

/** 判定 executeFileTool 的输出是否为失败；成功返回 null */
export function classifyToolOutput(output: string): NodeFailureDetail | null {
  return matchFailure(output, TOOL_FAILURE_PATTERNS)
}

/** 判定 executeCommand 的输出是否为失败；成功返回 null */
export function classifyCommandOutput(output: string): NodeFailureDetail | null {
  return matchFailure(output, COMMAND_FAILURE_PATTERNS)
}

/** 构造结构化失败结果：output 保留原始文本供 UI 展示，error 触发引擎 failed 判定 */
export function nodeFailure(
  output: string,
  detail?: NodeFailureDetail,
): NodeExecutionResult {
  if (!detail) return { output, error: output }
  return {
    output,
    error: output,
    code: detail.code,
    ...(detail.retryable === undefined ? {} : { retryable: detail.retryable }),
    ...(detail.statusCode === undefined ? {} : { statusCode: detail.statusCode }),
  }
}

/**
 * 构造供 ExecutionRetryController 判定的错误。
 *
 * 两个结构化细节：
 * 1. RuntimeError 没有 statusCode 字段，而 isToolRetryable 通过结构化读取
 *    `record.statusCode`；这里用 Object.assign 补上可枚举属性，而不是塞进
 *    context（context 不参与判定）。
 * 2. RuntimeError 永远带 boolean `retryable`，isToolRetryable 会先读它就返回，
 *    因此 statusCode 派生的可重试性必须在此先算出来，否则 429/5xx 永不重试。
 *    规则与 isToolRetryable 的 HTTP 分支保持一致。
 */
export function createNodeExecutionError(
  message: string,
  detail: NodeFailureDetail,
  cause?: unknown,
): RuntimeError {
  const error = new RuntimeError(message, {
    code: detail.code,
    retryable: detail.retryable ?? isRetryableHttpStatus(detail.statusCode),
    cause,
  })
  if (detail.statusCode !== undefined) Object.assign(error, { statusCode: detail.statusCode })
  return error
}

/** 与 execution-retry.isToolRetryable 的 HTTP 分支同规则：408/425/429/5xx 可重试 */
function isRetryableHttpStatus(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return false
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500
}
