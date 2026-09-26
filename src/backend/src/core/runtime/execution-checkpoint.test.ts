import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createExecutionCheckpoint,
  deserializeCheckpoint,
  mergeStepResult,
  serializeCheckpoint,
  clearExecutionCheckpoints,
  getExecutionCheckpoint,
  recordExecutionCheckpoint,
  ExecutionCheckpointError,
  type CreateExecutionCheckpointInput,
  type ExecutionCheckpoint,
  type ExecutionStepResult,
} from './execution-checkpoint.js'

function input(overrides: Partial<CreateExecutionCheckpointInput> = {}): CreateExecutionCheckpointInput {
  return {
    runId: 'run-1',
    turn: 2,
    completedSteps: ['read'],
    pendingSteps: ['write', 'review'],
    toolResults: [{
      step: 'read',
      result: { content: 'source' },
      status: 'completed',
    }],
    lastError: null,
    currentObjective: '生成并校验报告',
    attempt: 1,
    seq: 5,
    ...overrides,
  }
}

function stepResult(overrides: Partial<ExecutionStepResult> = {}): ExecutionStepResult {
  return {
    step: 'write',
    result: { path: 'report.md' },
    status: 'completed',
    ...overrides,
  }
}

function invalidCheckpointError(assertion: (error: ExecutionCheckpointError) => void): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ExecutionCheckpointError)
    assertion(error)
    return true
  }
}

describe('core/runtime/execution-checkpoint', () => {
  it('round-trips all execution fields through JSON', () => {
    // Given
    const original = createExecutionCheckpoint(input())

    // When
    const restored = deserializeCheckpoint(serializeCheckpoint(original))

    // Then
    assert.deepEqual(restored, original)
  })

  it('rejects malformed JSON with an explicit checkpoint error', () => {
    // Given
    const malformed = '{not-json'

    // When / Then
    assert.throws(
      () => deserializeCheckpoint(malformed),
      invalidCheckpointError(error => {
        assert.equal(error.code, 'INVALID_EXECUTION_CHECKPOINT')
        assert.match(error.message, /JSON/)
      }),
    )
  })

  it('rejects a field with the wrong type', () => {
    // Given
    const raw = JSON.stringify({
      v: 1,
      checkpoint: {
        ...input(),
        turn: 'two',
      },
    })

    // When / Then
    assert.throws(
      () => deserializeCheckpoint(raw),
      invalidCheckpointError(error => {
        assert.match(error.message, /turn/)
      }),
    )
  })

  it('rejects values that JSON cannot represent safely', () => {
    // Given
    const raw = JSON.stringify({
      v: 1,
      checkpoint: {
        ...input(),
        toolResults: [{
          step: 'read',
          result: { value: 1e999 },
        }],
      },
    }).replace('"value":null', '"value":1e999')

    // When / Then
    assert.throws(
      () => deserializeCheckpoint(raw),
      invalidCheckpointError(error => {
        assert.match(error.message, /JSON|兼容/)
      }),
    )
  })

  it('merges a successful tool result into completed and pending steps', () => {
    // Given
    const checkpoint = createExecutionCheckpoint(input())
    const result = stepResult()

    // When
    const merged = mergeStepResult(checkpoint, result)

    // Then
    assert.deepEqual(merged.completedSteps, ['read', 'write'])
    assert.deepEqual(merged.pendingSteps, ['review'])
    assert.deepEqual(merged.toolResults.at(-1), result)
    assert.deepEqual(checkpoint.completedSteps, ['read'])
    assert.deepEqual(checkpoint.pendingSteps, ['write', 'review'])
  })

  it('keeps a failed step pending and records the error', () => {
    // Given
    const checkpoint = createExecutionCheckpoint(input())
    const result = stepResult({
      status: 'failed',
      error: '文件写入失败',
    })

    // When
    const merged = mergeStepResult(checkpoint, result)

    // Then
    assert.deepEqual(merged.pendingSteps, ['write', 'review'])
    assert.equal(merged.lastError, '文件写入失败')
    assert.deepEqual(checkpoint.pendingSteps, ['write', 'review'])
  })

  it('rejects a checkpoint whose turn moves backwards', () => {
    // Given
    const previous = createExecutionCheckpoint(input({ turn: 3, seq: 8 }))
    const older = createExecutionCheckpoint(input({ turn: 2, seq: 8 }))

    // When / Then
    assert.throws(
      () => deserializeCheckpoint(serializeCheckpoint(older), previous),
      invalidCheckpointError(error => {
        assert.match(error.message, /turn/)
      }),
    )
  })

  it('rejects a checkpoint whose sequence moves backwards', () => {
    // Given
    const previous = createExecutionCheckpoint(input({ turn: 3, seq: 8 }))
    const older = createExecutionCheckpoint(input({ turn: 3, seq: 7 }))

    // When / Then
    assert.throws(
      () => deserializeCheckpoint(serializeCheckpoint(older), previous),
      invalidCheckpointError(error => {
        assert.match(error.message, /seq/)
      }),
    )
  })

  it('creates a checkpoint with defaults for optional sequence state', () => {
    // Given
    const minimal: CreateExecutionCheckpointInput = {
      runId: 'run-2',
      turn: 0,
      completedSteps: [],
      pendingSteps: [],
      toolResults: [],
      lastError: null,
      currentObjective: '等待任务',
      attempt: 0,
    }

    // When
    const checkpoint: ExecutionCheckpoint = createExecutionCheckpoint(minimal)

    // Then
    assert.equal(checkpoint.seq, checkpoint.turn)
  })

  it('records the latest checkpoint per run and reads it back for retry recovery', () => {
    // Given
    clearExecutionCheckpoints()
    const first = createExecutionCheckpoint(input({ runId: 'run-store', turn: 1 }))
    const latest = createExecutionCheckpoint(input({ runId: 'run-store', turn: 2 }))

    // When
    recordExecutionCheckpoint(first)
    recordExecutionCheckpoint(latest)

    // Then
    assert.deepEqual(getExecutionCheckpoint('run-store'), latest)
    assert.equal(getExecutionCheckpoint('run-missing'), undefined)
  })

  it('rejects a checkpoint that cannot be recorded', () => {
    // Given
    clearExecutionCheckpoints()
    const invalid = { ...createExecutionCheckpoint(input()), runId: '' }

    // When / Then
    assert.throws(() => recordExecutionCheckpoint(invalid))
    assert.equal(getExecutionCheckpoint('run-1'), undefined)
  })
})
