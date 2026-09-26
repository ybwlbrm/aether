import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { logger } from '../../lib/logger.js'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { BackendConfig } from '../../config/index.js'
import { runMigrations } from '../../db/migrate.js'
import { flushDbSync, getDb, initDb, setDbForTest } from '../../db/client.js'
import { RunLifecycleManager } from '../../core/runtime/index.js'
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js'
import {
  finalizeRemoteCommand,
  type RemoteCommandTerminalStatus,
} from './remote-command-terminal.js'

type JsonRecord = Record<string, unknown>
type FakeSupabase = {
  readonly sb: SupabaseClient
  readonly terminalUpdates: JsonRecord[]
}

let config: BackendConfig

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePayload(body: NonNullable<Parameters<typeof fetch>[1]>['body']): JsonRecord {
  if (typeof body !== 'string') return {}
  const parsed: unknown = JSON.parse(body || '{}')
  return isRecord(parsed) ? parsed : {}
}

function terminalStatusOf(payload: JsonRecord): RemoteCommandTerminalStatus | null {
  const status = payload.status
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return null
  return typeof payload.processed_at === 'string' ? status : null
}

function createFakeSupabase(
  failureStatus: RemoteCommandTerminalStatus,
  failureCount: number,
): FakeSupabase {
  const terminalUpdates: JsonRecord[] = []
  let remainingFailures = failureCount
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname.includes('supabase.co') && url.pathname.endsWith('/remote_commands') && init?.method === 'PATCH') {
      const payload = parsePayload(init.body)
      const status = terminalStatusOf(payload)
      if (status !== null) {
        terminalUpdates.push(payload)
        if (status === failureStatus && remainingFailures > 0) {
          remainingFailures -= 1
          return new Response(
            JSON.stringify({ code: 'PGRST999', message: 'forced terminal update failure' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }
      }
    }
    return new Response(null, { status: 204 })
  }
  const sb = createClient('https://example.supabase.co', 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fakeFetch },
  })
  return { sb, terminalUpdates }
}

function startRun(runId: string): RunLifecycleManager {
  const lifecycle = new RunLifecycleManager(getDb())
  lifecycle.createAndStart({ runId, mode: 'normal' })
  return lifecycle
}

function terminalMetadata(payload: JsonRecord): JsonRecord | null {
  if (!isRecord(payload.metadata)) return null
  return isRecord(payload.metadata.terminal_sync) ? payload.metadata.terminal_sync : null
}

function errorLogText(log: ReturnType<typeof mock.method>): string {
  return log.mock.calls
    .map((call) =>
      call.arguments
        .map((arg) => (typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg)))
        .join(' '),
    )
    .join('\n')
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacc-command-terminal-'))
  config = makeTestConfig(dir)
  await runMigrations(config)
  await initDb(config)
})

after(() => {
  flushDbSync(config)
  setDbForTest(null)
  rmSync(config.dataDir, { recursive: true, force: true })
})

describe('Remote Command 终态协调', () => {
  it('远端终态 update 返回 error 时保留本地完成态并补偿标记未同步', async () => {
    // Given
    const fake = createFakeSupabase('completed', 1)
    const lifecycle = startRun('run-update-error')
    const errorLog = mock.method(logger, 'error', () => undefined)

    // When
    let finalized: Awaited<ReturnType<typeof finalizeRemoteCommand>> | null = null
    try {
      finalized = await finalizeRemoteCommand({
        sb: fake.sb,
        commandId: 'command-update-error',
        runId: 'run-update-error',
        taskId: 'run-update-error',
        conversationId: 'conversation-update-error',
        status: 'completed',
        resultSummary: '完成',
        error: null,
        existingMetadata: null,
        transitionRun: () => { lifecycle.transition('run-update-error', 'complete') },
      })
    } finally {
      errorLog.mock.restore()
    }
    assert.ok(finalized)

    // Then
    assert.equal(lifecycle.get('run-update-error')?.status, 'completed')
    assert.equal(finalized.remoteSync.kind, 'compensated')
    assert.equal(fake.terminalUpdates.length, 2)
    assert.equal(fake.terminalUpdates[1]?.status, 'completed')
    assert.equal(terminalMetadata(fake.terminalUpdates[1] ?? {})?.state, 'unsynced')
    assert.match(errorLogText(errorLog), /run-update-error.*command-update-error.*completed.*forced terminal update failure/)
  })

  it('本地 Run 终态转换失败时远端回写 failed 而不是 completed', async () => {
    // Given
    const fake = createFakeSupabase('failed', 0)
    const lifecycle = startRun('run-transition-failure')
    const errorLog = mock.method(logger, 'error', () => undefined)

    // When
    let finalized: Awaited<ReturnType<typeof finalizeRemoteCommand>> | null = null
    try {
      finalized = await finalizeRemoteCommand({
        sb: fake.sb,
        commandId: 'command-transition-failure',
        runId: 'run-transition-failure',
        taskId: 'run-transition-failure',
        conversationId: 'conversation-transition-failure',
        status: 'completed',
        resultSummary: '完成',
        error: null,
        existingMetadata: null,
        transitionRun: () => { throw new Error('forced run transition failure') },
      })
    } finally {
      errorLog.mock.restore()
    }
    assert.ok(finalized)

    // Then
    assert.equal(lifecycle.get('run-transition-failure')?.status, 'running')
    assert.equal(finalized.status, 'failed')
    const finalUpdate = fake.terminalUpdates.at(-1) ?? {}
    assert.equal(finalUpdate.status, 'failed')
    assert.match(String(finalUpdate.error), /Run terminal transition failed.*forced run transition failure/)
    assert.match(errorLogText(errorLog), /run-transition-failure.*command-transition-failure.*forced run transition failure/)
  })

  it('cancelled 终态 update 返回 error 时执行同一未同步补偿', async () => {
    // Given
    const fake = createFakeSupabase('cancelled', 1)
    const lifecycle = startRun('run-cancelled-error')
    const errorLog = mock.method(logger, 'error', () => undefined)

    // When
    let finalized: Awaited<ReturnType<typeof finalizeRemoteCommand>> | null = null
    try {
      finalized = await finalizeRemoteCommand({
        sb: fake.sb,
        commandId: 'command-cancelled-error',
        runId: 'run-cancelled-error',
        taskId: 'run-cancelled-error',
        conversationId: 'conversation-cancelled-error',
        status: 'cancelled',
        resultSummary: 'aborted: 用户已停止任务',
        error: 'aborted',
        existingMetadata: { cancel_requested: true },
        transitionRun: () => { lifecycle.transition('run-cancelled-error', 'cancel') },
      })
    } finally {
      errorLog.mock.restore()
    }
    assert.ok(finalized)

    // Then
    assert.equal(lifecycle.get('run-cancelled-error')?.status, 'cancelled')
    assert.equal(finalized.remoteSync.kind, 'compensated')
    assert.equal(fake.terminalUpdates.length, 2)
    assert.equal(fake.terminalUpdates[1]?.status, 'cancelled')
    assert.equal(terminalMetadata(fake.terminalUpdates[1] ?? {})?.state, 'unsynced')
    const compensationMetadata = fake.terminalUpdates[1]?.metadata
    assert.equal(isRecord(compensationMetadata) ? compensationMetadata.cancel_requested : null, true)
    assert.match(errorLogText(errorLog), /run-cancelled-error.*command-cancelled-error.*cancelled.*forced terminal update failure/)
  })
})
