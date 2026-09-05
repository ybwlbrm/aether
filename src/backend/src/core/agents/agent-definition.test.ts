/**
 * Agent Definition Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentLimits,
  ModelPolicy,
  ToolPolicy,
  MemoryPolicy,
  AgentDefinition,
  DEFAULT_AGENT_LIMITS,
} from './agent-definition.js';

describe('agent-definition', () => {
  describe('DEFAULT_AGENT_LIMITS', () => {
    it('should have correct default values', () => {
      assert.strictEqual(DEFAULT_AGENT_LIMITS.maxTurns, 50);
      assert.strictEqual(DEFAULT_AGENT_LIMITS.maxToolCalls, 200);
      assert.strictEqual(DEFAULT_AGENT_LIMITS.maxTimeMs, 30 * 60 * 1000);
      assert.strictEqual(DEFAULT_AGENT_LIMITS.maxTokens, 128000);
      assert.strictEqual(DEFAULT_AGENT_LIMITS.maxParallelTasks, 8);
    });
  });

  describe('AgentDefinition construction', () => {
    it('should be constructible with all required fields', () => {
      const definition: AgentDefinition = {
        id: 'test-agent',
        name: 'Test Agent',
        type: 'conversation',
        description: 'A test agent',
        capabilities: ['chat', 'tools'],
        systemPrompt: 'You are a helpful assistant.',
        modelPolicy: {
          provider: 'openai',
          model: 'gpt-4',
          capabilities: ['chat', 'tools'],
          temperature: 0.7,
          maxTokens: 4096,
        },
        toolPolicy: {
          allowedTools: ['read_file', 'write_file'],
          deniedTools: ['delete_file'],
          requiresApprovalTools: ['execute_command'],
        },
        memoryPolicy: {
          readScopes: ['user', 'session'],
          writeScopes: ['session'],
        },
        limits: DEFAULT_AGENT_LIMITS,
      };

      assert.strictEqual(definition.id, 'test-agent');
      assert.strictEqual(definition.name, 'Test Agent');
      assert.strictEqual(definition.type, 'conversation');
      assert.strictEqual(definition.capabilities.length, 2);
      assert.strictEqual(definition.modelPolicy.provider, 'openai');
      assert.strictEqual(definition.toolPolicy.allowedTools?.length, 2);
      assert.strictEqual(definition.memoryPolicy.readScopes.length, 2);
      assert.strictEqual(definition.limits.maxTurns, 50);
    });

    it('should allow optional modelPolicy fields', () => {
      const minimalModelPolicy: ModelPolicy = {};
      assert.deepStrictEqual(minimalModelPolicy, {});
    });

    it('should allow optional toolPolicy fields', () => {
      const minimalToolPolicy: ToolPolicy = {};
      assert.deepStrictEqual(minimalToolPolicy, {});
    });

    it('should require memoryPolicy readScopes and writeScopes', () => {
      const memoryPolicy: MemoryPolicy = {
        readScopes: ['user'],
        writeScopes: ['session'],
      };
      assert.strictEqual(memoryPolicy.readScopes[0], 'user');
      assert.strictEqual(memoryPolicy.writeScopes[0], 'session');
    });
  });
});