/**
 * Aether 2.0 — Legacy EventBus ↔ v2 Events Adapter (P3-08)
 *
 * Bridges the OLD activity_events-based EventBus (v1 AgentEventEnvelope,
 * conversation-scoped) and the NEW v2 AgentEvent (run-scoped discriminated
 * union). The legacy bus in src/backend/src/lib/event-bus stays untouched;
 * this adapter maps rows/envelopes in both directions so the old path keeps
 * working while new run-scoped events can be synced into the v2 EventStore.
 *
 * Mapping reuses the shared v1↔v2 helpers (toLegacy/toV2) from @pacc/shared.
 */

import type { AgentEventEnvelope, AgentEventType } from '@pacc/shared';
import { toLegacy, toV2 } from '@pacc/shared';
import type { AgentEvent } from '@pacc/shared';

/** Row shape mirroring the legacy activity_events table (parsed JSON fields) */
export interface LegacyEventRow {
  id: string;
  conversationId: string;
  taskId: string;
  agentId: string;
  agentType: string;
  eventType: string;
  seq: number;
  status?: string;
  content?: string;
  tool?: Record<string, unknown>;
  parentEventId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Convert a v2 AgentEvent into a legacy activity_events row shape.
 * conversationId = event.sessionId; taskId = event.taskId ?? event.runId.
 */
export function toLegacyRow(event: AgentEvent): LegacyEventRow {
  const envelope = toLegacy(event);
  return {
    id: event.eventId,
    conversationId: event.sessionId,
    taskId: event.taskId ?? event.runId,
    agentId: envelope.agentId ?? 'main',
    agentType: envelope.agentType ?? 'conversation',
    eventType: envelope.eventType,
    seq: event.seq,
    status: envelope.status,
    content: envelope.content,
    tool: envelope.tool !== undefined ? { ...envelope.tool } : undefined,
    parentEventId: event.parentEventId,
    metadata: envelope.metadata ?? event.metadata,
    createdAt: event.timestamp,
  };
}

/**
 * Convert a legacy activity_events row into a v2 AgentEvent.
 * runId defaults to row.taskId when not provided.
 */
export function fromLegacyRow(row: LegacyEventRow, runId?: string): AgentEvent {
  const envelope: AgentEventEnvelope = {
    eventId: row.id,
    sessionId: row.conversationId,
    taskId: row.taskId,
    agentId: row.agentId ?? 'main',
    agentType: row.agentType ?? 'conversation',
    eventType: row.eventType as AgentEventType,
    timestamp: row.createdAt,
    seq: row.seq,
  };
  if (row.status !== undefined) envelope.status = row.status as never;
  if (row.content !== undefined) envelope.content = row.content;
  if (row.tool !== undefined) envelope.tool = row.tool as never;
  if (row.parentEventId !== undefined) envelope.parentEventId = row.parentEventId;
  if (row.metadata !== undefined) envelope.metadata = row.metadata;

  return toV2(envelope, runId ?? row.taskId);
}

/**
 * Sync a batch of legacy rows into v2 events for a target run, preserving
 * seq order. The caller appends the result to the v2 EventStore.
 */
export function syncLegacyToNew(legacyRows: LegacyEventRow[], runId: string): AgentEvent[] {
  const sorted = [...legacyRows].sort((a, b) => a.seq - b.seq);
  return sorted.map((row) => fromLegacyRow(row, runId));
}

/** Emit parameters understood by the legacy EventBus.emit() path */
export interface LegacyEmitParams {
  sessionId: string;
  eventType: string;
  fields: Record<string, unknown>;
  seq: number;
}

/**
 * Drive a legacy EventBus.emit from a stream of v2 events.
 * For each v2 event, maps to the v1 envelope and calls legacyEmit with
 * the sessionId/eventType/seq and the envelope fields the legacy path needs.
 */
export function syncNewToLegacy(
  events: AgentEvent[],
  legacyEmit: (params: LegacyEmitParams) => void,
): void {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    const envelope = toLegacy(event);
    const fields: Record<string, unknown> = {};
    if (envelope.taskId !== undefined) fields.taskId = envelope.taskId;
    if (envelope.agentId !== undefined) fields.agentId = envelope.agentId;
    if (envelope.agentType !== undefined) fields.agentType = envelope.agentType;
    if (envelope.status !== undefined) fields.status = envelope.status;
    if (envelope.content !== undefined) fields.content = envelope.content;
    if (envelope.tool !== undefined) fields.tool = envelope.tool;
    if (envelope.parentEventId !== undefined) fields.parentEventId = envelope.parentEventId;
    if (envelope.metadata !== undefined) fields.metadata = envelope.metadata;
    if (envelope.endReason !== undefined) fields.endReason = envelope.endReason;

    legacyEmit({
      sessionId: event.sessionId,
      eventType: envelope.eventType,
      fields,
      seq: event.seq,
    });
  }
}