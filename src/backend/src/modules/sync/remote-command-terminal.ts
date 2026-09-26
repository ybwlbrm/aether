import type { SupabaseClient } from '@supabase/supabase-js'

export type RemoteCommandTerminalStatus = 'completed' | 'failed' | 'cancelled'

export type RemoteCommandTerminalUpdate = {
  readonly sb: SupabaseClient
  readonly commandId: string
  readonly runId: string | null
  readonly taskId: string | null
  readonly conversationId: string | null
  readonly status: RemoteCommandTerminalStatus
  readonly resultSummary: string
  readonly error: string | null
  readonly existingMetadata: unknown
  readonly processedAt?: string
}

export type RemoteCommandTerminalSyncResult = {
  readonly kind: 'synced' | 'compensated' | 'unsynced'
  readonly error: string | null
}

export type FinalizeRemoteCommandInput = RemoteCommandTerminalUpdate & {
  readonly transitionRun: () => void
}

export type FinalizeRemoteCommandResult = {
  readonly status: RemoteCommandTerminalStatus
  readonly error: string | null
  readonly resultSummary: string
  readonly remoteSync: RemoteCommandTerminalSyncResult
}

type JsonRecord = Record<string, unknown>

type UpdateAttempt = {
  readonly error: string | null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function terminalContext(input: RemoteCommandTerminalUpdate): JsonRecord {
  return {
    command_id: input.commandId,
    run_id: input.runId,
    task_id: input.taskId,
    intended_status: input.status,
  }
}

function terminalMetadata(
  input: RemoteCommandTerminalUpdate,
  failure: string,
  markedAt: string,
): JsonRecord {
  const current = isRecord(input.existingMetadata) ? input.existingMetadata : {}
  return {
    ...current,
    terminal_sync: {
      ...terminalContext(input),
      state: 'unsynced',
      error: failure,
      marked_at: markedAt,
    },
  }
}

async function executeUpdate(
  input: RemoteCommandTerminalUpdate,
  patch: JsonRecord,
): Promise<UpdateAttempt> {
  try {
    const { error } = await input.sb
      .from('remote_commands')
      .update(patch)
      .eq('id', input.commandId)
    return { error: error?.message ?? null }
  } catch (error: unknown) {
    return { error: errorMessage(error) }
  }
}

/**
 * 原子写入命令终态；首次失败时以 metadata.terminal_sync=unsynced 重试，
 * 保留 Mobile 已使用的 cancelled metadata，并让补偿状态可审计。
 */
export async function updateRemoteCommandTerminal(
  input: RemoteCommandTerminalUpdate,
): Promise<RemoteCommandTerminalSyncResult> {
  const processedAt = input.processedAt ?? new Date().toISOString()
  const basePatch: JsonRecord = {
    status: input.status,
    result_summary: input.resultSummary,
    error: input.error,
    processed_at: processedAt,
    ...(input.conversationId === null ? {} : { conversation_id: input.conversationId }),
    ...(input.runId === null ? {} : { run_id: input.runId, task_id: input.taskId }),
  }
  const initial = await executeUpdate(input, basePatch)
  if (initial.error === null) return { kind: 'synced', error: null }

  console.error(
    `[Sync] remote command terminal update failed (runId=${input.runId ?? 'none'}, taskId=${input.taskId ?? 'none'}, commandId=${input.commandId}, status=${input.status}):`,
    initial.error,
  )
  const compensation = await executeUpdate(input, {
    ...basePatch,
    metadata: terminalMetadata(input, initial.error, processedAt),
  })
  if (compensation.error === null) {
    console.error(
      `[Sync] remote command terminal compensation written as unsynced (runId=${input.runId ?? 'none'}, taskId=${input.taskId ?? 'none'}, commandId=${input.commandId}, status=${input.status})`,
    )
    return { kind: 'compensated', error: initial.error }
  }

  console.error(
    `[Sync] remote command terminal unsynced marker failed (runId=${input.runId ?? 'none'}, taskId=${input.taskId ?? 'none'}, commandId=${input.commandId}, status=${input.status}):`,
    compensation.error,
  )
  return { kind: 'unsynced', error: compensation.error }
}

/** 先提交本地 Run 终态；本地转换失败时将远端语义降级为 failed，再执行远端补偿。 */
export async function finalizeRemoteCommand(
  input: FinalizeRemoteCommandInput,
): Promise<FinalizeRemoteCommandResult> {
  let status = input.status
  let error = input.error
  let resultSummary = input.resultSummary

  try {
    input.transitionRun()
  } catch (transitionError: unknown) {
    const transitionErrorMessage = errorMessage(transitionError)
    status = 'failed'
    error = `Run terminal transition failed: ${transitionErrorMessage}`
    resultSummary = error
    console.error(
      `[Sync] run terminal transition failed (runId=${input.runId ?? 'none'}, taskId=${input.taskId ?? 'none'}, commandId=${input.commandId}, status=${status}):`,
      transitionErrorMessage,
    )
  }

  const remoteSync = await updateRemoteCommandTerminal({
    sb: input.sb,
    commandId: input.commandId,
    runId: input.runId,
    taskId: input.taskId,
    conversationId: input.conversationId,
    status,
    resultSummary,
    error,
    existingMetadata: input.existingMetadata,
    processedAt: input.processedAt,
  })
  return { status, error, resultSummary, remoteSync }
}
