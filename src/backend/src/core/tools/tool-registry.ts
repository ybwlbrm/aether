/**
 * ToolRegistry — Registry for Aether tools.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import type { z } from 'zod';
import type { ToolPolicyRule } from './tool-policy.js';
import type { ToolContext } from './tool-runtime.js';
import type { ToolResult } from './tool-result.js';
import { RuntimeError } from '../errors/index.js';

/**
 * Interface for an Aether tool.
 */
export interface AetherTool {
  /** Unique tool identifier */
  id: string;
  /** Human-readable tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Zod schema for input validation */
  inputSchema: z.ZodType<unknown>;
  /** Optional policy rule for this tool */
  policy?: ToolPolicyRule;
  /** Tool execution function */
  execute(input: unknown, context: ToolContext): Promise<ToolResult> | ToolResult;
}

/**
 * ToolRegistry — Manages tool registration and lookup.
 *
 * Does NOT depend on ToolPolicy at runtime for lookups.
 * Policy evaluation is handled by the executor.
 */
export class ToolRegistry {
  #tools: Map<string, AetherTool> = new Map();

  /**
   * Registers a tool.
   *
   * @param tool - Tool to register
   * @throws {RuntimeError} If a tool with the same name already exists (code: 'TOOL_EXISTS')
   */
  register(tool: AetherTool): void {
    if (this.#tools.has(tool.name)) {
      throw new RuntimeError(`Tool '${tool.name}' already registered`, {
        code: 'TOOL_EXISTS',
        context: { toolName: tool.name, toolId: tool.id },
        retryable: false,
      });
    }
    this.#tools.set(tool.name, tool);
  }

  /**
   * Unregisters a tool by name.
   *
   * @param name - Name of the tool to unregister
   * @returns true if tool was found and removed, false otherwise
   */
  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /**
   * Gets a tool by name.
   *
   * @param name - Name of the tool to retrieve
   * @returns The tool if found, undefined otherwise
   */
  get(name: string): AetherTool | undefined {
    return this.#tools.get(name);
  }

  /**
   * Lists all registered tools.
   *
   * @returns Array of all registered tools
   */
  list(): AetherTool[] {
    return Array.from(this.#tools.values());
  }

  /**
   * Gets all callable tool names.
   *
   * @returns Array of tool names
   */
  getCallableNames(): string[] {
    return Array.from(this.#tools.keys());
  }

  /**
   * Checks if a tool is registered.
   *
   * @param name - Name of the tool to check
   * @returns true if registered, false otherwise
   */
  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * Clears all registered tools.
   */
  clear(): void {
    this.#tools.clear();
  }

  /**
   * Returns the number of registered tools.
   */
  get size(): number {
    return this.#tools.size;
  }
}