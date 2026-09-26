import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateTaskCompletion,
  type CompletionResponse,
  type TaskCompletionEvaluator,
} from './execution-completion.js'

function response(overrides: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    content: '',
    ...overrides,
  }
}

function input(overrides: Partial<TaskCompletionEvaluator> = {}): TaskCompletionEvaluator {
  return {
    taskObjective: '完成一份执行报告',
    messageHistory: [],
    completedToolResults: [],
    hasError: false,
    hasExpectedArtifact: false,
    currentResponse: response(),
    ...overrides,
  }
}

describe('core/runtime/execution-completion', () => {
  it('returns continue when text exists but the objective is not satisfied', () => {
    // Given
    const evaluatorInput = input({
      currentResponse: response({ content: '我已经开始整理资料' }),
    })

    // When
    const verdict = evaluateTaskCompletion(evaluatorInput)

    // Then
    assert.equal(verdict.status, 'continue')
    assert.match(verdict.reason, /目标|完成/)
    assert.ok(verdict.suggestedInstruction.length > 0)
  })

  it('returns continue when the current response has pending tool calls', () => {
    // Given
    const evaluatorInput = input({
      currentResponse: response({
        toolCalls: [{
          id: 'call-1',
          name: 'write_report',
          arguments: '{}',
        }],
      }),
    })

    // When
    const verdict = evaluateTaskCompletion(evaluatorInput)

    // Then
    assert.equal(verdict.status, 'continue')
    assert.match(verdict.reason, /工具/)
  })

  it('returns complete when the objective is satisfied and no work remains', () => {
    // Given
    const evaluatorInput = input({
      messageHistory: [{ role: 'assistant', content: '报告已生成' }],
      hasExpectedArtifact: true,
      currentResponse: response({ content: '任务完成' }),
    })

    // When
    const verdict = evaluateTaskCompletion(evaluatorInput)

    // Then
    assert.equal(verdict.status, 'complete')
    assert.match(verdict.reason, /满足|完成/)
  })

  it('returns needs_correction when execution reports an error', () => {
    // Given
    const evaluatorInput = input({
      hasError: true,
      hasExpectedArtifact: true,
      currentResponse: response({ content: '执行失败' }),
    })

    // When
    const verdict = evaluateTaskCompletion(evaluatorInput)

    // Then
    assert.equal(verdict.status, 'needs_correction')
    assert.match(verdict.reason, /错误|修正/)
  })

  it('returns continue when there is no text but explicit work remains', () => {
    // Given
    const evaluatorInput = input({
      pendingSteps: ['write_report'],
    })

    // When
    const verdict = evaluateTaskCompletion(evaluatorInput)

    // Then
    assert.equal(verdict.status, 'continue')
  })

  it('returns verify_required when there is no text and completion cannot be proven', () => {
    // Given
    const evaluatorInput = input()

    // When
    const verdict = evaluateTaskCompletion(evaluatorInput)

    // Then
    assert.equal(verdict.status, 'verify_required')
  })

  it('does not mutate evaluator inputs', () => {
    // Given
    const history = [{ role: 'user', content: '请生成报告' }]
    const toolResults = [{ step: 'read', result: { count: 1 } }]
    const evaluatorInput = input({
      messageHistory: history,
      completedToolResults: toolResults,
      currentResponse: response({ content: '处理中' }),
    })
    const originalHistory = structuredClone(history)
    const originalToolResults = structuredClone(toolResults)

    // When
    evaluateTaskCompletion(evaluatorInput)

    // Then
    assert.deepEqual(history, originalHistory)
    assert.deepEqual(toolResults, originalToolResults)
  })
})
