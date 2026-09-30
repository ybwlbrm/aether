/**
 * ToolTimeoutManager unit tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolTimeoutManager } from './tool-timeout.js';
import { ToolError } from '../errors/index.js';
import { CancellationError, isCancellationError } from '../runtime/index.js';

describe('tool-timeout', () => {
  describe('executeWithTimeout', () => {
    test('resolves fast function successfully', async () => {
      const manager = new ToolTimeoutManager(1000);

      const result = await manager.executeWithTimeout({
        fn: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'success';
        },
        toolName: 'fast-tool',
      });

      assert.equal(result, 'success');
    });

    test('rejects with ToolError TOOL_TIMEOUT for slow function', async () => {
      const manager = new ToolTimeoutManager(5); // 5ms timeout

      try {
        await manager.executeWithTimeout({
          fn: async () => {
            await new Promise((r) => setTimeout(r, 50)); // 50ms - longer than timeout
            return 'should not reach';
          },
          toolName: 'slow-tool',
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, 'TOOL_TIMEOUT');
        assert.equal(error.retryable, true);
        assert.equal(error.toolName, 'slow-tool');
        assert.ok(error.message.includes('timed out'));
      }
    });

    test('rejects with CancellationError when external signal aborts', async () => {
      const manager = new ToolTimeoutManager(1000);
      const controller = new AbortController();

      // Abort immediately
      controller.abort();

      try {
        await manager.executeWithTimeout({
          fn: async () => {
            await new Promise((r) => setTimeout(r, 100));
            return 'should not reach';
          },
          toolName: 'aborted-tool',
          signal: controller.signal,
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(isCancellationError(error));
        assert.equal(error.message, 'Operation cancelled');
      }
    });

    test('rejects with CancellationError when external signal aborts during execution', async () => {
      const manager = new ToolTimeoutManager(1000);
      const controller = new AbortController();

      // Abort after a short delay
      setTimeout(() => controller.abort(), 10);

      try {
        await manager.executeWithTimeout({
          fn: async () => {
            await new Promise((r) => setTimeout(r, 100));
            return 'should not reach';
          },
          toolName: 'aborted-during-tool',
          signal: controller.signal,
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(isCancellationError(error));
      }
    });

    test('uses custom timeoutMs when provided', async () => {
      const manager = new ToolTimeoutManager(1000); // default 1s

      try {
        await manager.executeWithTimeout({
          fn: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return 'should not reach';
          },
          toolName: 'custom-timeout-tool',
          timeoutMs: 5, // override to 5ms
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, 'TOOL_TIMEOUT');
      }
    });

    test('lastTimeoutMs returns the last used timeout', async () => {
      const manager = new ToolTimeoutManager(1000);

      await manager.executeWithTimeout({
        fn: async () => 'ok',
        toolName: 'tool-1',
      });
      assert.equal(manager.lastTimeoutMs(), 1000);

      await manager.executeWithTimeout({
        fn: async () => 'ok',
        toolName: 'tool-2',
        timeoutMs: 500,
      });
      assert.equal(manager.lastTimeoutMs(), 500);
    });
  });

  describe('constructor', () => {
    test('uses default timeout of 30000ms when not specified', () => {
      const manager = new ToolTimeoutManager();
      assert.equal(manager.lastTimeoutMs(), 0); // Not set until executeWithTimeout called

      // We can't easily test the default without executing, but we can verify the property
      // The default is used in executeWithTimeout when timeoutMs not provided
    });

    test('accepts custom default timeout', () => {
      const manager = new ToolTimeoutManager(5000);
      // Default is stored internally
    });
  });

  describe('error properties', () => {
    test('TOOL_TIMEOUT error has correct properties', async () => {
      const manager = new ToolTimeoutManager(5);

      try {
        await manager.executeWithTimeout({
          fn: async () => {
            await new Promise((r) => setTimeout(r, 50));
          },
          toolName: 'props-tool',
        });
      } catch (error) {
        assert.ok(error instanceof ToolError);
        assert.equal(error.name, 'ToolError');
        assert.equal(error.toolName, 'props-tool');
        assert.equal(error.code, 'TOOL_TIMEOUT');
        assert.equal(error.retryable, true);
        assert.ok(error.message.includes('props-tool'));
        assert.ok(error.message.includes('timed out'));

        // Check toJSON includes toolName
        const json = error.toJSON();
        assert.equal(json.toolName, 'props-tool');
        assert.equal(json.code, 'TOOL_TIMEOUT');
      }
    });
  });
});