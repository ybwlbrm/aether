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

  // ── P0-06：approval 效果（PolicyEngine 唯一裁决者三态：deny/approval/allow）──

  it('approval rule requires human approval (allowed=false, effect=approval)', () => {
    const engine = new PolicyEngine([
      rule('apr1', 'tool.write_file', 'approval'),
    ]);
    const decision = engine.evaluate('tool.write_file', ctx(['tool.write_file']));
    assert.equal(decision.allowed, false, 'approval 效果下不允许直接执行');
    assert.equal(decision.effect, 'approval');
    assert.equal(decision.matchedRule?.id, 'apr1');
  });

  it('approval rule yields to explicit deny (deny wins over approval)', () => {
    const engine = new PolicyEngine([
      rule('deny1', 'tool.delete_file', 'deny'),
      rule('apr1', 'tool.*', 'approval'),
    ]);
    const decision = engine.evaluate('tool.delete_file', ctx(['tool.delete_file']));
    assert.equal(decision.allowed, false);
    assert.equal(decision.effect, 'deny', 'deny 优先级高于 approval');
    assert.equal(decision.matchedRule?.id, 'deny1');
  });

  it('wildcard approval (tool.*) applies to any tool', () => {
    const engine = new PolicyEngine([
      rule('aprAll', 'tool.*', 'approval'),
    ]);
    const decision = engine.evaluate('tool.execute_command', ctx(['tool.execute_command']));
    assert.equal(decision.effect, 'approval');
    assert.equal(decision.allowed, false);
  });

  it('non-approval tools pass through when no rule matches', () => {
    const engine = new PolicyEngine([
      rule('apr1', 'tool.write_file', 'approval'),
    ]);
    // read_file 未命中 approval 规则 → 有 capability 则放行
    const decision = engine.evaluate('tool.read_file', ctx(['tool.read_file']));
    assert.equal(decision.allowed, true);
    assert.equal(decision.effect, 'default');
  });
});

function defaultEngine(): PolicyEngine {
  return new PolicyEngine();
}

function rule(id: string, capability: PolicyRule['capability'], effect: 'allow' | 'deny' | 'approval'): PolicyRule {
  return { id, capability, effect };
}