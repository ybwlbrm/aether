/**
 * ToolExecutor unit tests.
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolPolicy } from './tool-policy.js';
import { ToolTimeoutManager } from './tool-timeout.js';
import { createToolContext } from './tool-runtime.js';
import { ToolError } from '../errors/index.js';
import { CancellationError, isCancellationError } from '../runtime/index.js';
import type { ToolContext } from './tool-runtime.js';
import type { ToolResult } from './tool-result.js';
import {
  successResult,
  errorResult,
  pendingApprovalResult,
  timeoutResult,
  cancelledResult,
} from './tool-result.js';

describe('tool-executor', () => {
  const createTestTool = (overrides: Partial<{
    name: string;
    inputSchema: z.ZodType<unknown>;
    execute: (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult;
  }> = {}) => ({
    id: 'test-1',
    name: overrides.name ?? 'test-tool',
    description: 'A test tool',
    inputSchema: overrides.inputSchema ?? z.object({ input: z.string() }),
    execute: overrides.execute ?? (async (_input: unknown, _context: ToolContext): Promise<ToolResult> => 
      successResult('test-tool', 'ok', 10)
    ),
  });

  const createContext = (overrides: Partial<ToolContext> = {}): ToolContext => 
    createToolContext({
      runId: 'run-123',
      policy: new ToolPolicy(),
      ...overrides,
    });

  describe('success path', () => {
    test('returns successResult with tool output', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool());
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('test-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'success');
      assert.equal(result.toolName, 'test-tool');
      assert.equal(result.output, 'ok');
      assert.ok(typeof result.durationMs === 'number');
      assert.ok(result.durationMs >= 0);
    });

    test('returns tool.execute result directly if it returns ToolResult', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        execute: async () => successResult('test-tool', { custom: 'data' }, 5),
      }));
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('test-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'success');
      assert.deepEqual(result.output, { custom: 'data' });
    });
  });

  describe('missing tool', () => {
    test('returns errorResult with TOOL_NOT_FOUND', async () => {
      const registry = new ToolRegistry();
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('non-existent', { input: 'hello' }, context);

      assert.equal(result.kind, 'error');
      assert.equal(result.toolName, 'non-existent');
      assert.equal(result.error.code, 'TOOL_NOT_FOUND');
      assert.ok(result.error.message.includes('not found'));
    });
  });

  describe('deny policy', () => {
    test('returns errorResult when policy denies', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({ name: 'denied-tool' }));
      const policy = new ToolPolicy([
        { pattern: 'denied-tool', action: 'deny' },
      ]);
      const executor = new ToolExecutor(registry, { policy });
      const context = createContext({ policy });

      const result = await executor.execute('denied-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'error');
      assert.equal(result.toolName, 'denied-tool');
      assert.equal(result.error.code, 'TOOL_DENIED');
    });
  });

  describe('require-approval policy', () => {
    test('returns pendingApprovalResult when policy requires approval', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({ name: 'approval-tool' }));
      const policy = new ToolPolicy([
        { pattern: 'approval-tool', action: 'require-approval' },
      ]);
      const executor = new ToolExecutor(registry, { policy });
      const context = createContext({ policy });

      const result = await executor.execute('approval-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'pending-approval');
      assert.equal(result.toolName, 'approval-tool');
      assert.ok(result.approvalId.startsWith('approval-tool:'));
    });
  });

  describe('invalid input', () => {
    test('returns errorResult with INVALID_INPUT when zod validation fails', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        inputSchema: z.object({ value: z.number().min(0) }),
      }));
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('test-tool', { value: -1 }, context);

      assert.equal(result.kind, 'error');
      assert.equal(result.toolName, 'test-tool');
      assert.equal(result.error.code, 'INVALID_INPUT');
      assert.ok(result.error.message.includes('Invalid input'));
    });

    test('returns errorResult for completely wrong input type', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        inputSchema: z.object({ required: z.string() }),
      }));
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('test-tool', 'not an object', context);

      assert.equal(result.kind, 'error');
      assert.equal(result.error.code, 'INVALID_INPUT');
    });
  });

  describe('timeout', () => {
    test('returns timeoutResult when tool exceeds timeout', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        name: 'slow-tool',
        execute: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return successResult('slow-tool', 'done', 100);
        },
      }));
      const executor = new ToolExecutor(registry, { defaultTimeoutMs: 5 });
      const context = createContext();

      const result = await executor.execute('slow-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'timeout');
      assert.equal(result.toolName, 'slow-tool');
    });
  });

  describe('cancellation', () => {
    test('returns cancelledResult when context.abortSignal aborts', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        name: 'cancellable-tool',
        execute: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return successResult('cancellable-tool', 'done', 100);
        },
      }));
      const executor = new ToolExecutor(registry);
      const controller = new AbortController();
      const context = createContext({ abortSignal: controller.signal });

      // Abort immediately
      controller.abort();

      const result = await executor.execute('cancellable-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'cancelled');
      assert.equal(result.toolName, 'cancellable-tool');
    });

    test('returns cancelledResult when tool throws CancellationError', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        name: 'throws-cancel',
        execute: async () => {
          throw new CancellationError('Cancelled by tool');
        },
      }));
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('throws-cancel', { input: 'hello' }, context);

      assert.equal(result.kind, 'cancelled');
      assert.equal(result.toolName, 'throws-cancel');
    });
  });

  describe('tool error handling', () => {
    test('preserves ToolError message and code', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        name: 'error-tool',
        execute: async () => {
          throw new ToolError('Custom error', {
            toolName: 'error-tool',
            code: 'CUSTOM_CODE',
            retryable: true,
          });
        },
      }));
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('error-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'error');
      assert.equal(result.toolName, 'error-tool');
      assert.equal(result.error.message, 'Custom error');
      assert.equal(result.error.code, 'CUSTOM_CODE');
    });

    test('wraps generic Error in errorResult', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        name: 'generic-error-tool',
        execute: async () => {
          throw new Error('Generic error');
        },
      }));
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('generic-error-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'error');
      assert.equal(result.toolName, 'generic-error-tool');
      assert.equal(result.error.message, 'Generic error');
      assert.equal(result.error.code, 'TOOL_ERROR');
    });

    test('wraps non-Error throwables', async () => {
      const registry = new ToolRegistry();
      registry.register(createTestTool({
        name: 'string-throw-tool',
        execute: async () => {
          throw 'string error';
        },
      }));
      const executor = new ToolExecutor(registry);
      const context = createContext();

      const result = await executor.execute('string-throw-tool', { input: 'hello' }, context);

      assert.equal(result.kind, 'error');
      assert.equal(result.error.message, 'string error');
      assert.equal(result.error.code, 'TOOL_ERROR');
    });
  });

  describe('ToolExecutor properties', () => {
    test('exposes registry, policy, and timeoutManager', () => {
      const registry = new ToolRegistry();
      const policy = new ToolPolicy();
      const executor = new ToolExecutor(registry, { policy, defaultTimeoutMs: 5000 });

      assert.equal(executor.registry, registry);
      assert.equal(executor.policy, policy);
      assert.ok(executor.timeoutManager instanceof ToolTimeoutManager);
    });
  });
});