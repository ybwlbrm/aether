/**
 * Tool Runtime Bridge — Aether 2.0 Phase 6 migration seam
 *
 * Registers the LEGACY builtin tools (lib/tool-registry.ts allBuiltinTools,
 * OpenAI function-calling schema format) into the NEW core ToolRegistry as
 * AetherTool entries. Each AetherTool.execute() delegates to the legacy
 * executeTool() so existing tool logic stays untouched (Adapter pattern,
 * §2.1 不推倒重来) — the core registry becomes the lookup surface while the
 * old dispatch remains the implementation behind it.
 *
 * Pure TypeScript — no Fastify/SSE/React imports.
 */

import { z } from 'zod';
import {
  ToolRegistry,
  type AetherTool,
  type ToolContext,
  type ToolResult,
  successResult,
  errorResult,
} from '../core/tools/index.js';
import { allBuiltinTools } from './tool-registry.js';
import { executeTool } from './tool-executor.js';

/** Shape of a legacy builtin tool entry (OpenAI function-calling) */
interface LegacyToolEntry {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Execution options the legacy executeTool needs — provided by the caller */
export interface LegacyExecuteOptions {
  mcpTools: unknown[];
  getMcpServers: () => unknown[];
  allowedDirs: string[];
  permissionLevel: number;
  defaultDir: string;
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * Build a core AetherTool from a legacy tool entry. inputSchema is derived
 * from the legacy JSON-schema parameters via a permissive Zod passthrough.
 */
export function buildAetherTool(entry: LegacyToolEntry): AetherTool {
  const fn = entry.function;
  const schema = buildZodFromJsonSchema(fn.parameters);
  return {
    id: fn.name,
    name: fn.name,
    description: fn.description ?? '',
    inputSchema: schema,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const start = Date.now();
      try {
        const opts: LegacyExecuteOptions = {
          mcpTools: (context.metadata?.mcpTools as unknown[]) ?? [],
          getMcpServers: (context.metadata?.getMcpServers as () => unknown[]) ?? (() => []),
          allowedDirs: (context.metadata?.allowedDirs as string[]) ?? [],
          permissionLevel: (context.metadata?.permissionLevel as number) ?? 0,
          defaultDir: (context.metadata?.defaultDir as string) ?? '',
          sessionId: context.taskId,
          signal: context.abortSignal,
        };
        const result = await executeTool(fn.name, input as never, opts as never);
        const durationMs = Date.now() - start;
        // Legacy convention: errors surface either as `error` field or as a
        // `result` text prefixed with "错误:" (the executor does not throw).
        const isError =
          result.error !== undefined ||
          (typeof result.result === 'string' && result.result.startsWith('错误:'));
        if (isError) {
          const message = result.error ?? result.result;
          return errorResult(fn.name, { message }, durationMs);
        }
        return successResult(fn.name, result.result, durationMs);
      } catch (err) {
        return errorResult(
          fn.name,
          { message: err instanceof Error ? err.message : String(err) },
          Date.now() - start,
        );
      }
    },
  };
}

/**
 * Register all legacy builtin tools into a core ToolRegistry.
 * Returns the number of tools registered.
 */
export function registerLegacyTools(registry: ToolRegistry): number {
  for (const entry of allBuiltinTools as LegacyToolEntry[]) {
    registry.register(buildAetherTool(entry));
  }
  return (allBuiltinTools as LegacyToolEntry[]).length;
}

/** Convenience: build a fresh core ToolRegistry populated with legacy tools. */
export function buildRegistryFromLegacyTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registerLegacyTools(registry);
  return registry;
}

/**
 * Build a permissive Zod schema from a JSON-schema `parameters` object.
 * Falls back to z.record(z.unknown()) when parameters are missing/unsupported.
 */
export function buildZodFromJsonSchema(
  parameters?: Record<string, unknown>,
): z.ZodType<unknown> {
  if (!parameters || typeof parameters !== 'object') {
    return z.record(z.unknown());
  }
  const props = (parameters as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== 'object') {
    return z.record(z.unknown());
  }
  // Build a loose object schema from declared properties, allowing extras.
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const [key, prop] of Object.entries(props as Record<string, Record<string, unknown>>)) {
    shape[key] = buildZodFromProperty(prop);
  }
  return z.object(shape).passthrough() as z.ZodType<unknown>;
}

/** Map a single JSON-schema property to a loose Zod type */
function buildZodFromProperty(prop: Record<string, unknown>): z.ZodType<unknown> {
  const t = prop.type;
  switch (t) {
    case 'string':
      return z.string() as z.ZodType<unknown>;
    case 'integer':
    case 'number':
      return z.number() as z.ZodType<unknown>;
    case 'boolean':
      return z.boolean() as z.ZodType<unknown>;
    case 'array':
      return z.array(z.unknown()) as z.ZodType<unknown>;
    case 'object':
      return z.record(z.unknown()) as z.ZodType<unknown>;
    default:
      return z.unknown();
  }
}