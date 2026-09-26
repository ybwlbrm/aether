export type RemoteCommandStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RemoteCommandReference = {
  readonly serverId: string | null
  readonly clientCommandId: string | null
}

export type RemoteCommandSnapshot = {
  readonly id: string
  readonly status: RemoteCommandStatus
  readonly resultSummary: string | null
  readonly error: string | null
  readonly clientCommandId?: string | null
  readonly isCancellation?: boolean
}

export type RemoteCommandSnapshotInput = {
  readonly id: string
  readonly status: RemoteCommandStatus
  readonly resultSummary?: string | null
  readonly error?: string | null
  readonly clientCommandId?: string | null
  readonly isCancellation?: boolean
}

export type CancelCommandInput = {
  readonly deviceId: string
  readonly userId: string
  readonly conversationId: string
  readonly originalClientCommandId: string
}

export type CancelCommandPayload = {
  readonly device_id: string
  readonly user_id: string
  readonly conversation_id: string
  readonly content: '/cancel'
  readonly status: 'cancelled'
  readonly client_command_id: string
  readonly metadata: {
    readonly cancel_requested: true
  }
}

export function buildCancelCommandPayload(input: CancelCommandInput): CancelCommandPayload {
  const originalClientCommandId = input.originalClientCommandId.trim()
  if (!originalClientCommandId) throw new Error('缺少原始命令 clientCommandId')

  return {
    device_id: input.deviceId,
    user_id: input.userId,
    conversation_id: input.conversationId,
    content: '/cancel',
    status: 'cancelled',
    client_command_id: originalClientCommandId,
    metadata: { cancel_requested: true },
  }
}

function hasCancelRequestedMetadata(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return 'cancel_requested' in value && value.cancel_requested === true
}

function isRemoteCommandStatus(value: unknown): value is RemoteCommandStatus {
  return value === 'pending'
    || value === 'processing'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
}

export function buildRemoteCommandSnapshot(input: RemoteCommandSnapshotInput): RemoteCommandSnapshot {
  return {
    id: input.id,
    status: input.status,
    resultSummary: input.resultSummary ?? null,
    error: input.error ?? null,
    clientCommandId: input.clientCommandId ?? null,
    isCancellation: input.isCancellation ?? false,
  }
}

export function parseRemoteCommandSnapshot(value: unknown): RemoteCommandSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if (!('id' in value) || !('status' in value)) return null
  const id = value.id
  const status = value.status
  if (typeof id !== 'string' || !isRemoteCommandStatus(status)) return null
  const resultSummary = 'result_summary' in value && typeof value.result_summary === 'string'
    ? value.result_summary
    : null
  const error = 'error' in value && typeof value.error === 'string' ? value.error : null
  const clientCommandId = 'client_command_id' in value && typeof value.client_command_id === 'string'
    ? value.client_command_id
    : null
  const content = 'content' in value && typeof value.content === 'string' ? value.content : null
  const metadata = 'metadata' in value ? value.metadata : null
  const isCancellation = content?.trim() === '/cancel' || hasCancelRequestedMetadata(metadata)
  return buildRemoteCommandSnapshot({
    id,
    status,
    resultSummary,
    error,
    clientCommandId,
    isCancellation,
  })
}

export function matchesRemoteCommandReference(
  snapshot: RemoteCommandSnapshot,
  reference: RemoteCommandReference,
): boolean {
  if (snapshot.isCancellation === true) return false
  if (reference.serverId && snapshot.id === reference.serverId) return true
  return Boolean(reference.clientCommandId && snapshot.clientCommandId === reference.clientCommandId)
}

export function isTerminalRemoteCommandStatus(status: RemoteCommandStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function shouldPollRemoteCommandStatus(status: RemoteCommandStatus): boolean {
  return !isTerminalRemoteCommandStatus(status)
}

export function getRemainingCommandTimeoutMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now)
}

export type CancellationAction = 'cancel_local' | 'wait_remote' | 'reject'

export function resolveCancellationAction(input: {
  readonly hasQueuedCommand: boolean
  readonly hasRemoteCommand: boolean
}): CancellationAction {
  if (input.hasQueuedCommand) return 'cancel_local'
  if (input.hasRemoteCommand) return 'wait_remote'
  return 'reject'
}
