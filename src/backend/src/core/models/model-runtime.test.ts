/**
 * Model Runtime Tests
 */

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, match } from 'node:assert/strict';
import type { StreamChunk, FinishReason, TokenUsage } from '@pacc/shared';
import { streamToComplete } from './model-runtime.js';

describe('model-runtime', () => {
  describe('streamToComplete', () => {
    it('assembles content from text-delta chunks', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Hello' },
        { type: 'text-delta', index: 0, text: ' ' },
        { type: 'text-delta', index: 0, text: 'World' },
        { type: 'block-end', index: 0, block: { kind: 'text', text: 'Hello World' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      strictEqual(response.content, 'Hello World');
      strictEqual(response.finishReason, 'stop');
    });

    it('assembles reasoning content from reasoning-delta chunks', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'Let me think...' },
        { type: 'reasoning-delta', index: 0, text: ' The answer is 42.' },
        { type: 'block-end', index: 0, block: { kind: 'reasoning', text: 'Let me think... The answer is 42.' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      strictEqual(response.reasoningContent, 'Let me think... The answer is 42.');
    });

    it('assembles tool calls from tool-call-delta chunks', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'tool-call', id: 'call_123', name: 'get_weather' },
        { type: 'tool-call-delta', index: 0, id: 'call_123', name: 'get_weather', argumentsDelta: '{"location":' },
        { type: 'tool-call-delta', index: 0, id: 'call_123', name: 'get_weather', argumentsDelta: '"San Francisco"}' },
        { type: 'block-end', index: 0, block: { kind: 'tool-call', id: 'call_123', name: 'get_weather', arguments: '{"location":"San Francisco"}' } },
        { type: 'finish', reason: { kind: 'tool_calls' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      ok(response.toolCalls);
      strictEqual(response.toolCalls!.length, 1);
      strictEqual(response.toolCalls![0].id, 'call_123');
      strictEqual(response.toolCalls![0].name, 'get_weather');
      strictEqual(response.toolCalls![0].arguments, '{"location":"San Francisco"}');
      strictEqual(response.finishReason, 'tool_calls');
    });

    it('handles multiple tool calls', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'tool-call', id: 'call_1', name: 'func_a' },
        { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'func_a', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { kind: 'tool-call', id: 'call_1', name: 'func_a', arguments: '{}' } },
        { type: 'block-start', index: 1, blockType: 'tool-call', id: 'call_2', name: 'func_b' },
        { type: 'tool-call-delta', index: 1, id: 'call_2', name: 'func_b', argumentsDelta: '{"x":1}' },
        { type: 'block-end', index: 1, block: { kind: 'tool-call', id: 'call_2', name: 'func_b', arguments: '{"x":1}' } },
        { type: 'finish', reason: { kind: 'tool_calls' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      ok(response.toolCalls);
      strictEqual(response.toolCalls!.length, 2);
      strictEqual(response.toolCalls![0].id, 'call_1');
      strictEqual(response.toolCalls![1].id, 'call_2');
    });

    it('extracts finish reason from finish chunk', async () => {
      const finishReasons: ('stop' | 'tool_calls' | 'max-tokens')[] = ['stop', 'tool_calls', 'max-tokens'];

      for (const reason of finishReasons) {
        const chunks: StreamChunk[] = [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: 'Done' },
          { type: 'block-end', index: 0, block: { kind: 'text', text: 'Done' } },
          { type: 'finish', reason: { kind: reason } },
        ];

        const stream = async function* () {
          for (const chunk of chunks) yield chunk;
        }();

        const response = await streamToComplete(stream);
        strictEqual(response.finishReason, reason);
      }
    });

    it('extracts error finish reason with message', async () => {
      const chunks: StreamChunk[] = [
        { type: 'finish', reason: { kind: 'error', message: 'boom', code: 'X' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);
      strictEqual(response.finishReason, 'error');
    });

    it('extracts usage from usage chunk', async () => {
      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 10,
      };

      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Response' },
        { type: 'block-end', index: 0, block: { kind: 'text', text: 'Response' } },
        { type: 'usage', usage },
        { type: 'finish', reason: { kind: 'stop' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      deepStrictEqual(response.usage, usage);
    });

    it('handles mixed content, reasoning, and tool calls', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'Thinking...' },
        { type: 'block-end', index: 0, block: { kind: 'reasoning', text: 'Thinking...' } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'Here is the answer: ' },
        { type: 'block-end', index: 1, block: { kind: 'text', text: 'Here is the answer: ' } },
        { type: 'block-start', index: 2, blockType: 'tool-call', id: 'call_1', name: 'calculate' },
        { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'calculate', argumentsDelta: '{"expr":"2+2"}' },
        { type: 'block-end', index: 2, block: { kind: 'tool-call', id: 'call_1', name: 'calculate', arguments: '{"expr":"2+2"}' } },
        { type: 'finish', reason: { kind: 'tool_calls' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      strictEqual(response.reasoningContent, 'Thinking...');
      strictEqual(response.content, 'Here is the answer: ');
      ok(response.toolCalls);
      strictEqual(response.toolCalls!.length, 1);
      strictEqual(response.toolCalls![0].name, 'calculate');
    });

    it('generates response ID when not provided', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Test' },
        { type: 'block-end', index: 0, block: { kind: 'text', text: 'Test' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      ok(response.id);
      match(response.id, /^resp_\d+_[a-z0-9]+$/);
    });

    it('defaults finishReason to stop when not provided', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Test' },
        { type: 'block-end', index: 0, block: { kind: 'text', text: 'Test' } },
        // No finish chunk
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      strictEqual(response.finishReason, 'stop');
    });
  });
});