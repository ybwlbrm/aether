import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapExecutionLoopResult } from './command-outcome.js'

describe('Remote Command ExecutionLoop 终态映射', () => {
  it('failed 状态映射为 Run fail 并保留错误', () => {
    // Given
    const result = {
      state: 'failed',
      content: 'provider error',
      budgetExceeded: 'none',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false)

    // Then
    assert.equal(outcome.kind, 'fail')
    assert.equal(outcome.kind === 'fail' ? outcome.endReason : 'wrong', 'error')
    assert.equal(outcome.kind === 'fail' ? outcome.error : 'wrong', 'provider error')
  })

  it('ExecutionLoop 错误事件优先写入 Run fail.error', () => {
    // Given
    const result = {
      state: 'failed',
      content: '',
      budgetExceeded: 'none',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false, 'provider connection refused')

    // Then
    assert.equal(outcome.kind === 'fail' ? outcome.error : 'wrong', 'provider connection refused')
  })

  it('budget_exceeded 状态映射为 Run fail', () => {
    // Given
    const result = {
      state: 'budget_exceeded',
      content: '达到最大轮数',
      budgetExceeded: 'turns',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false)

    // Then
    assert.equal(outcome.kind, 'fail')
    assert.equal(outcome.kind === 'fail' ? outcome.endReason : 'wrong', 'budget_exceeded')
  })

  it('cancelled 状态映射为 Run cancel', () => {
    // Given
    const result = {
      state: 'cancelled',
      content: '用户停止',
      budgetExceeded: 'cancelled',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false)

    // Then
    assert.equal(outcome.kind, 'cancel')
  })

  it('AbortSignal 触发时优先映射为 Run cancel', () => {
    // Given
    const result = {
      state: 'failed',
      content: '请求被中止',
      budgetExceeded: 'none',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, true)

    // Then
    assert.equal(outcome.kind, 'cancel')
  })

  it('interrupted 标志映射为 Run fail', () => {
    // Given
    const result = {
      state: 'failed',
      content: '部分输出',
      interrupted: true,
      budgetExceeded: 'none',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false)

    // Then
    assert.equal(outcome.kind, 'fail')
     assert.equal(outcome.kind === 'fail' ? outcome.endReason : 'wrong', 'interrupted')
     assert.equal(outcome.kind === 'fail' ? outcome.error : 'wrong', 'Execution stream interrupted before finish')
  })

  it('finish=content_filter 即使 state=completed 也不得映射为 Run complete', () => {
    // Given
    const result = {
      state: 'completed',
      content: '被内容策略过滤',
      finishReason: 'content_filter',
      budgetExceeded: 'none',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false)

    // Then
    assert.equal(outcome.kind, 'fail')
    assert.equal(outcome.kind === 'fail' ? outcome.endReason : 'wrong', 'interrupted')
  })

  it('finish=error 即使 state=completed 也不得映射为 Run complete', () => {
    // Given
    const result = {
      state: 'completed',
      content: 'provider error',
      finishReason: 'error',
      budgetExceeded: 'none',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false)

    // Then
    assert.equal(outcome.kind, 'fail')
    assert.equal(outcome.kind === 'fail' ? outcome.endReason : 'wrong', 'error')
  })

  it('completed 状态才映射为 Run complete', () => {
    // Given
    const result = {
      state: 'completed',
      content: '完成',
      budgetExceeded: 'none',
    } as const

    // When
    const outcome = mapExecutionLoopResult(result, false)

    // Then
    assert.equal(outcome.kind, 'complete')
  })
})
