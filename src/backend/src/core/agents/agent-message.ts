/**
 * Agent Message — Aether 2.0 Agent-to-Agent Messaging (P1-24)
 *
 * Standardized message envelope for agent communication within a run.
 * Supports send/respond/request/broadcast/delegate/handoff via the type field.
 *
 * Transport-agnostic: no Fastify, no SSE, no React — pure TypeScript.
 */

import { randomUUID } from 'node:crypto';

/** Message categories used by the agent messaging protocol */
export type AgentMessageType = 'user' | 'assistant' | 'tool' | 'system' | 'handoff';

/**
 * A single agent message.
 * `id` and `createdAt` are assigned by createAgentMessage; the rest is caller-supplied.
 */
export interface AgentMessage {
  /** Unique message id (uuid) */
  id: string;
  /** Owning run id */
  runId: string;
  /** Optional task id */
  taskId?: string;
  /** Sender agent id (undefined for user/system-origin messages) */
  fromAgentId?: string;
  /** Recipient agent id (undefined for broadcast/system messages) */
  toAgentId?: string;
  /** Message type */
  type: AgentMessageType;
  /** Message content */
  content: string;
  /** Parent message id for threaded replies (optional) */
  parentMessageId?: string;
  /** ISO8601 creation timestamp */
  createdAt: string;
  /** Structured extensions (tool payloads, handoff context, etc.) */
  metadata?: Record<string, unknown>;
}

/** Input shape for createAgentMessage — everything except id/createdAt */
export type CreateAgentMessageInput = Omit<AgentMessage, 'id' | 'createdAt'>;

/**
 * Creates a new agent message with a generated uuid and ISO timestamp.
 *
 * @param input - Message fields (id and createdAt are auto-assigned)
 * @returns A complete AgentMessage
 */
export function createAgentMessage(input: CreateAgentMessageInput): AgentMessage {
  return {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Type guard: checks whether a value is a well-formed AgentMessage.
 */
export function isAgentMessage(value: unknown): value is AgentMessage {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.runId === 'string' &&
    typeof m.content === 'string' &&
    typeof m.createdAt === 'string' &&
    (typeof m.type === 'string')
  );
}