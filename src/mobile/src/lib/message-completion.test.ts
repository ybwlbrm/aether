import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveChatCompletion,
  type ChatCompletionSignal,
} from './message-store.ts'
import type { RemoteCommandStatus } from './remote-command.ts'

function assistantSignal(): ChatCompletionSignal {
  return {
    kind: 'assistant_message',
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: '正在继续执行工具',
      created_at: '2026-01-01T00:00:01Z',
    },
  }
}

function commandSignal(status: RemoteCommandStatus): ChatCompletionSignal {
  return { kind: 'remote_command_status', status }
}

test('终态结算：首条 assistant 消息保持 busy，不触发 completed', () => {
  // Given
  const firstAssistant = assistantSignal()

  // When
  const settlement = resolveChatCompletion(firstAssistant)

  // Then
  assert.deepEqual(settlement, { kind: 'busy' })
})

test('终态结算：pending 保持 busy，composer 不释放', () => {
  // Given
  const pending = commandSignal('pending')

  // When
  const settlement = resolveChatCompletion(pending)

  // Then
  assert.deepEqual(settlement, { kind: 'busy' })
})

test('终态结算：processing 保持 busy，composer 不释放', () => {
  // Given
  const processing = commandSignal('processing')

  // When
  const settlement = resolveChatCompletion(processing)

  // Then
  assert.deepEqual(settlement, { kind: 'busy' })
})

test('终态结算：completed 释放 composer 并进入 completed', () => {
  // Given
  const completed = commandSignal('completed')

  // When
  const settlement = resolveChatCompletion(completed)

  // Then
  assert.deepEqual(settlement, { kind: 'completed' })
})

test('终态结算：failed 释放 composer 并进入 failed', () => {
  // Given
  const failed = commandSignal('failed')

  // When
  const settlement = resolveChatCompletion(failed)

  // Then
  assert.deepEqual(settlement, { kind: 'failed' })
})

test('终态结算：cancelled 释放 composer 并进入 cancelled', () => {
  // Given
  const cancelled = commandSignal('cancelled')

  // When
  const settlement = resolveChatCompletion(cancelled)

  // Then
  assert.deepEqual(settlement, { kind: 'cancelled' })
})
