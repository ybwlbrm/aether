/**
 * Agent Runtime
 *
 * Base runtime implementation for agents, extending the core Runtime with agent-specific behavior.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { Runtime, type RuntimeEvent, type RuntimeEventListener } from '../runtime/index.js';
import { RuntimeError } from '../errors/index.js';
import type { AgentDefinition } from './agent-definition.js';
import type { AgentContext } from './agent-context.js';
import type { AgentEvent, BaseEvent } from '@pacc/shared';

/**
 * Extended event type that includes both RuntimeEvent and BaseEvent fields.
 */
type RuntimeExtEvent = RuntimeEvent & Partial<BaseEvent>;

/**
 * Event delivered to agent listeners — the v2 BaseEvent shape (string timestamp).
 */
type AgentListenerEvent = BaseEvent & { payload?: unknown };

/**
 * AgentRuntime extends the core Runtime with agent-specific lifecycle and task execution.
 */
export class AgentRuntime extends Runtime {
  #definition: AgentDefinition;
  #context: AgentContext;
  #seq: number = 0;
  #agentListeners: Set<RuntimeEventListener> = new Set();

  /**
   * Creates a new AgentRuntime.
   *
   * @param definition - Agent definition
   * @param context - Agent execution context
   * @param name - Optional runtime name (defaults to agent ID)
   */
  constructor(definition: AgentDefinition, context: AgentContext, name?: string) {
    super(name ?? definition.id);
    this.#definition = definition;
    this.#context = context;
  }

  /**
   * Gets the agent definition.
   */
  get definition(): AgentDefinition {
    return this.#definition;
  }

  /**
   * Gets the agent context.
   */
  get context(): AgentContext {
    return this.#context;
  }

  /**
   * Called when the runtime is starting.
   * Emits agent.started event.
   */
  protected override async onStart(): Promise<void> {
    this.emitAgentEvent('agent.started', { status: 'running' });
  }

  /**
   * Called when the runtime is stopping.
   * Emits agent.completed event.
   */
  protected override async onStop(): Promise<void> {
    this.emitAgentEvent('agent.completed', { status: 'completed' });
  }

  /**
   * Executes a task with the given input.
   *
   * @param input - Task input data
   * @returns Task result
   * @throws {RuntimeError} If agent is not running (code: 'AGENT_NOT_STARTED')
   */
  async runTask(input: Record<string, unknown>): Promise<unknown> {
    if (!this.isRunning) {
      throw new RuntimeError('Agent not started', {
        code: 'AGENT_NOT_STARTED',
        context: { agentId: this.#definition.id, state: this.state },
        retryable: false,
      });
    }

    // Emit status: running
    this.emitAgentEvent('agent.status', { status: 'running' });

    try {
      const result = await this.execute(input);

      // Emit completion
      this.emitAgentEvent('agent.completed', { status: 'completed' });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Emit failure
      this.emitAgentEvent('agent.failed', {
        status: 'error',
        content: message,
        error: { message },
      });

      throw error;
    }
  }

  /**
   * Core task execution logic.
   * Override in subclasses to implement custom behavior.
   *
   * @param input - Task input data
   * @returns Task result
   */
  protected async execute(input: Record<string, unknown>): Promise<unknown> {
    // Default implementation: echo the input
    return { received: input };
  }

  /**
   * Sends a directive to the agent's inbox.
   *
   * @param content - Directive content
   */
  sendDirective(content: string): void {
    this.#context.deliver({
      from: 'system',
      content,
      type: 'directive',
    });

    // Also emit inbox directive event
    this.emitAgentEvent('agent.inbox.directive', { directive: content });
  }

  /**
   * Registers an event listener.
   * Listeners registered here receive BOTH:
   * - base Runtime lifecycle events (runtime:starting/started/...) via the base emitter, and
   * - agent events (v2 BaseEvent-shaped: string timestamp + eventId/sessionId/runId/agentId/seq/version)
   *   emitted by emitAgentEvent.
   * Returns an unsubscribe function.
   */
  override onEvent(listener: RuntimeEventListener): () => void {
    // Register with the base Runtime emitter (lifecycle events).
    const unregisterBase = super.onEvent(listener);
    // Also register with agent listeners so emitAgentEvent delivers v2-shaped events.
    this.#agentListeners.add(listener);
    return () => {
      this.#agentListeners.delete(listener);
      unregisterBase();
    };
  }

  /**
   * Emits an agent event with proper BaseEvent fields to agent listeners.
   *
   * @param type - Event type
   * @param payload - Event payload
   */
  private emitAgentEvent(
    type: AgentEvent['type'],
    payload: AgentEventPayloadForType<typeof type>
  ): void {
    const event: AgentListenerEvent = {
      eventId: crypto.randomUUID(),
      sessionId: this.#context.runId,
      runId: this.#context.runId,
      taskId: this.#context.taskId,
      agentId: this.#context.agentId,
      timestamp: new Date().toISOString(),
      seq: this.#seq++,
      type,
      version: 2,
      payload,
    };

    // Emit to agent listeners with full BaseEvent fields (v2-shaped event,
    // delivered as a RuntimeEvent-typed payload for listener compatibility).
    for (const listener of this.#agentListeners) {
      try {
        listener(event as unknown as RuntimeEvent);
      } catch {
        // Listener errors are swallowed to not break emission
      }
    }
  }
}

/**
 * Type helper to extract payload type for a given event type.
 * This is a simplified version - in practice we'd use the full discriminated union.
 */
type AgentEventPayloadForType<T extends AgentEvent['type']> =
  T extends 'agent.started' ? { status: 'running' } :
  T extends 'agent.status' ? { status: AgentEvent['payload'] extends { status: infer S } ? S : never } :
  T extends 'agent.completed' ? { status: 'completed' } :
  T extends 'agent.failed' ? { status: 'error'; content: string; error: { message: string } } :
  T extends 'agent.inbox.directive' ? { directive: string } :
  Record<string, unknown>;