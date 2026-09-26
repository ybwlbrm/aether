import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROCESSABLE_REMOTE_COMMAND_STATUSES,
  REMOTE_COMMAND_REALTIME_FILTER,
} from './remote-command-status.js'

describe('Remote Command 状态过滤', () => {
  it('Realtime filter 包含 cancelled 状态', () => {
    assert.equal(REMOTE_COMMAND_REALTIME_FILTER, 'status=in.(pending,cancelled)')
  })

  it('Polling 处理状态包含 pending 与 cancelled', () => {
    assert.deepEqual(PROCESSABLE_REMOTE_COMMAND_STATUSES, ['pending', 'cancelled'])
  })
})
