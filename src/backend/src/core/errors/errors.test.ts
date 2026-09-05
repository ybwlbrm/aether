/**
 * Errors Module Tests
 *
 * Tests for the core/errors module (P1-41..P1-44).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Import after build — tests run from dist/
const {
  RuntimeError,
  ModelError,
  ToolError,
  RetryError,
  RetryExhaustedError,
  isRetryable,
} = await import('./index.js');

describe('core/errors', () => {
  describe('RuntimeError', () => {
    it('JSON serialization round-trip preserves all fields', () => {
      const original = new RuntimeError('Something went wrong', {
        code: 'TEST_ERROR',
        cause: new Error('root cause'),
        context: { key: 'value', count: 42 },
        retryable: true,
      });

      const json = original.toJSON();
      const serialized = JSON.stringify(json);
      const parsed = JSON.parse(serialized);

      assert.equal(parsed.name, 'RuntimeError');
      assert.equal(parsed.message, 'Something went wrong');
      assert.equal(parsed.code, 'TEST_ERROR');
      assert.equal(parsed.retryable, true);
      assert.deepEqual(parsed.context, { key: 'value', count: 42 });
      assert.equal(parsed.cause, 'root cause');
      assert.ok(typeof parsed.stack === 'string');
    });

    it('cause chain preserved via error.cause option', () => {
      const rootCause = new Error('original failure');
      const wrapper = new RuntimeError('wrapped', {
        code: 'WRAPPED',
        cause: rootCause,
      });

      assert.equal(wrapper.cause, rootCause);
      assert.ok(wrapper.cause instanceof Error);
      assert.equal((wrapper.cause as Error).message, 'original failure');
    });

    it('cause can be non-Error values', () => {
      const err = new RuntimeError('failed', {
        code: 'NON_ERROR_CAUSE',
        cause: 'string cause',
      });

      assert.equal(err.cause, 'string cause');
      assert.equal(err.toJSON().cause, 'string cause');
    });

    it('isRuntimeError type guard works', () => {
      const err = new RuntimeError('test', { code: 'TEST' });
      assert.ok(RuntimeError.isRuntimeError(err));
      assert.ok(!RuntimeError.isRuntimeError(new Error('plain')));
      assert.ok(!RuntimeError.isRuntimeError(null));
      assert.ok(!RuntimeError.isRuntimeError({ message: 'obj' }));
    });

    it('defaults: retryable=false, empty context', () => {
      const err = new RuntimeError('minimal', { code: 'MINIMAL' });
      assert.equal(err.retryable, false);
      assert.equal(err.context, undefined);
      assert.equal(err.cause, undefined);
    });
  });

  describe('ModelError', () => {
    it('rate-limit (statusCode 429) => retryable=true', () => {
      const err = new ModelError('Rate limited', {
        provider: 'openai',
        model: 'gpt-4',
        statusCode: 429,
      });

      assert.equal(err.provider, 'openai');
      assert.equal(err.model, 'gpt-4');
      assert.equal(err.statusCode, 429);
      assert.equal(err.retryable, true);
      assert.equal(err.code, 'MODEL_ERROR');
    });

    it('rateLimitReset set => retryable=true', () => {
      const err = new ModelError('Rate limited', {
        provider: 'anthropic',
        rateLimitReset: Date.now() + 60000,
      });

      assert.ok(err.rateLimitReset != null);
      assert.equal(err.retryable, true);
    });

    it('5xx statusCode => retryable=true', () => {
      const err = new ModelError('Internal server error', {
        provider: 'ollama',
        statusCode: 503,
      });

      assert.equal(err.statusCode, 503);
      assert.equal(err.retryable, true);
    });

    it('4xx (non-429) => retryable=false by default', () => {
      const err = new ModelError('Bad request', {
        provider: 'openai',
        statusCode: 400,
      });

      assert.equal(err.statusCode, 400);
      assert.equal(err.retryable, false);
    });

    it('explicit retryable override works', () => {
      const err = new ModelError('Custom', {
        provider: 'test',
        statusCode: 400,
        retryable: true,
      });

      assert.equal(err.retryable, true);
    });

    it('toJSON includes provider/model/rateLimitReset/statusCode', () => {
      const err = new ModelError('Test', {
        provider: 'openai',
        model: 'gpt-4',
        statusCode: 429,
        rateLimitReset: 1234567890,
      });

      const json = err.toJSON();
      assert.equal(json.name, 'ModelError');
      assert.equal(json.provider, 'openai');
      assert.equal(json.model, 'gpt-4');
      assert.equal(json.statusCode, 429);
      assert.equal(json.rateLimitReset, 1234567890);
    });

    it('isModelError type guard works', () => {
      const err = new ModelError('test', { provider: 'test' });
      assert.ok(ModelError.isModelError(err));
      assert.ok(!ModelError.isModelError(new RuntimeError('x', { code: 'X' })));
    });
  });

  describe('ToolError', () => {
    it('carries toolName and exitCode', () => {
      const err = new ToolError('Script failed', {
        toolName: 'python-runner',
        input: { script: 'print(1/0)' },
        exitCode: 1,
      });

      assert.equal(err.toolName, 'python-runner');
      assert.deepEqual(err.input, { script: 'print(1/0)' });
      assert.equal(err.exitCode, 1);
      assert.equal(err.code, 'TOOL_ERROR');
      assert.equal(err.retryable, false);
    });

    it('toJSON includes toolName/input/exitCode', () => {
      const err = new ToolError('Failed', {
        toolName: 'my-tool',
        exitCode: 2,
      });

      const json = err.toJSON();
      assert.equal(json.name, 'ToolError');
      assert.equal(json.toolName, 'my-tool');
      assert.equal(json.exitCode, 2);
    });

    it('isToolError type guard works', () => {
      const err = new ToolError('test', { toolName: 'test' });
      assert.ok(ToolError.isToolError(err));
      assert.ok(!ToolError.isToolError(new RuntimeError('x', { code: 'X' })));
    });
  });

  describe('RetryError', () => {
    it('always retryable=true', () => {
      const err = new RetryError('Transient', {
        attempt: 1,
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.retryable, true);
      assert.equal(err.attempt, 1);
      assert.equal(err.maxAttempts, 3);
      assert.equal(err.backoffMs, 1000);
      assert.equal(err.code, 'RETRY_ERROR');
    });

    it('isExhausted() returns false before maxAttempts', () => {
      const err = new RetryError('Retry 1 of 3', {
        attempt: 1,
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.isExhausted(), false);
    });

    it('isExhausted() returns true at maxAttempts', () => {
      const err = new RetryError('Retry 3 of 3', {
        attempt: 3,
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.isExhausted(), true);
    });

    it('toJSON includes attempt/maxAttempts/backoffMs', () => {
      const err = new RetryError('Retry', {
        attempt: 2,
        maxAttempts: 5,
        backoffMs: 2000,
      });

      const json = err.toJSON();
      assert.equal(json.attempt, 2);
      assert.equal(json.maxAttempts, 5);
      assert.equal(json.backoffMs, 2000);
    });

    it('isRetryError type guard works', () => {
      const err = new RetryError('test', { attempt: 1, maxAttempts: 3, backoffMs: 100 });
      assert.ok(RetryError.isRetryError(err));
      assert.ok(!RetryError.isRetryError(new RuntimeError('x', { code: 'X' })));
    });
  });

  describe('RetryExhaustedError', () => {
    it('retryable=false (terminal)', () => {
      const err = new RetryExhaustedError('All retries failed', {
        maxAttempts: 3,
        backoffMs: 1000,
      });

      assert.equal(err.retryable, false);
      assert.equal(err.attempt, 3);
      assert.equal(err.maxAttempts, 3);
      assert.equal(err.name, 'RetryExhaustedError');
    });

    it('toJSON includes exhausted: true', () => {
      const err = new RetryExhaustedError('Done', {
        maxAttempts: 3,
        backoffMs: 1000,
      });

      const json = err.toJSON();
      assert.equal(json.exhausted, true);
      assert.equal(json.retryable, false);
    });

    it('isRetryExhaustedError type guard works', () => {
      const err = new RetryExhaustedError('test', { maxAttempts: 3, backoffMs: 100 });
      assert.ok(RetryExhaustedError.isRetryExhaustedError(err));
      assert.ok(!RetryExhaustedError.isRetryExhaustedError(new RetryError('x', { attempt: 1, maxAttempts: 3, backoffMs: 100 })));
    });
  });

  describe('isRetryable classification matrix', () => {
    it('RuntimeError with retryable=true => true', () => {
      const err = new RuntimeError('retry me', { code: 'RETRY', retryable: true });
      assert.equal(isRetryable(err), true);
    });

    it('RuntimeError with retryable=false => false', () => {
      const err = new RuntimeError('no retry', { code: 'NO_RETRY', retryable: false });
      assert.equal(isRetryable(err), false);
    });

    it('ModelError rate-limit (429) => true', () => {
      const err = new ModelError('rate limited', { provider: 'test', statusCode: 429 });
      assert.equal(isRetryable(err), true);
    });

    it('ModelError 5xx => true', () => {
      const err = new ModelError('server error', { provider: 'test', statusCode: 500 });
      assert.equal(isRetryable(err), true);
    });

    it('ModelError 4xx (non-429) => false', () => {
      const err = new ModelError('bad request', { provider: 'test', statusCode: 400 });
      assert.equal(isRetryable(err), false);
    });

    it('ModelError with rateLimitReset => true', () => {
      const err = new ModelError('rate limited', { provider: 'test', rateLimitReset: Date.now() + 1000 });
      assert.equal(isRetryable(err), true);
    });

    it('ToolError => false (never retryable by default)', () => {
      const err = new ToolError('tool failed', { toolName: 'test' });
      assert.equal(isRetryable(err), false);
    });

    it('RetryError => true', () => {
      const err = new RetryError('retry', { attempt: 1, maxAttempts: 3, backoffMs: 100 });
      assert.equal(isRetryable(err), true);
    });

    it('RetryExhaustedError => false (terminal)', () => {
      const err = new RetryExhaustedError('exhausted', { maxAttempts: 3, backoffMs: 100 });
      assert.equal(isRetryable(err), false);
    });

    it('plain Error => false', () => {
      assert.equal(isRetryable(new Error('plain')), false);
    });

    it('null/undefined => false', () => {
      assert.equal(isRetryable(null), false);
      assert.equal(isRetryable(undefined), false);
    });

    it('random object => false', () => {
      assert.equal(isRetryable({ message: 'oops' }), false);
    });
  });
});