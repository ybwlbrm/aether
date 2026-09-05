/**
 * Agent Context
 *
 * Execution context for agent operations, extending RuntimeContext with agent-specific features.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { createRuntimeContext, type RuntimeContext } from '../runtime/index.js';
import type { AgentDefinition } from './agent-definition.js';

/**
 * Inbox message structure.
 */
export interface InboxMessage {
  /** Unique message identifier */
  id: string;
  /** Sender identifier */
  from: string;
  /** Message content */
  content: string;
  /** Message type */
  type: string;
  /** ISO8601 timestamp */
  timestamp: string;
}

/**
 * Handoff record structure.
 */
export interface HandoffRecord {
  /** Target agent ID */
  targetAgentId: string;
  /** Handoff reason */
  reason: string;
  /** ISO8601 timestamp */
  timestamp: string;
}

/**
 * Agent execution context extending RuntimeContext with agent-specific features.
 */
export type AgentContext = RuntimeContext & {
  /** Agent identifier */
  agentId: string;
  /** Agent definition */
  definition: AgentDefinition;
  /** Inbox for incoming messages/directives */
  inbox: InboxMessage[];
  /**
   * Delivers a message to the agent's inbox.
   * @param message - Message to deliver (from, content, optional type)
   */
  deliver(message: { from: string; content: string; type?: string }): void;
  /**
   * Drains and returns all messages from the inbox, clearing it.
   * @returns Array of all messages that were in the inbox
   */
  drainInbox(): InboxMessage[];
  /**
   * Initiates a handoff to another agent.
   * Records the handoff locally for observation via getLastHandoff().
   * @param targetAgentId - Target agent ID
   * @param reason - Handoff reason
   */
  handoff(targetAgentId: string, reason: string): void;
  /**
   * Returns the last recorded handoff, if any.
   * @returns Last handoff record or undefined
   */
  getLastHandoff(): HandoffRecord | undefined;
};

/**
 * Configuration for creating an AgentContext.
 */
export interface CreateAgentContextConfig {
  /** Unique run identifier */
  runId: string;
  /** Agent identifier */
  agentId: string;
  /** Agent definition */
  definition: AgentDefinition;
  /** Optional task identifier */
  taskId?: string;
}

/**
 * Creates a new AgentContext with agent-specific extensions.
 *
 * @param config - Context creation configuration
 * @returns An AgentContext instance
 */
export function createAgentContext(config: CreateAgentContextConfig): AgentContext {
  const baseContext = createRuntimeContext({
    runId: config.runId,
    taskId: config.taskId,
    agentId: config.agentId,
  });

  const inbox: InboxMessage[] = [];
  let lastHandoff: HandoffRecord | undefined;

  // Extract abort method from baseContext (non-enumerable, not copied by spread)
  const abortFn = (baseContext as unknown as Record<string, unknown>).abort as ((reason?: unknown) => void) | undefined;

  const agentContext: AgentContext = {
    ...baseContext,
    agentId: config.agentId,
    definition: config.definition,
    inbox,
    deliver(message: { from: string; content: string; type?: string }): void {
      const newMessage: InboxMessage = {
        id: crypto.randomUUID(),
        from: message.from,
        content: message.content,
        type: message.type ?? 'message',
        timestamp: new Date().toISOString(),
      };
      inbox.push(newMessage);
    },
    drainInbox(): InboxMessage[] {
      const messages = [...inbox];
      inbox.length = 0;
      return messages;
    },
    handoff(targetAgentId: string, reason: string): void {
      lastHandoff = {
        targetAgentId,
        reason,
        timestamp: new Date().toISOString(),
      };
    },
    getLastHandoff(): HandoffRecord | undefined {
      return lastHandoff;
    },
  };

  // Attach abort method if it exists on baseContext
  if (abortFn) {
    Object.defineProperty(agentContext, 'abort', {
      value: abortFn,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  return agentContext;
}