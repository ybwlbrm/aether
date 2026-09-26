/**
 * AEX-P0-016 —— HTTP 请求断开 → 引擎 AbortSignal 接线。
 *
 * 路由层必须把「客户端断开」翻译成 AbortSignal，否则
 * POST /api/workflows/:id/run 的取消只能靠 runs/routes.ts 显式 cancel。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequestAbortSignal } from './request-abort.js'

class FakeIncomingMessage extends EventEmitter {
  complete = true
  destroyed = false
  aborted = false
  socket = { destroyed: false }
}

describe('workflow createRequestAbortSignal —— 请求断开接线（AEX-P0-016）', () => {
  it('请求体读完后的正常 close 不触发 abort', () => {
    // Given: 请求已完整接收（complete=true）
    const raw = new FakeIncomingMessage()
    const { signal } = createRequestAbortSignal({ raw })

    // When
    raw.emit('close')

    // Then
    assert.equal(signal.aborted, false)
  })

  it('请求未读完就 close（客户端断开）触发 abort', () => {
    // Given: 请求体尚未读完
    const raw = new FakeIncomingMessage()
    raw.complete = false
    const { signal } = createRequestAbortSignal({ raw })

    // When
    raw.emit('close')

    // Then
    assert.equal(signal.aborted, true)
  })

  it('aborted 事件触发 abort', () => {
    // Given
    const raw = new FakeIncomingMessage()
    raw.complete = false
    const { signal } = createRequestAbortSignal({ raw })

    // When
    raw.emit('aborted')

    // Then
    assert.equal(signal.aborted, true)
  })

  it('进入时已断开（destroyed）立即 abort', () => {
    // Given: 请求到达处理器前连接已断开
    const raw = new FakeIncomingMessage()
    raw.destroyed = true
    raw.complete = false

    // When
    const { signal } = createRequestAbortSignal({ raw })

    // Then
    assert.equal(signal.aborted, true)
  })

  it('dispose 后移除监听器（不泄漏 listener）', () => {
    // Given
    const raw = new FakeIncomingMessage()
    raw.complete = false
    const { signal, dispose } = createRequestAbortSignal({ raw })
    assert.ok(raw.listenerCount('close') > 0)

    // When
    dispose()
    raw.emit('close')

    // Then
    assert.equal(raw.listenerCount('close'), 0)
    assert.equal(raw.listenerCount('aborted'), 0)
    assert.equal(signal.aborted, false)
  })
})
