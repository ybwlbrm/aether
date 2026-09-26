import type { SupabaseClient } from '@supabase/supabase-js'

export type RemoteCommandCancellationRow = {
  readonly id: string
  readonly content?: string | null
  readonly status?: string | null
  readonly conversation_id?: string | null
  readonly client_command_id?: string | null
  readonly run_id?: string | null
  readonly task_id?: string | null
  readonly metadata?: unknown
}

export type RemoteCommandInput = RemoteCommandCancellationRow & {
  readonly content: string
  readonly user_id?: string | null
}

export type CancellationTarget = {
  readonly runId: string | null
  readonly conversationId: string | null
}

export type CancellationLookup = (
  clientCommandId: string,
  cancelCommandId: string,
) => Promise<readonly CancellationTarget[]>

export type ConversationRunLookup = (conversationId: string) => readonly string[]

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function hasCancelRequested(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false
  return 'cancel_requested' in metadata && metadata.cancel_requested === true
}

export const DEFAULT_REMOTE_COMMAND_TIMEOUT_MS = 300_000

/** 创建一个供模型、工具与执行循环共享的 Run 信号。 */
export function createRemoteRunSignal(
  controller: AbortController,
  timeoutMs: number = DEFAULT_REMOTE_COMMAND_TIMEOUT_MS,
): AbortSignal {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Remote command cancelled')
}

export function throwIfRemoteRunCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal)
}

/** 在异步工具执行前后检查共享信号，防止取消结果继续落库或返回给模型。 */
export async function runCancellable<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfRemoteRunCancelled(signal)
  const result = await operation(signal)
  throwIfRemoteRunCancelled(signal)
  return result
}

export function isCancellationCommand(command: RemoteCommandCancellationRow): boolean {
  return command.content?.trim() === '/cancel' || hasCancelRequested(command.metadata)
}

export function parseRemoteCommandRow(
  value: Record<string, unknown>,
): RemoteCommandInput | null {
  const id = firstNonEmpty(typeof value.id === 'string' ? value.id : null)
  const content = typeof value.content === 'string' ? value.content : null
  if (!id || content === null) return null
  return {
    id,
    content,
    status: typeof value.status === 'string' ? value.status : null,
    conversation_id: typeof value.conversation_id === 'string' ? value.conversation_id : null,
    client_command_id: typeof value.client_command_id === 'string' ? value.client_command_id : null,
    run_id: typeof value.run_id === 'string' ? value.run_id : null,
    task_id: typeof value.task_id === 'string' ? value.task_id : null,
    metadata: value.metadata,
    user_id: typeof value.user_id === 'string' ? value.user_id : null,
  }
}

/**
 * 解析取消信号对应的活动 Run。
 * 优先使用取消行回填的 run_id/task_id，其次按 client_command_id 找原始命令，
 * 最后仅在对话中恰好有一个活动 Run 时使用 conversation_id 兜底。
 */
export async function resolveCancellationRunId(
  command: RemoteCommandCancellationRow,
  lookupByClientCommandId: CancellationLookup,
  lookupRunsByConversation: ConversationRunLookup,
): Promise<string | null> {
  const directRunId = firstNonEmpty(command.run_id, command.task_id)
  if (directRunId) return directRunId

  const clientCommandId = firstNonEmpty(command.client_command_id)
  const targets = clientCommandId
    ? await lookupByClientCommandId(clientCommandId, command.id)
    : []

  const targetRunId = targets
    .map((target) => firstNonEmpty(target.runId))
    .find((runId): runId is string => runId !== null)
  if (targetRunId) return targetRunId

  const conversationId = firstNonEmpty(
    command.conversation_id,
    ...targets.map((target) => target.conversationId),
  )
  if (!conversationId) return null

  const runIds = lookupRunsByConversation(conversationId)
  return runIds.length === 1 ? firstNonEmpty(runIds[0]) : null
}

/** 创建生产环境使用的 Supabase 原始命令查询适配器。 */
export function createSupabaseCancellationLookup(sb: SupabaseClient): CancellationLookup {
  return async (clientCommandId, cancelCommandId) => {
    const { data, error } = await sb.from('remote_commands')
      .select('run_id, task_id, conversation_id')
      .eq('client_command_id', clientCommandId)
      .neq('id', cancelCommandId)
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) throw new Error(`查询取消目标命令失败: ${error.message}`)

    return (data ?? []).map((row) => ({
      runId: firstNonEmpty(
        typeof row.run_id === 'string' ? row.run_id : null,
        typeof row.task_id === 'string' ? row.task_id : null,
      ),
      conversationId: typeof row.conversation_id === 'string' ? row.conversation_id : null,
    }))
  }
}
