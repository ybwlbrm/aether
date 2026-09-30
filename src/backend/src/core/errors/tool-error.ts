/**
 * ToolError — Error class for tool execution failures.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError, RuntimeErrorOptions } from './runtime-error.js';

export interface ToolErrorOptions extends Omit<RuntimeErrorOptions, 'code'> {
  /** Name of the tool that failed */
  toolName: string;
  /** Input that was passed to the tool (for debugging) */
  input?: unknown;
  /** Process exit code, if the tool ran as a subprocess */
  exitCode?: number;
  /** Override the default error code */
  code?: string;
}

/**
 * Error raised when a tool execution fails.
 *
 * @example
 * ```ts
 * throw new ToolError('Python script exited with code 1', {
 *   toolName: 'python-runner',
 *   input: { script: 'print(1/0)' },
 *   exitCode: 1,
 * });
 * ```
 */
export class ToolError extends RuntimeError {
  public readonly toolName: string;
  public readonly input?: unknown;
  public readonly exitCode?: number;

  constructor(message: string, options: ToolErrorOptions) {
    super(message, {
      code: options.code ?? 'TOOL_ERROR',
      cause: options.cause,
      context: options.context,
      retryable: options.retryable ?? false,
    });

    this.name = 'ToolError';
    this.toolName = options.toolName;
    this.input = options.input;
    this.exitCode = options.exitCode;

    Object.setPrototypeOf(this, ToolError.prototype);
  }

  /**
   * Returns a plain, JSON-serializable object representation.
   */
  override toJSON() {
    const base = super.toJSON();
    return {
      ...base,
      name: this.name,
      toolName: this.toolName,
      input: this.input,
      exitCode: this.exitCode,
    };
  }

  /**
   * Type guard to check if a value is a ToolError.
   */
  static isToolError(value: unknown): value is ToolError {
    return value instanceof ToolError;
  }
}