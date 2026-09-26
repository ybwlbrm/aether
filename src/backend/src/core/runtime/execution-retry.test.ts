import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RetryExhaustedError, ToolError } from '../errors/index.js'
import { CancellationError } from './cancellation.js'
import {
  ExecutionRetryController,
  ToolRecoveryController,
  type RetryEvent,
} from './execution-retry.js'

const fastRetry = {
  runId: 'run-retry',
  taskId: 'task-retry',
  baseDelayMs: 0,
  jitter: 0,
} as const

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
      if (attempts <= 8) throw new Error('temporary task failure')
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
        throw new Error('still failing')
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

  it('Tool Retry：retryable 错误最多自动重试 3 次', async () => {
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
    })

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
        throw new Error('retry me')
      },
      { signal: abortController.signal },
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    abortController.abort()
    await assert.rejects(promise, (error: unknown) => error instanceof CancellationError)
    assert.ok(Date.now() - startedAt < 500)
  })
})
