/**
 * PolicyEngine tests — coverage:
 * - deny rule wins over granted capabilities
 * - allow rule grants when capability missing from context
 * - default allow with capability present
 * - default deny with capability absent
 * - wildcard matching (filesystem.*)
 * - duplicate rule id → RuntimeError RULE_EXISTS
 * - matchedRule reported
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, type PolicyRule } from './policy.js';
import { createCapabilitySet } from './capability.js';
import { RuntimeError } from '../errors/index.js';

function ctx(caps: string[]) {
  return { capabilities: createCapabilitySet(...(caps as any)) };
}

describe('PolicyEngine', () => {
  it('default allows when capability is granted in context', () => {
    const engine = defaultEngine();
    const decision = engine.evaluate('filesystem.read', ctx(['filesystem.read']));
    assert.equal(decision.allowed, true);
    assert.equal(decision.effect, 'default');
  });

  it('default denies when capability is absent from context', () => {
    const engine = defaultEngine();
    const decision = engine.evaluate('filesystem.write', ctx(['filesystem.read']));
    assert.equal(decision.allowed, false);
    assert.equal(decision.effect, 'default');
  });

  it('deny rule wins even when capability is granted', () => {
    const engine = new PolicyEngine([
      rule('r1', 'terminal.execute', 'deny'),
    ]);
    const decision = engine.evaluate('terminal.execute', ctx(['terminal.execute']));
    assert.equal(decision.allowed, false);
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.matchedRule?.id, 'r1');
  });

  it('allow rule grants capability not present in context', () => {
    const engine = new PolicyEngine([
      rule('r1', 'network.http', 'allow'),
    ]);
    const decision = engine.evaluate('network.http', ctx([]));
    assert.equal(decision.allowed, true);
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.matchedRule?.id, 'r1');
  });

  it('wildcard deny (filesystem.*) blocks any filesystem capability', () => {
    const engine = new PolicyEngine([
      rule('r1', 'filesystem.*', 'deny'),
    ]);
    assert.equal(engine.permits('filesystem.read', ctx(['filesystem.read'])), false);
    assert.equal(engine.permits('filesystem.delete', ctx(['filesystem.delete'])), false);
    // non-filesystem unaffected
    assert.equal(engine.permits('network.http', ctx(['network.http'])), true);
  });

  it('deny overrides allow regardless of rule order', () => {
    const engine = new PolicyEngine([
      rule('allow1', 'filesystem.write', 'allow'),
      rule('deny1', 'filesystem.write', 'deny'),
    ]);
    assert.equal(engine.permits('filesystem.write', ctx(['filesystem.write'])), false);
  });

  it('duplicate rule id throws RuntimeError RULE_EXISTS', () => {
    const engine = new PolicyEngine([rule('dup', 'network.http', 'allow')]);
    assert.throws(
      () => engine.addRule(rule('dup', 'network.http', 'deny')),
      (err: unknown) =>
        err instanceof RuntimeError && err.code === 'RULE_EXISTS',
    );
  });

  it('permits() convenience matches evaluate().allowed', () => {
    const engine = new PolicyEngine([rule('r1', 'browser.control', 'allow')]);
    assert.equal(engine.permits('browser.control', ctx([])), true);
    assert.equal(engine.permits('secrets.read', ctx([])), false);
  });

  it('listRules returns registered rules copy', () => {
    const engine = new PolicyEngine([rule('r1', 'network.http', 'allow')]);
    const listed = engine.listRules();
    assert.equal(listed.length, 1);
    listed.push(rule('r2', 'network.http', 'deny'));
    assert.equal(engine.listRules().length, 1, 'mutating returned array must not affect engine');
  });

  it('condition metadata is preserved on matched rule', () => {
    const engine = new PolicyEngine([
      { id: 'r1', capability: 'secrets.read', effect: 'allow', condition: { env: 'production' } },
    ]);
    const decision = engine.evaluate('secrets.read', ctx([]));
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.matchedRule?.condition, { env: 'production' });
  });
});

function defaultEngine(): PolicyEngine {
  return new PolicyEngine();
}

function rule(id: string, capability: PolicyRule['capability'], effect: 'allow' | 'deny'): PolicyRule {
  return { id, capability, effect };
}