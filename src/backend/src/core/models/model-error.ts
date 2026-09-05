/**
 * Model Error Factories
 *
 * Convenience constructors for common ModelError scenarios.
 * Reuses the existing ModelError class from core/errors — does NOT redefine it.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import { ModelError } from '../errors/index.js';

/**
 * Creates a rate limit error (retryable).
 *
 * @param provider - Provider identifier (e.g., 'openai', 'anthropic')
 * @param resetAt - Unix timestamp (ms) when rate limit resets
 * @param model - Optional model identifier
 * @returns ModelError with code 'RATE_LIMIT' and retryable=true
 */
export function rateLimitError(
  provider: string,
  resetAt: number,
  model?: string
): ModelError {
  return new ModelError('Rate limit exceeded', {
    provider,
    model,
    rateLimitReset: resetAt,
    statusCode: 429,
    code: 'RATE_LIMIT',
    retryable: true,
  });
}

/**
 * Creates an authentication error (non-retryable).
 *
 * @param provider - Provider identifier
 * @param model - Optional model identifier
 * @returns ModelError with code 'AUTH' and retryable=false
 */
export function authError(provider: string, model?: string): ModelError {
  return new ModelError('Authentication failed', {
    provider,
    model,
    statusCode: 401,
    code: 'AUTH',
    retryable: false,
  });
}

/**
 * Creates a context window exceeded error (non-retryable).
 *
 * @param provider - Provider identifier
 * @param model - Model identifier
 * @returns ModelError with code 'CONTEXT_WINDOW' and retryable=false
 */
export function contextWindowError(provider: string, model: string): ModelError {
  return new ModelError('Context window exceeded', {
    provider,
    model,
    statusCode: 400,
    code: 'CONTEXT_WINDOW',
    retryable: false,
  });
}

/**
 * Creates a provider unavailable error (retryable).
 *
 * @param provider - Provider identifier
 * @param model - Optional model identifier
 * @returns ModelError with code 'PROVIDER_UNAVAILABLE' and retryable=true
 */
export function providerUnavailableError(provider: string, model?: string): ModelError {
  return new ModelError('Provider unavailable', {
    provider,
    model,
    statusCode: 503,
    code: 'PROVIDER_UNAVAILABLE',
    retryable: true,
  });
}