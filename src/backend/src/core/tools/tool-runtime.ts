/**
 * ToolRuntime — Tool execution context and runtime.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import type { CapabilitySet } from '../permissions/index.js';
import type { ToolPolicy } from './tool-policy.js';
import type { ToolResult } from './tool-result.js';
import { Runtime, type RuntimeEvent } from '../runtime/index.js';

/**
 * Tool execution context.
 */
export interface ToolContext {
  /** Unique identifier for this runtime execution */
  runId: string;
  /** Optional task identifier */
  taskId?: string;
  /** Optional agent identifier */
  agentId?: string;
  /** Optional workspace identifier */
  workspaceId?: string;
  /** Granted capabilities for this context */
  permissions: CapabilitySet;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Policy for tool execution control */
  policy: ToolPolicy;
  /** Optional logger */
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  /** Optional memory interface */
  memory?: {
    remember?(entry: { type: string; content: string; scope?: string }): Promise<void>;
    recall?(query: unknown): Promise<unknown[]>;
  };
  /** Optional artifacts interface */
  artifacts?: {
    create?(input: unknown): Promise<{ id: string }>;
  };
  /**
   * Arbitrary structured extensions carried through tool execution
   * (e.g. legacy session config for the adapter layer). Transport-agnostic.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a ToolContext.
 */
export interface CreateToolContextOptions {
  /** Unique identifier for this runtime execution (required) */
  runId: string;
  /** Optional task identifier */
  taskId?: string;
  /** Optional agent identifier */
  agentId?: string;
  /** Optional workspace identifier */
  workspaceId?: string;
  /** Policy for tool execution control (required) */
  policy: ToolPolicy;
  /** Optional granted capabilities */
  permissions?: CapabilitySet;
  /** Optional abort signal */
  abortSignal?: AbortSignal;
  /** Optional logger */
  logger?: ToolContext['logger'];
  /** Optional memory interface */
  memory?: ToolContext['memory'];
  /** Optional artifacts interface */
  artifacts?: ToolContext['artifacts'];
}

/**
 * Creates a new ToolContext with defaults.
 *
 * @param options - Context creation options
 * @returns A ToolContext instance
 */
export function createToolContext(options: CreateToolContextOptions): ToolContext {
  const {
    runId,
    taskId,
    agentId,
    workspaceId,
    policy,
    permissions,
    abortSignal,
    logger,
    memory,
    artifacts,
  } = options;

  return {
    runId,
    taskId,
    agentId,
    workspaceId,
    permissions: permissions ?? (new Set() as CapabilitySet),
    abortSignal,
    policy,
    logger,
    memory,
    artifacts,
  };
}

/**
 * ToolRuntime — Extends Runtime with tool execution capabilities.
 *
 * Emits v2-style tool events: 'tool.completed' and 'tool.error'
 * with payloads matching the AgentEvent protocol.
 */
export class ToolRuntime extends Runtime {
  #seq = 0;
  #sessionId: string;
  #runId: string;
  #agentId?: string;

  constructor(
    name: string,
    sessionId: string,
    runId: string,
    agentId?: string
  ) {
    super(name);
    this.#sessionId = sessionId;
    this.#runId = runId;
    this.#agentId = agentId;
  }

  /**
   * Generates the next sequence number.
   */
  #nextSeq(): number {
    return ++this.#seq;
  }

  /**
   * Creates a base event envelope.
   */
  #createBaseEvent(type: string): Omit<RuntimeEvent, 'payload'> {
    return {
      type,
      timestamp: Date.now(),
      runtimeName: this.name,
    };
  }

  /**
   * Emits a tool.completed event (v2 format).
   */
  emitToolCompleted(payload: {
    toolName: string;
    toolInput: string;
    toolOutput: string;
    status: 'completed';
    inputDetail?: unknown;
    outputDetail?: unknown;
    parentEventId?: string;
  }): void {
    const event: RuntimeEvent = {
      ...this.#createBaseEvent('tool.completed'),
      payload: {
        ...payload,
        eventId: crypto.randomUUID(),
        sessionId: this.#sessionId,
        runId: this.#runId,
        agentId: this.#agentId,
        timestamp: new Date().toISOString(),
        seq: this.#nextSeq(),
        version: 2,
      },
    };
    this.emit(event);
  }

  /**
   * Emits a tool.error event (v2 format).
   */
  emitToolError(payload: {
    toolName: string;
    toolInput: string;
    status: 'error';
    error: { message: string; code?: string };
    inputDetail?: unknown;
    parentEventId?: string;
  }): void {
    const event: RuntimeEvent = {
      ...this.#createBaseEvent('tool.error'),
      payload: {
        ...payload,
        eventId: crypto.randomUUID(),
        sessionId: this.#sessionId,
        runId: this.#runId,
        agentId: this.#agentId,
        timestamp: new Date().toISOString(),
        seq: this.#nextSeq(),
        version: 2,
      },
    };
    this.emit(event);
  }

  /**
   * Emits a tool.started event (v2 format).
   */
  emitToolStarted(payload: {
    toolName: string;
    toolInput: string;
    status: 'started';
    inputDetail?: unknown;
  }): void {
    const event: RuntimeEvent = {
      ...this.#createBaseEvent('tool.started'),
      payload: {
        ...payload,
        eventId: crypto.randomUUID(),
        sessionId: this.#sessionId,
        runId: this.#runId,
        agentId: this.#agentId,
        timestamp: new Date().toISOString(),
        seq: this.#nextSeq(),
        version: 2,
      },
    };
    this.emit(event);
  }

  /**
   * Emits a tool.progress event (v2 format).
   */
  emitToolProgress(payload: {
    toolName: string;
    toolInput: string;
    status: 'running';
    inputDetail?: unknown;
    outputDetail?: unknown;
  }): void {
    const event: RuntimeEvent = {
      ...this.#createBaseEvent('tool.progress'),
      payload: {
        ...payload,
        eventId: crypto.randomUUID(),
        sessionId: this.#sessionId,
        runId: this.#runId,
        agentId: this.#agentId,
        timestamp: new Date().toISOString(),
        seq: this.#nextSeq(),
        version: 2,
      },
    };
    this.emit(event);
  }

  /**
   * Emits a tool.retry event (v2 format).
   */
  emitToolRetry(payload: {
    toolName: string;
    toolInput: string;
    status: 'retry';
    inputDetail?: unknown;
    error?: { message: string; code?: string };
  }): void {
    const event: RuntimeEvent = {
      ...this.#createBaseEvent('tool.retry'),
      payload: {
        ...payload,
        eventId: crypto.randomUUID(),
        sessionId: this.#sessionId,
        runId: this.#runId,
        agentId: this.#agentId,
        timestamp: new Date().toISOString(),
        seq: this.#nextSeq(),
        version: 2,
      },
    };
    this.emit(event);
  }

  /**
   * Abstract method implementations (no-op for tool runtime).
   */
  protected override async onStart(): Promise<void> {
    // ToolRuntime doesn't need custom startup logic
  }

  protected override async onStop(): Promise<void> {
    // ToolRuntime doesn't need custom shutdown logic
  }
}