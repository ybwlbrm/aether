/**
 * Model Registry Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, type ModelSpec } from './model-registry.js';

describe('model-registry', () => {
  const createSpec = (overrides: Partial<ModelSpec> = {}): ModelSpec => ({
    id: 'test-model',
    name: 'Test Model',
    capabilities: { text: true, vision: false, reasoning: false, toolCalling: false },
    contextWindow: 4096,
    maxOutputTokens: 2048,
    ...overrides,
  });

  describe('register', () => {
    it('registers a model for a provider', () => {
      const registry = new ModelRegistry();
      const spec = createSpec({ id: 'gpt-4', name: 'GPT-4', capabilities: { text: true, toolCalling: true } });

      registry.register('openai', spec);

      const retrieved = registry.get('openai', 'gpt-4');
      assert.deepStrictEqual(retrieved, spec);
    });

    it('overwrites existing model for same provider', () => {
      const registry = new ModelRegistry();
      const spec1 = createSpec({ id: 'model-1', name: 'Model 1' });
      const spec2 = createSpec({ id: 'model-1', name: 'Model 1 Updated', capabilities: { text: true, vision: true } });

      registry.register('provider', spec1);
      registry.register('provider', spec2);

      const retrieved = registry.get('provider', 'model-1');
      assert.deepStrictEqual(retrieved, spec2);
    });

    it('allows same model ID for different providers', () => {
      const registry = new ModelRegistry();
      const spec1 = createSpec({ id: 'model-1', name: 'OpenAI Model' });
      const spec2 = createSpec({ id: 'model-1', name: 'Anthropic Model', capabilities: { text: true, reasoning: true } });

      registry.register('openai', spec1);
      registry.register('anthropic', spec2);

      assert.deepStrictEqual(registry.get('openai', 'model-1'), spec1);
      assert.deepStrictEqual(registry.get('anthropic', 'model-1'), spec2);
    });
  });

  describe('unregister', () => {
    it('removes a registered model', () => {
      const registry = new ModelRegistry();
      const spec = createSpec({ id: 'model-1' });

      registry.register('provider', spec);
      registry.unregister('provider', 'model-1');

      assert.strictEqual(registry.get('provider', 'model-1'), undefined);
    });

    it('is no-op for non-existent model', () => {
      const registry = new ModelRegistry();

      // Should not throw
      registry.unregister('provider', 'non-existent');
      registry.unregister('non-existent-provider', 'model-1');
    });
  });

  describe('get', () => {
    it('returns undefined for non-existent model', () => {
      const registry = new ModelRegistry();

      assert.strictEqual(registry.get('provider', 'non-existent'), undefined);
      assert.strictEqual(registry.get('non-existent-provider', 'model-1'), undefined);
    });

    it('returns correct spec for registered model', () => {
      const registry = new ModelRegistry();
      const spec = createSpec({ id: 'gpt-4', capabilities: { text: true, toolCalling: true, vision: true } });

      registry.register('openai', spec);

      const retrieved = registry.get('openai', 'gpt-4');
      assert.ok(retrieved);
      assert.strictEqual(retrieved!.id, 'gpt-4');
      assert.strictEqual(retrieved!.capabilities.vision, true);
    });
  });

  describe('list', () => {
    it('returns empty array for empty registry', () => {
      const registry = new ModelRegistry();

      assert.deepStrictEqual(registry.list(), []);
    });

    it('returns all registered models with provider IDs', () => {
      const registry = new ModelRegistry();
      const spec1 = createSpec({ id: 'gpt-4', name: 'GPT-4' });
      const spec2 = createSpec({ id: 'claude-3', name: 'Claude 3' });
      const spec3 = createSpec({ id: 'llama-3', name: 'Llama 3' });

      registry.register('openai', spec1);
      registry.register('anthropic', spec2);
      registry.register('ollama', spec3);

      const list = registry.list();

      assert.strictEqual(list.length, 3);
      assert.ok(list.some((e) => e.providerId === 'openai' && e.model.id === 'gpt-4'));
      assert.ok(list.some((e) => e.providerId === 'anthropic' && e.model.id === 'claude-3'));
      assert.ok(list.some((e) => e.providerId === 'ollama' && e.model.id === 'llama-3'));
    });
  });

  describe('resolveByCapability', () => {
    it('returns empty array when no models have the capability', () => {
      const registry = new ModelRegistry();
      const spec = createSpec({ id: 'model-1', capabilities: { text: true } });

      registry.register('provider', spec);

      const result = registry.resolveByCapability('vision');
      assert.deepStrictEqual(result, []);
    });

    it('returns models with the specified capability', () => {
      const registry = new ModelRegistry();
      const spec1 = createSpec({ id: 'gpt-4', capabilities: { text: true, vision: true, toolCalling: true } });
      const spec2 = createSpec({ id: 'gpt-3.5', capabilities: { text: true, toolCalling: true } });
      const spec3 = createSpec({ id: 'claude-3', capabilities: { text: true, vision: true, reasoning: true } });

      registry.register('openai', spec1);
      registry.register('openai', spec2);
      registry.register('anthropic', spec3);

      const visionModels = registry.resolveByCapability('vision');
      assert.strictEqual(visionModels.length, 2);
      assert.ok(visionModels.some((m) => m.model.id === 'gpt-4'));
      assert.ok(visionModels.some((m) => m.model.id === 'claude-3'));

      const reasoningModels = registry.resolveByCapability('reasoning');
      assert.strictEqual(reasoningModels.length, 1);
      assert.strictEqual(reasoningModels[0].model.id, 'claude-3');

      const toolCallingModels = registry.resolveByCapability('toolCalling');
      assert.strictEqual(toolCallingModels.length, 2);
    });

    it('only returns models where capability is explicitly true', () => {
      const registry = new ModelRegistry();
      // Model with undefined capability (should not match)
      const spec1 = createSpec({ id: 'model-1', capabilities: { text: true } });
      // Model with explicit false (should not match)
      const spec2 = createSpec({ id: 'model-2', capabilities: { text: true, vision: false } });
      // Model with explicit true (should match)
      const spec3 = createSpec({ id: 'model-3', capabilities: { text: true, vision: true } });

      registry.register('provider', spec1);
      registry.register('provider', spec2);
      registry.register('provider', spec3);

      const visionModels = registry.resolveByCapability('vision');
      assert.strictEqual(visionModels.length, 1);
      assert.strictEqual(visionModels[0].model.id, 'model-3');
    });

    it('works with all capability keys', () => {
      const registry = new ModelRegistry();
      const capabilities: ModelSpec['capabilities'] = {
        text: true,
        vision: true,
        reasoning: true,
        toolCalling: true,
        imageGeneration: true,
        audio: true,
        video: true,
        structuredOutput: true,
      };
      const spec = createSpec({ id: 'full-model', capabilities });

      registry.register('provider', spec);

      for (const key of Object.keys(capabilities) as Array<keyof ModelSpec['capabilities']>) {
        const result = registry.resolveByCapability(key);
        assert.strictEqual(result.length, 1, `Capability ${key} should match`);
        assert.strictEqual(result[0].model.id, 'full-model');
      }
    });
  });
});