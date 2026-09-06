/**
 * ToolPolicy unit tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolPolicy, ToolPolicyRule } from './tool-policy.js';
import type { Capability, CapabilitySet } from '../permissions/index.js';

describe('tool-policy', () => {
  describe('default behavior', () => {
    test('allows all tools by default', () => {
      const policy = new ToolPolicy({});
      const result = policy.evaluate('any-tool');

      assert.equal(result.action, 'allow');
      assert.equal(result.matchedRule, undefined);
    });

    test('allow() returns true for unknown tools', () => {
      const policy = new ToolPolicy({});
      assert.equal(policy.allow('unknown-tool'), true);
    });

    test('denied() returns false for unknown tools', () => {
      const policy = new ToolPolicy({});
      assert.equal(policy.denied('unknown-tool'), false);
    });

    test('requiresApproval() returns false for unknown tools', () => {
      const policy = new ToolPolicy({});
      assert.equal(policy.requiresApproval('unknown-tool'), false);
    });
  });

  describe('exact match rules', () => {
    test('deny rule blocks exact tool name', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'dangerous-tool', action: 'deny' },
        ],
      });

      assert.equal(policy.denied('dangerous-tool'), true);
      assert.equal(policy.allow('dangerous-tool'), false);
      assert.equal(policy.requiresApproval('dangerous-tool'), false);
    });

    test('require-approval rule triggers approval for exact tool name', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'sensitive-tool', action: 'require-approval' },
        ],
      });

      assert.equal(policy.requiresApproval('sensitive-tool'), true);
      assert.equal(policy.allow('sensitive-tool'), false);
      assert.equal(policy.denied('sensitive-tool'), false);
    });

    test('allow rule explicitly allows (redundant but explicit)', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'explicit-tool', action: 'allow' },
        ],
      });

      assert.equal(policy.allow('explicit-tool'), true);
    });
  });

  describe('glob pattern matching', () => {
    test('* wildcard matches prefix', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'admin-*', action: 'deny' },
        ],
      });

      assert.equal(policy.denied('admin-delete'), true);
      assert.equal(policy.denied('admin-create'), true);
      assert.equal(policy.denied('admin-'), true);
      assert.equal(policy.denied('admin'), false); // no trailing dash
      assert.equal(policy.allow('user-admin'), true); // doesn't match prefix
    });

    test('* wildcard matches suffix', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: '*-delete', action: 'deny' },
        ],
      });

      assert.equal(policy.denied('file-delete'), true);
      assert.equal(policy.denied('user-delete'), true);
      assert.equal(policy.allow('delete-file'), true);
    });

    test('* wildcard matches middle', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'file-*-access', action: 'require-approval' },
        ],
      });

      assert.equal(policy.requiresApproval('file-read-access'), true);
      assert.equal(policy.requiresApproval('file-write-access'), true);
      // Standard glob: 'file-access' lacks the middle '-' segment so it does NOT match 'file-*-access'
      assert.equal(policy.allow('file-access'), true);
    });

    test('multiple wildcards', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: '*-*-*', action: 'deny' },
        ],
      });

      assert.equal(policy.denied('a-b-c'), true);
      assert.equal(policy.denied('foo-bar-baz'), true);
      // Standard glob: 'a-b' has only one '-' so it does NOT match '*-*-*'
      assert.equal(policy.allow('a-b'), true);
    });

    test('special regex characters are escaped', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'tool.name', action: 'deny' }, // dot should be literal
        ],
      });

      assert.equal(policy.denied('tool.name'), true);
      assert.equal(policy.denied('toolXname'), false); // dot not matching any char
    });
  });

  describe('rule priority (first match wins)', () => {
    test('first matching rule takes precedence', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'tool-*', action: 'deny' },
          { pattern: 'tool-allowed', action: 'allow' }, // Should not be reached
        ],
      });

      assert.equal(policy.denied('tool-allowed'), true);
    });

    test('more specific rule first allows override', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'tool-allowed', action: 'allow' },
          { pattern: 'tool-*', action: 'deny' },
        ],
      });

      assert.equal(policy.allow('tool-allowed'), true);
      assert.equal(policy.denied('tool-other'), true);
    });
  });

  describe('capabilities (ignored for now per spec)', () => {
    test('capabilities field exists on rule but does not affect evaluation yet', () => {
      const caps = new Set(['filesystem.read']) as CapabilitySet;
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'file-read', action: 'allow', capabilities: ['filesystem.read'] as Capability[] },
        ],
        grantedCapabilities: caps,
      });

      // Currently capabilities are checked but since we grant the capability, it should allow
      assert.equal(policy.allow('file-read'), true);
    });

    test('rule with ungranted capability is skipped', () => {
      const caps = new Set(['filesystem.write']) as CapabilitySet; // missing read
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'file-read', action: 'allow', capabilities: ['filesystem.read'] as Capability[] },
        ],
        grantedCapabilities: caps,
      });

      // Rule requires filesystem.read but we only have write, so rule skipped -> default allow
      assert.equal(policy.allow('file-read'), true);
    });

    test('deny rule with ungranted capability is skipped', () => {
      const caps = new Set(['filesystem.write']) as CapabilitySet;
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'file-read', action: 'deny', capabilities: ['filesystem.read'] as Capability[] },
        ],
        grantedCapabilities: caps,
      });

      // Rule requires read but we don't have it, so rule skipped -> default allow
      assert.equal(policy.allow('file-read'), true);
    });
  });

  describe('dynamic rule management', () => {
    test('addRule appends rule', () => {
      const policy = new ToolPolicy({});
      policy.addRule({ pattern: 'new-tool', action: 'deny' });

      assert.equal(policy.denied('new-tool'), true);
    });

    test('removeRule removes by pattern', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'tool-a', action: 'deny' },
          { pattern: 'tool-b', action: 'deny' },
        ],
      });

      assert.equal(policy.removeRule('tool-a'), true);
      assert.equal(policy.allow('tool-a'), true); // Now allowed (default)
      assert.equal(policy.denied('tool-b'), true); // Still denied
    });

    test('removeRule returns false for non-existent pattern', () => {
      const policy = new ToolPolicy({});
      assert.equal(policy.removeRule('non-existent'), false);
    });

    test('getRules returns copy of rules', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'tool-a', action: 'deny' },
        ],
      });

      const rules = policy.getRules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0].pattern, 'tool-a');

      // Modifying returned array shouldn't affect policy
      rules.push({ pattern: 'tool-b', action: 'deny' });
      assert.equal(policy.getRules().length, 1);
    });
  });

  describe('getGrantedCapabilities', () => {
    test('returns granted capabilities', () => {
      const caps = new Set(['filesystem.read', 'network.http']) as CapabilitySet;
      const policy = new ToolPolicy({
        grantedCapabilities: caps,
      });

      const granted = policy.getGrantedCapabilities();
      assert.equal(granted.has('filesystem.read'), true);
      assert.equal(granted.has('network.http'), true);
      assert.equal(granted.has('filesystem.write'), false);
    });
  });

  describe('defaultAction option (P1-37)', () => {
    test('defaultAction: deny - unknown tools are denied', () => {
      const policy = new ToolPolicy({ defaultAction: 'deny' });
      assert.equal(policy.allow('unknown-tool'), false);
      assert.equal(policy.denied('unknown-tool'), true);
    });

    test('defaultAction: allow - unknown tools are allowed (legacy default)', () => {
      const policy = new ToolPolicy({ defaultAction: 'allow' });
      assert.equal(policy.allow('unknown-tool'), true);
      assert.equal(policy.denied('unknown-tool'), false);
    });

    test('defaultAction: deny - explicit allow rule still works', () => {
      const policy = new ToolPolicy({
        rules: [{ pattern: 'allowed-tool', action: 'allow' }],
        defaultAction: 'deny',
      });
      assert.equal(policy.allow('allowed-tool'), true);
      assert.equal(policy.denied('other-tool'), true);
    });

    test('defaultAction: deny - explicit deny rule still works', () => {
      const policy = new ToolPolicy({
        rules: [{ pattern: 'denied-tool', action: 'deny' }],
        defaultAction: 'deny',
      });
      assert.equal(policy.denied('denied-tool'), true);
      assert.equal(policy.denied('other-tool'), true);
    });
  });
});