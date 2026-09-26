import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCancelCommandPayload,
  buildRemoteCommandSnapshot,
  getRemainingCommandTimeoutMs,
  matchesRemoteCommandReference,
  parseRemoteCommandSnapshot,
  resolveCancellationAction,
  shouldPollRemoteCommandStatus,
  type RemoteCommandReference,
} from './remote-command.ts'

test('buildCancelCommandPayload: 取消行复用原始 client_command_id 并写入 cancelled metadata', () => {
  // Given
  const input = {
    deviceId: 'mobile-1',
    userId: 'user-1',
    conversationId: 'conversation-1',
    originalClientCommandId: 'command-1',
  }

  // When
  const payload = buildCancelCommandPayload(input)

  // Then
  assert.deepEqual(payload, {
    device_id: 'mobile-1',
    user_id: 'user-1',
    conversation_id: 'conversation-1',
    content: '/cancel',
    status: 'cancelled',
    client_command_id: 'command-1',
    metadata: { cancel_requested: true },
  })
})

test('终态订阅：pending 与 processing 继续轮询兜底', () => {
  // Given
  const activeStatuses = ['pending', 'processing'] as const

  // When
  const shouldPoll = activeStatuses.map(shouldPollRemoteCommandStatus)

  // Then
  assert.deepEqual(shouldPoll, [true, true])
})

test('终态订阅：completed、failed、cancelled 停止轮询', () => {
  // Given
  const terminalStatuses = ['completed', 'failed', 'cancelled'] as const

  // When
  const shouldPoll = terminalStatuses.map(shouldPollRemoteCommandStatus)

  // Then
  assert.deepEqual(shouldPoll, [false, false, false])
})

test('终态结算：timeout 重挂载保留剩余时间且过期不为负数', () => {
  // Given
  const deadline = 1_000

  // When
  const remaining = getRemainingCommandTimeoutMs(deadline, 400)
  const expired = getRemainingCommandTimeoutMs(deadline, 1_200)

  // Then
  assert.equal(remaining, 600)
  assert.equal(expired, 0)
})

test('远端快照：保留 client_command_id 并识别取消行', () => {
  // Given
  const processingRow = {
    id: 'server-command-1',
    client_command_id: 'client-command-1',
    status: 'processing',
    content: '执行工具',
  }
  const cancellationRow = {
    id: 'cancel-command-1',
    client_command_id: 'client-command-1',
    status: 'cancelled',
    content: '/cancel',
    metadata: { cancel_requested: true },
  }

  // When
  const processing = parseRemoteCommandSnapshot(processingRow)
  const cancellation = parseRemoteCommandSnapshot(cancellationRow)

  // Then
  assert.equal(processing?.clientCommandId, 'client-command-1')
  assert.equal(processing?.isCancellation, false)
  assert.equal(cancellation?.isCancellation, true)
})

test('命令引用：queued client key 可匹配补传后的 server snapshot', () => {
  // Given
  const reference: RemoteCommandReference = {
    serverId: null,
    clientCommandId: 'client-command-1',
  }
  const snapshot = buildRemoteCommandSnapshot({
    id: 'server-command-1',
    clientCommandId: 'client-command-1',
    status: 'processing',
    error: null,
  })

  // When
  const matches = matchesRemoteCommandReference(snapshot, reference)

  // Then
  assert.equal(matches, true)
})

test('命令引用：旧 server id 不得结算当前命令', () => {
  // Given
  const current: RemoteCommandReference = {
    serverId: 'server-command-2',
    clientCommandId: 'client-command-2',
  }
  const stale = buildRemoteCommandSnapshot({
    id: 'server-command-1',
    clientCommandId: 'client-command-1',
    status: 'completed',
    error: null,
  })

  // When
  const matches = matchesRemoteCommandReference(stale, current)

  // Then
  assert.equal(matches, false)
})

test('取消动作：本地队列存在时优先 tombstone，远端存在时等待终态', () => {
  // Given
  const queued = resolveCancellationAction({ hasQueuedCommand: true, hasRemoteCommand: false })
  const remote = resolveCancellationAction({ hasQueuedCommand: false, hasRemoteCommand: true })
  const missing = resolveCancellationAction({ hasQueuedCommand: false, hasRemoteCommand: false })

  // When
  const actions = [queued, remote, missing]

  // Then
  assert.deepEqual(actions, ['cancel_local', 'wait_remote', 'reject'])
})

