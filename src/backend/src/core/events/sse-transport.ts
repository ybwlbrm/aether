/**
 * Aether 2.0 — SSE Transport Adapter (P3-05)
 *
 * Formats AgentEvent (v2) into Server-Sent Events and writes them to a
 * generic writable target. The transport is decoupled from Fastify: it
 * accepts any object exposing write(chunk)/end() (e.g. `reply.raw`, a
 * WritableStream, or an in-memory buffer for tests).
 *
 * SSE wire format per event:
 *   event: <type>
 *   data: <JSON payload>
 *   id: <seq>
 *   (blank line)
 *
 * The `id:` field carries the run-level seq so clients can resume via
 * Last-Event-ID (reconnection support lands with P3-06).
 */

import type { AgentEvent } from '@pacc/shared';

/** Minimal writable target — anything Fastify's reply.raw or Node Writable conforms to */
export interface SseWritableTarget {
  write(chunk: string | Uint8Array): boolean | void;
  end?(): void;
}

/** Transport contract — core stays agnostic to the underlying channel */
export interface EventTransport {
  /** Send one formatted event */
  send(event: AgentEvent): void;
  /** Flush and close the transport */
  close(): void;
}

/** Format a single AgentEvent as an SSE frame (no trailing blank line handling — caller appends) */
export function formatSseEvent(event: AgentEvent): string {
  const payload = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${payload}\nid: ${event.seq}\n\n`;
}

/**
 * SSE transport writing formatted frames to a generic target.
 *
 * @example
 * ```ts
 * const transport = new SseTransport(reply.raw);
 * transport.send({ type: 'run.started', ... } as AgentEvent);
 * transport.close();
 * ```
 */
export class SseTransport implements EventTransport {
  private readonly target: SseWritableTarget;
  private closed = false;

  constructor(target: SseWritableTarget) {
    this.target = target;
  }

  /** Write one event as an SSE frame. No-op after close. */
  send(event: AgentEvent): void {
    if (this.closed) return;
    try {
      this.target.write(formatSseEvent(event));
    } catch {
      // Client likely disconnected — swallow and mark closed
      this.closed = true;
    }
  }

  /** End the underlying stream. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.target.end?.();
  }

  /** Whether the transport has been closed */
  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * In-memory transport that buffers formatted frames — primarily for tests
 * and for wiring into the event projector pipeline without a real socket.
 */
export class InMemorySseTransport extends SseTransport {
  private readonly frames: string[] = [];
  private readonly rawEvents: AgentEvent[] = [];

  constructor() {
    super({
      write: (chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        this.frames.push(text);
        return true;
      },
    });
  }

  /** Capture raw events for assertions (overrides send to also record the event object) */
  override send(event: AgentEvent): void {
    this.rawEvents.push(event);
    super.send(event);
  }

  /** All formatted SSE frames received */
  framesList(): string[] {
    return [...this.frames];
  }

  /** All raw AgentEvent objects received */
  events(): AgentEvent[] {
    return [...this.rawEvents];
  }
}