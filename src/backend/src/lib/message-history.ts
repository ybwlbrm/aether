import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { SQLJsDatabase } from 'drizzle-orm/sql-js'
import * as schema from '../db/schema/index.js'
import { messages } from '../db/schema/index.js'
import type { AssistantToolCallMessage } from '../core/runtime/execution-loop.js'

type Db = SQLJsDatabase<typeof schema>
type StoredToolCall = {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

type StoredMessage = {
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly content: string
  readonly toolCalls?: string | null
  readonly reasoningContent?: string | null
}

export type ProviderMessage = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return null
  }
}

function isStoredToolCall(value: unknown): value is StoredToolCall {
  if (!isRecord(value) || value.id === undefined || typeof value.id !== 'string' || value.type !== 'function' || !isRecord(value.function)) return false
  const name = value.function.name
  if (typeof name !== 'string') return false
  return typeof value.function.arguments === 'string' || value.function.arguments === undefined || value.function.arguments === null
}

function normalizeToolCall(value: unknown): StoredToolCall | null {
  if (!isStoredToolCall(value)) return null
  const rawArguments = value.function.arguments
  const args = typeof rawArguments === 'string'
    ? rawArguments
    : JSON.stringify(rawArguments ?? {})
  return {
    id: value.id,
    type: 'function',
    function: {
      name: value.function.name,
      arguments: args,
    },
  }
}

function parseToolCalls(value: string | null | undefined): StoredToolCall[] {
  const parsed = parseJson(value)
  const candidates = Array.isArray(parsed) ? parsed : [parsed]
  const seenIds = new Set<string>()
  return candidates.flatMap((item) => {
    const normalized = normalizeToolCall(item)
    if (!normalized || seenIds.has(normalized.id)) return []
    seenIds.add(normalized.id)
    return [normalized]
  })
}

function parseToolCallId(value: string | null | undefined): string | null {
  return parseToolCalls(value)[0]?.id ?? null
}

function hasToolCalls(message: Record<string, unknown>): message is Record<string, unknown> & { readonly tool_calls: readonly StoredToolCall[] } {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return false
  return message.tool_calls.every(isStoredToolCall)
}

/**
 * 从持久化消息重建 Provider 上下文。
 *
 * 规则：
 * - assistant.tool_calls 统一为 OpenAI function-call 数组；
 * - tool.tool_call_id 只接受紧随其前、尚未消费的 assistant.tool_calls.id；
 * - 不完整 tool-call 组整体丢弃，避免 Provider 收到孤立 tool 或未闭合 tool_calls。
 */
export function rebuildProviderMessages(rows: readonly StoredMessage[]): ProviderMessage[] {
  const messagesOut: ProviderMessage[] = []
  let pendingAssistantIndex: number | null = null
  let pendingToolMessageIndices: number[] = []
  let pendingToolCallIds = new Set<string>()

  const discardPendingToolCall = (): void => {
    if (pendingAssistantIndex === null) return
    for (const index of [...pendingToolMessageIndices].sort((left, right) => right - left)) {
      messagesOut.splice(index, 1)
    }
    messagesOut.splice(pendingAssistantIndex, 1)
    pendingAssistantIndex = null
    pendingToolMessageIndices = []
    pendingToolCallIds = new Set()
  }

  const closePendingToolCall = (): void => {
    pendingAssistantIndex = null
    pendingToolMessageIndices = []
    pendingToolCallIds = new Set()
  }

  for (const row of rows) {
    if (row.role === 'tool') {
      const toolCallId = parseToolCallId(row.toolCalls)
      if (pendingAssistantIndex === null || toolCallId === null || !pendingToolCallIds.has(toolCallId)) continue
      messagesOut.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: row.content,
      })
      pendingToolMessageIndices.push(messagesOut.length - 1)
      pendingToolCallIds.delete(toolCallId)
      if (pendingToolCallIds.size === 0) closePendingToolCall()
      continue
    }

    if (row.role === 'assistant') {
      discardPendingToolCall()
      const toolCalls = parseToolCalls(row.toolCalls)
      const assistant: ProviderMessage = {
        role: 'assistant',
        content: row.content,
      }
      if (row.reasoningContent) assistant.reasoning_content = row.reasoningContent
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls
        messagesOut.push(assistant)
        pendingAssistantIndex = messagesOut.length - 1
        pendingToolMessageIndices = []
        pendingToolCallIds = new Set(toolCalls.map((call) => call.id))
      } else {
        messagesOut.push(assistant)
        closePendingToolCall()
      }
      continue
    }

    discardPendingToolCall()
    messagesOut.push({
      role: row.role,
      content: row.content,
    })
  }

  discardPendingToolCall()
  return messagesOut
}

export function countOrphanToolMessages(messagesToCheck: readonly ProviderMessage[]): number {
  const pendingIds = new Set<string>()
  let orphanCount = 0
  for (const message of messagesToCheck) {
    if (message.role === 'assistant' && hasToolCalls(message)) {
      pendingIds.clear()
      for (const call of message.tool_calls) pendingIds.add(call.id)
      continue
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id
      if (typeof id !== 'string' || !pendingIds.has(id)) {
        orphanCount += 1
      } else {
        pendingIds.delete(id)
      }
      continue
    }
    pendingIds.clear()
  }
  return orphanCount
}

function nextMessageSeq(db: Db, conversationId: string): number {
  const row = db.select({ maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0)` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .get()
  return (row?.maxSeq ?? 0) + 1
}

export function persistAssistantToolCallMessage(
  db: Db,
  conversationId: string,
  message: AssistantToolCallMessage,
): string {
  const id = randomUUID()
  db.insert(messages).values({
    id,
    conversationId,
    role: 'assistant',
    content: message.content,
    toolCalls: JSON.stringify(message.tool_calls),
    reasoningContent: message.reasoning_content ?? null,
    seq: nextMessageSeq(db, conversationId),
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

export function persistToolResultMessage(
  db: Db,
  conversationId: string,
  toolCallId: string,
  functionName: string,
  args: string,
  content: string,
): string {
  const id = randomUUID()
  db.insert(messages).values({
    id,
    conversationId,
    role: 'tool',
    content,
    toolCalls: JSON.stringify({
      id: toolCallId,
      type: 'function',
      function: {
        name: functionName,
        arguments: args,
      },
    }),
    seq: nextMessageSeq(db, conversationId),
    createdAt: new Date().toISOString(),
  }).run()
  return id
}
