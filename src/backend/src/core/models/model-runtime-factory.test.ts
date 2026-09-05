/**
 * ModelRuntimeFactory tests (Phase 4 — legacy provider config → core ModelRuntime)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelRuntime,
  registerProviderModels,
  buildAndRegister,
  type LegacyProviderConfig,
} from './model-runtime-factory.js';
import { ModelRegistry } from './model-registry.js';
import { OpenAICompatibleAdapter } from './provider-adapter.js';

const provider: LegacyProviderConfig = {
  id: 'openai',
  name: 'OpenAI',
  type: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  defaultModel: 'gpt-4',
  models: ['gpt-4', 'gpt-4o', 'gpt-4-turbo'],
  capabilities: ['text', 'vision', 'tool_calling'],
};

describe('core/models/model-runtime-factory', () => {
  it('buildModelRuntime returns a ModelRuntime backed by OpenAICompatibleAdapter', () => {
    const runtime = buildModelRuntime(provider);
    assert.ok(runtime instanceof OpenAICompatibleAdapter);
    assert.equal(typeof runtime.complete, 'function');
    assert.equal(typeof runtime.streamMessages, 'function');
  });

  it('adapter carries the provider id and enables HTTP transport', () => {
    const runtime = buildModelRuntime(provider) as unknown as OpenAICompatibleAdapter;
    assert.equal(runtime.providerId, 'openai');
  });

  it('registerProviderModels registers every model with mapped capabilities', () => {
    const registry = new ModelRegistry();
    const count = registerProviderModels(registry, provider);
    assert.equal(count, 3);

    const gpt4 = registry.get('openai', 'gpt-4');
    assert.ok(gpt4, 'gpt-4 should be registered');
    assert.equal(gpt4!.id, 'gpt-4');
    assert.equal(gpt4!.capabilities.text, true);
    assert.equal(gpt4!.capabilities.vision, true);
    assert.equal(gpt4!.capabilities.toolCalling, true);

    const list = registry.list();
    assert.equal(list.length, 3);
  });

  it('registerProviderModels maps known capability names and ignores unknown', () => {
    const registry = new ModelRegistry();
    registerProviderModels(registry, { ...provider, capabilities: ['text', 'bogus_capability'] });
    const spec = registry.get('openai', 'gpt-4');
    assert.equal(spec!.capabilities.text, true);
    assert.equal(spec!.capabilities.reasoning, undefined);
  });

  it('buildAndRegister both builds a runtime and registers models', () => {
    const registry = new ModelRegistry();
    const runtime = buildAndRegister(registry, provider);
    assert.ok(runtime instanceof OpenAICompatibleAdapter);
    assert.equal(registry.list().length, 3);
    assert.ok(registry.get('openai', 'gpt-4o'));
  });

  it('empty models array registers nothing', () => {
    const registry = new ModelRegistry();
    const count = registerProviderModels(registry, { ...provider, models: [] });
    assert.equal(count, 0);
    assert.equal(registry.list().length, 0);
  });
});