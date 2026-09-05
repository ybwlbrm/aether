/**
 * ToolRegistry unit tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolRegistry, AetherTool } from './tool-registry.js';
import { RuntimeError } from '../errors/index.js';
import type { ToolContext } from './tool-runtime.js';
import type { ToolResult } from './tool-result.js';

describe('tool-registry', () => {
  const createTestTool = (overrides: Partial<AetherTool> = {}): AetherTool => ({
    id: 'test-1',
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: z.object({ input: z.string() }),
    execute: async (_input: unknown, _context: ToolContext): Promise<ToolResult> => ({
      kind: 'success',
      toolName: 'test-tool',
      output: 'ok',
      durationMs: 10,
    }),
    ...overrides,
  });

  describe('register', () => {
    test('registers a tool successfully', () => {
      const registry = new ToolRegistry();
      const tool = createTestTool();

      registry.register(tool);

      assert.equal(registry.has('test-tool'), true);
      assert.equal(registry.size, 1);
    });

    test('throws RuntimeError with TOOL_EXISTS on duplicate name', () => {
      const registry = new ToolRegistry();
      const tool1 = createTestTool({ id: 'test-1', name: 'duplicate' });
      const tool2 = createTestTool({ id: 'test-2', name: 'duplicate' });

      registry.register(tool1);

      assert.throws(
        () => registry.register(tool2),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal((err as RuntimeError).code, 'TOOL_EXISTS');
          return true;
        }
      );
    });

    test('allows tools with same id but different names', () => {
      const registry = new ToolRegistry();
      const tool1 = createTestTool({ id: 'same-id', name: 'tool-a' });
      const tool2 = createTestTool({ id: 'same-id', name: 'tool-b' });

      registry.register(tool1);
      registry.register(tool2);

      assert.equal(registry.size, 2);
    });
  });

  describe('unregister', () => {
    test('removes existing tool and returns true', () => {
      const registry = new ToolRegistry();
      const tool = createTestTool();

      registry.register(tool);
      const result = registry.unregister('test-tool');

      assert.equal(result, true);
      assert.equal(registry.has('test-tool'), false);
      assert.equal(registry.size, 0);
    });

    test('returns false for non-existent tool', () => {
      const registry = new ToolRegistry();
      const result = registry.unregister('non-existent');

      assert.equal(result, false);
    });
  });

  describe('get', () => {
    test('returns tool for existing name', () => {
      const registry = new ToolRegistry();
      const tool = createTestTool();

      registry.register(tool);
      const retrieved = registry.get('test-tool');

      assert.ok(retrieved);
      assert.equal(retrieved?.name, 'test-tool');
      assert.equal(retrieved?.id, 'test-1');
    });

    test('returns undefined for non-existent name', () => {
      const registry = new ToolRegistry();
      const retrieved = registry.get('non-existent');

      assert.equal(retrieved, undefined);
    });
  });

  describe('list', () => {
    test('returns all registered tools', () => {
      const registry = new ToolRegistry();
      const tool1 = createTestTool({ id: '1', name: 'tool-a' });
      const tool2 = createTestTool({ id: '2', name: 'tool-b' });

      registry.register(tool1);
      registry.register(tool2);

      const tools = registry.list();

      assert.equal(tools.length, 2);
      assert.equal(tools[0].name, 'tool-a');
      assert.equal(tools[1].name, 'tool-b');
    });

    test('returns empty array when no tools registered', () => {
      const registry = new ToolRegistry();
      const tools = registry.list();

      assert.equal(tools.length, 0);
    });
  });

  describe('getCallableNames', () => {
    test('returns array of tool names', () => {
      const registry = new ToolRegistry();
      const tool1 = createTestTool({ id: '1', name: 'tool-a' });
      const tool2 = createTestTool({ id: '2', name: 'tool-b' });

      registry.register(tool1);
      registry.register(tool2);

      const names = registry.getCallableNames();

      assert.deepEqual(names.sort(), ['tool-a', 'tool-b']);
    });
  });

  describe('has', () => {
    test('returns true for registered tool', () => {
      const registry = new ToolRegistry();
      const tool = createTestTool();

      registry.register(tool);

      assert.equal(registry.has('test-tool'), true);
    });

    test('returns false for non-existent tool', () => {
      const registry = new ToolRegistry();

      assert.equal(registry.has('non-existent'), false);
    });
  });

  describe('clear', () => {
    test('removes all tools', () => {
      const registry = new ToolRegistry();
      const tool1 = createTestTool({ id: '1', name: 'tool-a' });
      const tool2 = createTestTool({ id: '2', name: 'tool-b' });

      registry.register(tool1);
      registry.register(tool2);
      registry.clear();

      assert.equal(registry.size, 0);
      assert.equal(registry.has('tool-a'), false);
      assert.equal(registry.has('tool-b'), false);
    });
  });

  describe('inputSchema zod schema constructible', () => {
    test('accepts various zod schema types', () => {
      const registry = new ToolRegistry();

      const toolWithObject = createTestTool({
        name: 'object-tool',
        inputSchema: z.object({ a: z.string(), b: z.number() }),
      });
      const toolWithArray = createTestTool({
        name: 'array-tool',
        inputSchema: z.array(z.string()),
      });
      const toolWithPrimitive = createTestTool({
        name: 'primitive-tool',
        inputSchema: z.string(),
      });
      const toolWithUnion = createTestTool({
        name: 'union-tool',
        inputSchema: z.union([z.string(), z.number()]),
      });

      registry.register(toolWithObject);
      registry.register(toolWithArray);
      registry.register(toolWithPrimitive);
      registry.register(toolWithUnion);

      assert.equal(registry.size, 4);
    });

    test('inputSchema can validate input', () => {
      const registry = new ToolRegistry();
      const tool = createTestTool({
        name: 'validate-tool',
        inputSchema: z.object({ value: z.number().min(0) }),
      });

      registry.register(tool);
      const retrieved = registry.get('validate-tool');

      assert.ok(retrieved);
      const result = retrieved!.inputSchema.safeParse({ value: 5 });
      assert.equal(result.success, true);

      const failResult = retrieved!.inputSchema.safeParse({ value: -1 });
      assert.equal(failResult.success, false);
    });
  });
});