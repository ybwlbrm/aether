/**
 * AgentRuntimeBridge tests (Phase 5 — legacy AGENTS[] → core AgentRegistry)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  legacyAgentsAsDefs,
  buildCoreAgentRegistry,
  resolveAgent,
  legacyAgentIds,
} from './agent-runtime-bridge.js';
import { AGENTS } from '../modules/agents/agent-definitions.js';

describe('lib/agent-runtime-bridge', () => {
  it('legacyAgentsAsDefs preserves all legacy agents and their fields', () => {
    const defs = legacyAgentsAsDefs();
    assert.equal(defs.length, AGENTS.length);
    assert.ok(defs.length >= 11, 'all 11 legacy agents should be present');

    // Spot-check the orchestrator
    const sisyphus = defs.find((d) => d.id === 'sisyphus');
    assert.ok(sisyphus, 'sisyphus should be present');
    assert.equal(sisyphus!.name, 'Sisyphus');
    assert.equal(typeof sisyphus!.systemPrompt, 'string');
    assert.ok(sisyphus!.systemPrompt.length > 0);
  });

  it('buildCoreAgentRegistry registers every legacy agent', () => {
    const registry = buildCoreAgentRegistry();
    assert.equal(registry.list().length, AGENTS.length);

    for (const agent of AGENTS) {
      const def = registry.get(agent.id);
      assert.ok(def, `agent ${agent.id} should be registered`);
      assert.equal(def!.name, agent.name);
      assert.equal(def!.systemPrompt, agent.systemPrompt);
    }
  });

  it('resolveAgent returns the core definition for known ids', () => {
    const registry = buildCoreAgentRegistry();
    const oracle = resolveAgent(registry, 'oracle');
    assert.ok(oracle, 'oracle should resolve');
    assert.equal(oracle!.name, 'Oracle');
    assert.equal(oracle!.type, 'reasoner');
  });

  it('resolveAgent returns undefined for unknown ids', () => {
    const registry = buildCoreAgentRegistry();
    const missing = resolveAgent(registry, 'not-an-agent');
    assert.equal(missing, undefined);
  });

  it('legacyAgentIds lists all 11 ids', () => {
    const ids = legacyAgentIds();
    assert.equal(ids.length, AGENTS.length);
    const expected = [
      'sisyphus', 'oracle', 'librarian', 'explore', 'hephaestus',
      'metis', 'momus', 'atlas', 'prometheus', 'multimodal-looker', 'sisyphus-junior',
    ];
    for (const id of expected) {
      assert.ok(ids.includes(id), `should include ${id}`);
    }
  });
});