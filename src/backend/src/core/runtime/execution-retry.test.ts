import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ModelError, RetryExhaustedError, ToolError } from '../errors/index.js'
import { CancellationError } from './cancellation.js'
import {
  ExecutionRetryController,
  RetryCheckpoint,
  ToolRecoveryController,
  isToolAutoRetryAllowed,
  type RetryEvent,
  type ToolSideEffectClass,
} from './execution-retry.js'

const fastRetry = {
  runId: 'run-retry',
  taskId: 'task-retry',
  baseDelayMs: 0,
  jitter: 0,
} as const

/** 显式可重试错误：AEX-P0-005 起"未知错误"不再默认重试 */
function retryableFailure(message: string): Error {
  return Object.assign(new Error(message), { retryable: true })
}

describe('core/runtime/execution-retry', () => {
  it('Task Retry：前 8 次失败后第 9 次成功，并发射完整 retry 事件序列', async () => {
    let attempts = 0
    const events: RetryEvent[] = []
    const controller = new ExecutionRetryController({
      ...fastRetry,
      onEvent: (event) => events.push(event),
    })

    const result = await controller.run(async () => {
      attempts += 1
      if (attempts <= 8) throw retryableFailure('temporary task failure')
      return 'recovered'
    })

    assert.equal(result, 'recovered')
    assert.equal(attempts, 9)
    assert.ok(events.some((event) => event.type === 'attempt.started'))
    assert.ok(events.some((event) => event.type === 'retry.scheduled'))
    assert.ok(events.some((event) => event.type === 'retry.started'))
    assert.ok(events.some((event) => event.type === 'retry.failed'))
    assert.ok(events.some((event) => event.type === 'retry.completed'))
    assert.equal(events.some((event) => event.type === 'retry.exhausted'), false)
  })

  it('Task Retry：Retry-After 优先于指数退避，并在 scheduled 事件中携带 nextRetryAt', async () => {
    const events: RetryEvent[] = []
    let attempts = 0
    const controller = new ExecutionRetryController({
      ...fastRetry,
      baseDelayMs: 1000,
      onEvent: (event) => events.push(event),
    })

    await controller.run(async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('rate limited'), { retryAfterMs: 25, retryable: true })
      }
      return 'ok'
    })

    const scheduled = events.find((event) => event.type === 'retry.scheduled')
    assert.equal(scheduled?.payload.delayMs, 25)
    assert.ok(scheduled?.payload.nextRetryAt)
  })

  it('Task Retry：默认 8 次重试全部失败后抛 RetryExhaustedError', async () => {
    let attempts = 0
    const controller = new ExecutionRetryController(fastRetry)

    await assert.rejects(
      controller.run(async () => {
        attempts += 1
        throw retryableFailure('still failing')
      }),
      (error: unknown) => {
        assert.ok(error instanceof RetryExhaustedError)
        assert.equal(error.attempt, 9)
        assert.equal(error.maxAttempts, 9)
        assert.equal(error.lastError instanceof Error, true)
        return true
      },
    )
    assert.equal(attempts, 9)
  })

  it('Tool Retry：retryable 错误最多自动重试 3 次（需声明副作用安全）', async () => {
    let calls = 0
    const controller = new ToolRecoveryController(fastRetry)

    const result = await controller.run('tool-retryable', async () => {
      calls += 1
      if (calls <= 3) {
        throw new ToolError('temporary tool failure', {
          toolName: 'tool-retryable',
          code: 'NETWORK_ERROR',
          retryable: true,
        })
      }
      return 'tool success'
    }, { sideEffectClass: 'read_only' })

    assert.equal(result, 'tool success')
    assert.equal(calls, 4)
  })

  it('Tool Retry：参数错误等不可重试错误只执行一次', async () => {
    let calls = 0
    const controller = new ToolRecoveryController(fastRetry)
    const failure = new ToolError('invalid arguments', {
      toolName: 'tool-invalid',
      code: 'INVALID_INPUT',
      retryable: false,
    })

    await assert.rejects(
      controller.run('tool-invalid', async () => {
        calls += 1
        throw failure
      }),
      (error: unknown) => error === failure,
    )
    assert.equal(calls, 1)
  })

  it('Tool checkpoint：相同 tool id 和参数命中成功结果时不重复执行', async () => {
    let calls = 0
    const controller = new ToolRecoveryController({
      ...fastRetry,
      completedToolIds: new Set(['tool-done']),
      completedToolResults: new Map([['tool-done', 'cached result']]),
    })

    const result = await controller.run(
      'tool-done',
      async () => {
        calls += 1
        return 'fresh result'
      },
      { arguments: '{"same":true}' },
    )

    assert.equal(result, 'cached result')
    assert.equal(calls, 0)
  })

  it('Retry 等待中的 Stop 立即中止', async () => {
    const controller = new ExecutionRetryController({
      ...fastRetry,
      baseDelayMs: 1000,
    })
    const abortController = new AbortController()
    const startedAt = Date.now()
    const promise = controller.run(
      async () => {
        throw retryableFailure('retry me')
      },
      { signal: abortController.signal },
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    abortController.abort()
    await assert.rejects(promise, (error: unknown) => error instanceof CancellationError)
    assert.ok(Date.now() - startedAt < 500)
  })

  // ============ AEX-P0-005：未知错误不再默认重试 ============

  it('AEX-P0-005: 普通 Error（未声明 retryable）→ 直接失败，不重试', async () => {
    let attempts = 0
    const controller = new ExecutionRetryController(fastRetry)
    const failure = new Error('unknown failure')

    await assert.rejects(
      controller.run(async () => {
        attempts += 1
        throw failure
      }),
      (error: unknown) => error === failure,
    )
    assert.equal(attempts, 1, '未知错误不得被默认重试（retryable===undefined → fail）')
  })

  it('AEX-P0-005: 非 Error 抛出值（字符串）→ 直接失败，不重试', async () => {
    let attempts = 0
    const controller = new ExecutionRetryController(fastRetry)

    await assert.rejects(
      controller.run(async () => {
        attempts += 1
        throw 'raw string failure'
      }),
      (error: unknown) => error === 'raw string failure',
    )
    assert.equal(attempts, 1)
  })

  it('AEX-P0-005: retryable 缺省的普通对象错误 → 直接失败，不重试', async () => {
    let attempts = 0
    const controller = new ExecutionRetryController(fastRetry)
    const failure = { message: 'no retryable field' }

    await assert.rejects(
      controller.run(async () => {
        attempts += 1
        throw failure
      }),
      (error: unknown) => error === failure,
    )
    assert.equal(attempts, 1)
  })

  it('AEX-P0-005: ModelError retryable=true → 仍然重试', async () => {
    let attempts = 0
    const controller = new ExecutionRetryController({ ...fastRetry, maxRetries: 2 })

    const result = await controller.run(async () => {
      attempts += 1
      if (attempts <= 2) {
        throw new ModelError('provider overloaded', {
          provider: 'mock',
          statusCode: 503,
          retryable: true,
        })
      }
      return 'recovered'
    })

    assert.equal(result, 'recovered')
    assert.equal(attempts, 3)
  })

  it('AEX-P0-005: RetryExhaustedError 不再触发新一轮重试', async () => {
    let attempts = 0
    const controller = new ExecutionRetryController(fastRetry)
    const exhausted = new RetryExhaustedError('inner retries exhausted', {
      maxAttempts: 3,
      backoffMs: 0,
      lastError: new Error('root cause'),
    })

    await assert.rejects(
      controller.run(async () => {
        attempts += 1
        throw exhausted
      }),
      (error: unknown) => error === exhausted,
    )
    assert.equal(attempts, 1, '重试耗尽是终态信号，必须向上抛而不是再套一层重试')
  })

  it('AEX-P0-005: retryable:false 显式声明 → 不重试', async () => {
    let attempts = 0
    const controller = new ExecutionRetryController(fastRetry)

    await assert.rejects(
      controller.run(async () => {
        attempts += 1
        throw Object.assign(new Error('hard failure'), { retryable: false })
      }),
      /hard failure/,
    )
    assert.equal(attempts, 1)
  })

  // ============ AEX-P0-006：tool 副作用分级（幂等契约） ============

  it('AEX-P0-006: isToolAutoRetryAllowed 只放行 read_only / idempotent', () => {
    assert.equal(isToolAutoRetryAllowed('read_only'), true)
    assert.equal(isToolAutoRetryAllowed('idempotent'), true)
    assert.equal(isToolAutoRetryAllowed('non_idempotent'), false, '非幂等副作用只能人工重试')
    assert.equal(isToolAutoRetryAllowed('unknown'), false, '未分类工具默认不自动重试')
  })

  it('AEX-P0-006: RetryCheckpoint 记录并可读回工具副作用分级', () => {
    const checkpoint = new RetryCheckpoint()
    assert.equal(checkpoint.getToolSideEffectClass('tool-a'), 'unknown', '未登记时缺省 unknown')

    checkpoint.markToolSideEffectClass('tool-a', 'non_idempotent')
    assert.equal(checkpoint.getToolSideEffectClass('tool-a'), 'non_idempotent')

    checkpoint.clear()
    assert.equal(checkpoint.getToolSideEffectClass('tool-a'), 'unknown', 'clear 后必须回到 unknown')
  })

  it('AEX-P0-006: non_idempotent 工具失败 → 不自动重试（错误直接上抛）', async () => {
    let calls = 0
    const controller = new ToolRecoveryController(fastRetry)
    const failure = new ToolError('side effect already applied', {
      toolName: 'send_email',
      code: 'TIMEOUT',
      retryable: true,
    })

    await assert.rejects(
      controller.run('send_email', async () => {
        calls += 1
        throw failure
      }, { sideEffectClass: 'non_idempotent' }),
      (error: unknown) => error === failure,
    )
    assert.equal(calls, 1, '非幂等副作用即使错误可重试也不得自动重试（否则会重复发信）')
    assert.equal(controller.checkpoint.getToolSideEffectClass('send_email'), 'non_idempotent')
  })

  it('AEX-P0-006: unknown 工具失败 → 不自动重试', async () => {
    let calls = 0
    const controller = new ToolRecoveryController(fastRetry)
    const failure = new ToolError('unknown side effect', {
      toolName: 'mystery_tool',
      code: 'NETWORK_ERROR',
      retryable: true,
    })

    await assert.rejects(
      controller.run('mystery_tool', async () => {
        calls += 1
        throw failure
      }),
      (error: unknown) => error === failure,
    )
    assert.equal(calls, 1, '未声明 sideEffectClass 时缺省 unknown → 不自动重试')
    assert.equal(controller.checkpoint.getToolSideEffectClass('mystery_tool'), 'unknown')
  })

  it('AEX-P0-006: read_only 工具失败 → 仍按错误类型自动重试', async () => {
    let calls = 0
    const controller = new ToolRecoveryController(fastRetry)

    const result = await controller.run('read_file', async () => {
      calls += 1
      if (calls <= 2) {
        throw new ToolError('temporary read failure', {
          toolName: 'read_file',
          code: 'NETWORK_ERROR',
          retryable: true,
        })
      }
      return 'file content'
    }, { sideEffectClass: 'read_only' })

    assert.equal(result, 'file content')
    assert.equal(calls, 3)
  })

  it('AEX-P0-006: 副作用分级不覆盖调用方显式提供的 shouldRetry 之外的判定，且失败后分级随 checkpoint 保留', async () => {
    const classes: ToolSideEffectClass[] = ['idempotent', 'non_idempotent']
    const controller = new ToolRecoveryController(fastRetry)

    for (const sideEffectClass of classes) {
      await controller.run(`tool-${sideEffectClass}`, async () => 'ok', { sideEffectClass })
        .catch(() => undefined)
    }

    assert.equal(controller.checkpoint.getToolSideEffectClass('tool-idempotent'), 'idempotent')
    assert.equal(controller.checkpoint.getToolSideEffectClass('tool-non_idempotent'), 'non_idempotent')
  })
})
