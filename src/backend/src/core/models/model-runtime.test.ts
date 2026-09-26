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

    it('B4: 无 id tool-call block-start + delta + block-end 累积为单个调用', async () => {
      // Given
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 7, blockType: 'tool-call', name: 'legacy_tool' },
        { type: 'tool-call-delta', index: 7, name: 'legacy_tool', argumentsDelta: '{"value":' },
        { type: 'tool-call-delta', index: 7, name: 'legacy_tool', argumentsDelta: '42}' },
        {
          type: 'block-end',
          index: 7,
          block: { kind: 'tool-call', id: '', name: 'legacy_tool', arguments: '{"value":42}' },
        },
        { type: 'finish', reason: { kind: 'tool_calls' } },
      ]
      const stream = async function* () {
        for (const chunk of chunks) yield chunk
      }()

      // When
      const response = await streamToComplete(stream)

      // Then
      deepStrictEqual(response.toolCalls, [{
        id: 'call_idx_7',
        name: 'legacy_tool',
        arguments: '{"value":42}',
      }])
    })

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

     it('keeps interleaved parallel tool-call deltas associated by block index', async () => {
       // Given
       const chunks: StreamChunk[] = [
         { type: 'block-start', index: 0, blockType: 'tool-call', id: 'call_a', name: 'func_a' },
         { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'func_a', argumentsDelta: 'A12' },
         { type: 'block-start', index: 1, blockType: 'tool-call', id: 'call_b', name: 'func_b' },
         { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'func_a', argumentsDelta: 'B12' },
         { type: 'block-end', index: 0, block: { kind: 'tool-call', id: 'call_a', name: 'func_a', arguments: 'A12' } },
         { type: 'block-end', index: 1, block: { kind: 'tool-call', id: 'call_b', name: 'func_b', arguments: 'B12' } },
         { type: 'finish', reason: { kind: 'tool_calls' } },
       ];

       const stream = async function* () {
         for (const chunk of chunks) yield chunk;
       }();

       // When
       const response = await streamToComplete(stream);

       // Then
       strictEqual(response.toolCalls?.length, 2);
       deepStrictEqual(response.toolCalls?.map((call) => [call.id, call.arguments]), [
         ['call_a', 'A12B12'],
         ['call_b', ''],
       ]);
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

    it('§17: EOF 无 finish chunk 不得伪装成 stop — 必须标记 STREAM_INTERRUPTED/UNKNOWN_TERMINATION', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Partial output' },
        { type: 'block-end', index: 0, block: { kind: 'text', text: 'Partial output' } },
        // 流被截断：无 finish chunk（网络中断/Provider 异常关闭）
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);

      strictEqual(
        response.finishReason,
        'error',
        'EOF 无 finish 必须标记为 error（STREAM_INTERRUPTED），禁止伪装成正常 stop',
      );
    });

    it('§17: finish chunk 明确为 stop 时才返回 stop', async () => {
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Complete' },
        { type: 'block-end', index: 0, block: { kind: 'text', text: 'Complete' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];

      const stream = async function* () {
        for (const chunk of chunks) yield chunk;
      }();

      const response = await streamToComplete(stream);
      strictEqual(response.finishReason, 'stop');
    });
  });
});