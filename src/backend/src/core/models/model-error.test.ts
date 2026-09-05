/**
 * Model Error Factory Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateLimitError,
  authError,
  contextWindowError,
  providerUnavailableError,
} from './model-error.js';
import { ModelError } from '../errors/index.js';

describe('model-error factories', () => {
  describe('rateLimitError', () => {
    it('creates ModelError with RATE_LIMIT code', () => {
      const error = rateLimitError('openai', Date.now() + 60000, 'gpt-4');

      assert.ok(error instanceof ModelError);
      assert.strictEqual(error.code, 'RATE_LIMIT');
    });

    it('sets retryable to true', () => {
      const error = rateLimitError('openai', Date.now() + 60000);

      assert.strictEqual(error.retryable, true);
    });

    it('sets provider and model', () => {
      const error = rateLimitError('anthropic', Date.now() + 60000, 'claude-3');

      assert.strictEqual(error.provider, 'anthropic');
      assert.strictEqual(error.model, 'claude-3');
    });

    it('sets rateLimitReset and statusCode 429', () => {
      const resetAt = Date.now() + 60000;
      const error = rateLimitError('openai', resetAt);

      assert.strictEqual(error.rateLimitReset, resetAt);
      assert.strictEqual(error.statusCode, 429);
    });

    it('includes message', () => {
      const error = rateLimitError('openai', Date.now() + 60000);

      assert.strictEqual(error.message, 'Rate limit exceeded');
    });
  });

  describe('authError', () => {
    it('creates ModelError with AUTH code', () => {
      const error = authError('openai', 'gpt-4');

      assert.ok(error instanceof ModelError);
      assert.strictEqual(error.code, 'AUTH');
    });

    it('sets retryable to false', () => {
      const error = authError('openai');

      assert.strictEqual(error.retryable, false);
    });

    it('sets provider and model', () => {
      const error = authError('anthropic', 'claude-3');

      assert.strictEqual(error.provider, 'anthropic');
      assert.strictEqual(error.model, 'claude-3');
    });

    it('sets statusCode 401', () => {
      const error = authError('openai');

      assert.strictEqual(error.statusCode, 401);
    });

    it('includes message', () => {
      const error = authError('openai');

      assert.strictEqual(error.message, 'Authentication failed');
    });
  });

  describe('contextWindowError', () => {
    it('creates ModelError with CONTEXT_WINDOW code', () => {
      const error = contextWindowError('openai', 'gpt-4');

      assert.ok(error instanceof ModelError);
      assert.strictEqual(error.code, 'CONTEXT_WINDOW');
    });

    it('sets retryable to false', () => {
      const error = contextWindowError('openai', 'gpt-4');

      assert.strictEqual(error.retryable, false);
    });

    it('sets provider and model', () => {
      const error = contextWindowError('anthropic', 'claude-3');

      assert.strictEqual(error.provider, 'anthropic');
      assert.strictEqual(error.model, 'claude-3');
    });

    it('sets statusCode 400', () => {
      const error = contextWindowError('openai', 'gpt-4');

      assert.strictEqual(error.statusCode, 400);
    });

    it('includes message', () => {
      const error = contextWindowError('openai', 'gpt-4');

      assert.strictEqual(error.message, 'Context window exceeded');
    });
  });

  describe('providerUnavailableError', () => {
    it('creates ModelError with PROVIDER_UNAVAILABLE code', () => {
      const error = providerUnavailableError('openai', 'gpt-4');

      assert.ok(error instanceof ModelError);
      assert.strictEqual(error.code, 'PROVIDER_UNAVAILABLE');
    });

    it('sets retryable to true', () => {
      const error = providerUnavailableError('openai');

      assert.strictEqual(error.retryable, true);
    });

    it('sets provider and model', () => {
      const error = providerUnavailableError('anthropic', 'claude-3');

      assert.strictEqual(error.provider, 'anthropic');
      assert.strictEqual(error.model, 'claude-3');
    });

    it('sets statusCode 503', () => {
      const error = providerUnavailableError('openai');

      assert.strictEqual(error.statusCode, 503);
    });

    it('includes message', () => {
      const error = providerUnavailableError('openai');

      assert.strictEqual(error.message, 'Provider unavailable');
    });
  });

  describe('all factories', () => {
    it('return ModelError instances with proper prototype chain', () => {
      const errors = [
        rateLimitError('openai', Date.now() + 60000),
        authError('openai'),
        contextWindowError('openai', 'gpt-4'),
        providerUnavailableError('openai'),
      ];

      for (const error of errors) {
        assert.ok(error instanceof ModelError);
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, 'ModelError');
      }
    });

    it('have toJSON method with provider/model fields', () => {
      const error = rateLimitError('openai', Date.now() + 60000, 'gpt-4');
      const json = error.toJSON();

      assert.strictEqual(json.name, 'ModelError');
      assert.strictEqual(json.provider, 'openai');
      assert.strictEqual(json.model, 'gpt-4');
      assert.strictEqual(json.code, 'RATE_LIMIT');
      assert.strictEqual(json.retryable, true);
    });
  });
});