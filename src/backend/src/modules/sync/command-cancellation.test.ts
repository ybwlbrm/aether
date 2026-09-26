import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import {
  createRemoteRunSignal,
  createSupabaseCancellationLookup,
  isCancellationCommand,
  resolveCancellationRunId,
  runCancellable,
  type CancellationLookup,
  type RemoteCommandCancellationRow,
} from './command-cancellation.js'
import { RunCancellationRegistry } from '../../lib/run-cancellation-registry.js'
import { runExecutionLoop } from '../../core/runtime/execution-loop.js'
import type { ModelRequest, ModelResponse, ModelRuntime } from '../../core/models/index.js'
import { mapExecutionLoopResult } from './command-outcome.js'

function modelResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    id: 'response-1',
    provider: 'test',
    model: 'test-model',
    content: '',
    finishReason: 'stop',
    ...overrides,
  }
}

function waitForAbort(request: Pick<ModelRequest, 'signal'>): Promise<never> {
  return new Promise<never>((_, reject) => {
    const signal = request.signal
    const rejectAborted = (): void => {
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal?.aborted) {
      rejectAborted()
      return
    }
    signal?.addEventListener('abort', rejectAborted, { once: true })
  })
}

function emptyStreamModel(complete: ModelRuntime['complete']): ModelRuntime {
  return {
    complete,
    async *stream() {
      return
    },
  }
}

describe('Remote Command 取消定位', () => {
  it('Supabase 取消目标查询返回 error 时向 Realtime/Polling 传播定位失败', async () => {
    // Given
    const fakeFetch: typeof fetch = async () => new Response(
      JSON.stringify({ code: 'PGRST999', message: 'cancellation lookup failed' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
    const supabase = createClient('https://example.supabase.co', 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fakeFetch },
    })
    const lookup = createSupabaseCancellationLookup(supabase)

    // When / Then
    await assert.rejects(
      lookup('client-command-error', 'cancel-command-error'),
      /查询取消目标命令失败: cancellation lookup failed/,
    )
  })

  it('通过 client_command_id 查询原始命令的 run_id', async () => {
    // Given: 取消行只携带原始命令的 client_command_id
    const command: RemoteCommandCancellationRow = {
      id: 'cancel-1',
      content: '/cancel',
      client_command_id: 'command-1',
      conversation_id: 'conversation-1',
    }
    let requestedClientId = ''
    let excludedId = ''
    const lookup: CancellationLookup = async (clientCommandId, cancelCommandId) => {
      requestedClientId = clientCommandId
      excludedId = cancelCommandId
      return [{ runId: 'run-1', conversationId: 'conversation-1' }]
    }

    // When
    const runId = await resolveCancellationRunId(command, lookup, () => [])

    // Then
    assert.equal(runId, 'run-1')
    assert.equal(requestedClientId, 'command-1')
    assert.equal(excludedId, 'cancel-1')
  })

  it('定位到 Run 后实际触发 AbortController.cancel', async () => {
    // Given
    const registry = new RunCancellationRegistry()
    const controller = new AbortController()
    registry.register('run-cancel', 'conversation-cancel', controller)
    const command: RemoteCommandCancellationRow = {
      id: 'cancel-real',
      content: '/cancel',
      client_command_id: 'command-real',
    }

    // When
    const runId = await resolveCancellationRunId(
      command,
      async () => [{ runId: 'run-cancel', conversationId: 'conversation-cancel' }],
      () => registry.runIdsForConversation('conversation-cancel'),
    )
    if (!runId) throw new Error('expected a resolved run')
    const cancelled = registry.cancel(runId)

    // Then
    assert.equal(cancelled, true)
    assert.equal(controller.signal.aborted, true)
  })

  it('原始命令尚未回填 run_id 时回退到对话唯一活动 Run', async () => {
    // Given: client_command_id 查询没有可用 run_id，但 registry 中对话只有一个 Run
    const command: RemoteCommandCancellationRow = {
      id: 'cancel-2',
      content: '/cancel',
      client_command_id: 'command-2',
      conversation_id: 'conversation-2',
    }

    // When
    const runId = await resolveCancellationRunId(
      command,
      async () => [{ runId: null, conversationId: 'conversation-2' }],
      (conversationId) => conversationId === 'conversation-2' ? ['run-2'] : [],
    )

    // Then
    assert.equal(runId, 'run-2')
  })

  it('同一对话存在多个活动 Run 时不误取消', async () => {
    // Given: registry 无法唯一确定目标 Run
    const command: RemoteCommandCancellationRow = {
      id: 'cancel-3',
      content: '/cancel',
      client_command_id: 'command-3',
      conversation_id: 'conversation-3',
    }

    // When
    const runId = await resolveCancellationRunId(
      command,
      async () => [],
      () => ['run-a', 'run-b'],
    )

    // Then
    assert.equal(runId, null)
  })

  it('识别 metadata.cancel_requested 取消标记', () => {
    assert.equal(isCancellationCommand({
      id: 'cancel-4',
      content: '任意内容',
      metadata: { cancel_requested: true },
    }), true)
  })

  it('取消请求中断模型执行并终态 cancelled when run is aborted', async () => {
    // Given
    const registry = new RunCancellationRegistry()
    const controller = new AbortController()
    registry.register('run-model', 'conversation-model', controller)
    const signal = createRemoteRunSignal(controller, 30_000)
    let requestSignal: AbortSignal | undefined
    let markModelStarted = (): void => {}
    const modelStarted = new Promise<void>((resolve) => { markModelStarted = resolve })
    const model = emptyStreamModel(async (request): Promise<ModelResponse> => {
      requestSignal = request.signal
      markModelStarted()
      await waitForAbort(request)
      return modelResponse()
    })

    // When
    const loopPromise = runExecutionLoop({
      model,
      hasTools: false,
      buildRequest: () => ({
        provider: 'test',
        model: 'test-model',
        messages: [],
        signal,
      }),
      executeTool: async () => '',
    }, [], { signal })
    await modelStarted
    registry.cancel('run-model')
    const loopResult = await loopPromise
    const outcome = mapExecutionLoopResult(loopResult, controller.signal.aborted)

    // Then
    assert.equal(requestSignal, signal)
    assert.equal(signal.aborted, true)
    assert.equal(outcome.kind, 'cancel')
  })

  it('取消请求中断工具执行并终态 cancelled when run is aborted', async () => {
    // Given
    const registry = new RunCancellationRegistry()
    const controller = new AbortController()
    registry.register('run-tool', 'conversation-tool', controller)
    const signal = createRemoteRunSignal(controller, 30_000)
    let toolSignal: AbortSignal | undefined
    let markToolStarted = (): void => {}
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve })
    const model = emptyStreamModel(async () => modelResponse({
      toolCalls: [{ id: 'tool-1', name: 'execute_command', arguments: '{}' }],
    }))

    // When
    const loopPromise = runExecutionLoop({
      model,
      hasTools: true,
      buildRequest: () => ({
        provider: 'test',
        model: 'test-model',
        messages: [],
        signal,
      }),
      executeTool: () => runCancellable(async (activeSignal: AbortSignal) => {
        toolSignal = activeSignal
        markToolStarted()
        await waitForAbort({ signal: activeSignal })
        return ''
      }, signal),
    }, [], { signal })
    await toolStarted
    registry.cancel('run-tool')
    const loopResult = await loopPromise
    const outcome = mapExecutionLoopResult(loopResult, controller.signal.aborted)

    // Then
    assert.equal(toolSignal, signal)
    assert.equal(signal.aborted, true)
    assert.equal(outcome.kind, 'cancel')
  })
})
