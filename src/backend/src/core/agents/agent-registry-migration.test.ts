/**
 * AgentRegistryMigration tests (Phase 5 — legacy AGENTS[] → core AgentRegistry)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCoreDefinition,
  registerLegacyAgents,
  buildRegistryFromLegacy,
  type LegacyAgentDef,
} from './agent-registry-migration.js';
import { AgentRegistry, DEFAULT_AGENT_LIMITS } from './index.js';

function legacyAgent(overrides: Partial<LegacyAgentDef> = {}): LegacyAgentDef {
  return {
    id: 'sisyphus',
    name: 'Sisyphus',
    description: 'Orchestrator agent',
    systemPrompt: 'You are Sisyphus, the orchestrator.',
    capabilities: ['orchestration', 'planning'],
    ...overrides,
  };
}

describe('core/agents/agent-registry-migration', () => {
  it('buildCoreDefinition maps a legacy agent into the core shape', () => {
    const def = buildCoreDefinition(legacyAgent({ model: 'gpt-4o' }));

    assert.equal(def.id, 'sisyphus');
    assert.equal(def.name, 'Sisyphus');
    assert.equal(def.description, 'Orchestrator agent');
    assert.equal(def.systemPrompt, 'You are Sisyphus, the orchestrator.');
    assert.deepEqual(def.capabilities, ['orchestration', 'planning']);
    // model flows into modelPolicy
    assert.deepEqual(def.modelPolicy, { model: 'gpt-4o' });
    // defaults applied
    assert.deepEqual(def.memoryPolicy, { readScopes: ['user'], writeScopes: ['session'] });
    assert.deepEqual(def.toolPolicy, {});
    assert.equal(def.limits.maxTurns, DEFAULT_AGENT_LIMITS.maxTurns);
    assert.equal(def.limits.maxTimeMs, DEFAULT_AGENT_LIMITS.maxTimeMs);
  });

  it('buildCoreDefinition leaves modelPolicy empty when no model given', () => {
    const def = buildCoreDefinition(legacyAgent());
    assert.deepEqual(def.modelPolicy, {});
  });

  it('inferType classifies known agent ids into roles', () => {
    assert.equal(buildCoreDefinition(legacyAgent({ id: 'oracle' })).type, 'reasoner');
    assert.equal(buildCoreDefinition(legacyAgent({ id: 'hephaestus' })).type, 'coder');
    assert.equal(buildCoreDefinition(legacyAgent({ id: 'prometheus' })).type, 'planner');
    assert.equal(buildCoreDefinition(legacyAgent({ id: 'atlas' })).type, 'architect');
    assert.equal(buildCoreDefinition(legacyAgent({ id: 'sisyphus' })).type, 'conversation');
  });

  it('registerLegacyAgents registers every agent and returns count', () => {
    const registry = new AgentRegistry();
    const agents = [
      legacyAgent({ id: 'sisyphus' }),
      legacyAgent({ id: 'oracle', model: 'claude-3' }),
      legacyAgent({ id: 'librarian' }),
    ];
    const count = registerLegacyAgents(registry, agents);

    assert.equal(count, 3);
    assert.equal(registry.list().length, 3);
    assert.ok(registry.get('sisyphus'));
    assert.ok(registry.get('oracle'));
    assert.equal(registry.get('oracle')!.modelPolicy.model, 'claude-3');
  });

  it('registerLegacyAgents throws on duplicate ids (registry contract)', () => {
    const registry = new AgentRegistry();
    const agents = [
      legacyAgent({ id: 'dup' }),
      legacyAgent({ id: 'dup' }),
    ];
    assert.throws(() => registerLegacyAgents(registry, agents), /AGENT_EXISTS|already/i);
  });

  it('buildRegistryFromLegacy creates a pre-populated registry', () => {
    const registry = buildRegistryFromLegacy([
      legacyAgent({ id: 'sisyphus' }),
      legacyAgent({ id: 'oracle' }),
      legacyAgent({ id: 'explore' }),
      legacyAgent({ id: 'hephaestus' }),
      legacyAgent({ id: 'metis' }),
      legacyAgent({ id: 'momus' }),
      legacyAgent({ id: 'atlas' }),
      legacyAgent({ id: 'prometheus' }),
      legacyAgent({ id: 'multimodal-looker' }),
      legacyAgent({ id: 'sisyphus-junior' }),
    ]);

    assert.equal(registry.list().length, 10);
    // All 11 legacy agents are representable (10 distinct here)
    assert.equal(registry.get('sisyphus-junior')!.type, 'worker');
    assert.equal(registry.get('multimodal-looker')!.type, 'multimodal');
  });
});