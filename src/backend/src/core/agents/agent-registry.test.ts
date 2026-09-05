/**
 * Agent Registry Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from './agent-registry.js';
import type { AgentDefinition } from './agent-definition.js';
import { DEFAULT_AGENT_LIMITS } from './agent-definition.js';

function createTestDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    type: 'conversation',
    description: 'A test agent',
    capabilities: ['chat'],
    systemPrompt: 'You are a helpful assistant.',
    modelPolicy: {},
    toolPolicy: {},
    memoryPolicy: {
      readScopes: ['user'],
      writeScopes: ['session'],
    },
    limits: DEFAULT_AGENT_LIMITS,
    ...overrides,
  };
}

describe('agent-registry', () => {
  describe('register', () => {
    it('should register a new agent definition', () => {
      const registry = new AgentRegistry();
      const def = createTestDefinition();

      registry.register(def);

      const retrieved = registry.get('test-agent');
      assert.deepStrictEqual(retrieved, def);
    });

    it('should throw AGENT_EXISTS on duplicate id', () => {
      const registry = new AgentRegistry();
      const def = createTestDefinition();

      registry.register(def);

      assert.throws(
        () => registry.register(def),
        (err: Error) => {
          assert.strictEqual(err.name, 'RuntimeError');
          assert.ok(err.message.includes('already exists'));
          return true;
        }
      );
    });
  });

  describe('unregister', () => {
    it('should return true and remove agent when id exists', () => {
      const registry = new AgentRegistry();
      const def = createTestDefinition();

      registry.register(def);
      const result = registry.unregister('test-agent');

      assert.strictEqual(result, true);
      assert.strictEqual(registry.get('test-agent'), undefined);
    });

    it('should return false when id does not exist', () => {
      const registry = new AgentRegistry();

      const result = registry.unregister('non-existent');

      assert.strictEqual(result, false);
    });
  });

  describe('get', () => {
    it('should return agent definition when id exists', () => {
      const registry = new AgentRegistry();
      const def = createTestDefinition();

      registry.register(def);

      const retrieved = registry.get('test-agent');

      assert.deepStrictEqual(retrieved, def);
    });

    it('should return undefined when id does not exist', () => {
      const registry = new AgentRegistry();

      const retrieved = registry.get('non-existent');

      assert.strictEqual(retrieved, undefined);
    });
  });

  describe('list', () => {
    it('should return empty array when no agents registered', () => {
      const registry = new AgentRegistry();

      const list = registry.list();

      assert.deepStrictEqual(list, []);
    });

    it('should return all registered agents', () => {
      const registry = new AgentRegistry();
      const def1 = createTestDefinition({ id: 'agent-1', name: 'Agent 1' });
      const def2 = createTestDefinition({ id: 'agent-2', name: 'Agent 2' });

      registry.register(def1);
      registry.register(def2);

      const list = registry.list();

      assert.strictEqual(list.length, 2);
      assert.ok(list.some((a) => a.id === 'agent-1'));
      assert.ok(list.some((a) => a.id === 'agent-2'));
    });
  });

  describe('update', () => {
    it('should update and return the modified agent definition', () => {
      const registry = new AgentRegistry();
      const def = createTestDefinition();

      registry.register(def);

      const updated = registry.update('test-agent', { name: 'Updated Name', description: 'Updated description' });

      assert.strictEqual(updated.name, 'Updated Name');
      assert.strictEqual(updated.description, 'Updated description');
      assert.strictEqual(updated.id, 'test-agent'); // id should not change
      assert.strictEqual(registry.get('test-agent')?.name, 'Updated Name');
    });

    it('should throw AGENT_NOT_FOUND when id does not exist', () => {
      const registry = new AgentRegistry();

      assert.throws(
        () => registry.update('non-existent', { name: 'New Name' }),
        (err: Error) => {
          assert.strictEqual(err.name, 'RuntimeError');
          assert.ok(err.message.includes('not found'));
          return true;
        }
      );
    });

    it('should preserve fields not in patch', () => {
      const registry = new AgentRegistry();
      const def = createTestDefinition({ name: 'Original', description: 'Original desc' });

      registry.register(def);

      const updated = registry.update('test-agent', { name: 'Updated' });

      assert.strictEqual(updated.name, 'Updated');
      assert.strictEqual(updated.description, 'Original desc');
      assert.strictEqual(updated.type, 'conversation');
    });
  });
});