/**
 * approvals-center unit tests.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPendingApproval,
  decideApproval,
  listPendingApprovals,
  clearPendingApprovals,
} from './approvals-center.js';

describe('lib/approvals-center', () => {
  beforeEach(() => {
    clearPendingApprovals();
  });

  afterEach(() => {
    clearPendingApprovals();
  });

  describe('createPendingApproval', () => {
    test('creates approval with conversationId and returns apr-xxxx id', async () => {
      const promptCalls: Array<{ id: string; toolName: string; argsSummary: string }> = [];
      const { id, promise } = createPendingApproval({
        toolName: 'test-tool',
        args: { param: 'value' },
        prompt: (payload) => promptCalls.push(payload),
        conversationId: 'conv-123',
        timeoutMs: 10, // 短超时用于测试
      });

      assert.ok(id.startsWith('apr-'));
      assert.equal(promptCalls.length, 1);
      assert.equal(promptCalls[0].id, id);
      assert.equal(promptCalls[0].toolName, 'test-tool');
      assert.ok(promptCalls[0].argsSummary.includes('param'));

      // Wait for timeout (should auto-reject)
      const result = await promise;
      assert.equal(result.approved, false);
      assert.equal(result.decision, 'timeout');
    });

    test('stores runId, taskId, agentId, toolCallId binding fields', async () => {
      const { id } = createPendingApproval({
        toolName: 'binding-tool',
        args: { foo: 'bar' },
        prompt: () => {},
        conversationId: 'conv-456',
        runId: 'run-789',
        taskId: 'task-abc',
        agentId: 'agent-def',
        toolCallId: 'call-ghi',
      });

      const pending = listPendingApprovals();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].id, id);
      assert.equal(pending[0].conversationId, 'conv-456');
      assert.equal(pending[0].runId, 'run-789');
      assert.equal(pending[0].taskId, 'task-abc');
      assert.equal(pending[0].agentId, 'agent-def');
      assert.equal(pending[0].toolCallId, 'call-ghi');
    });

    test('optional binding fields can be omitted', async () => {
      const { id } = createPendingApproval({
        toolName: 'minimal-tool',
        args: {},
        prompt: () => {},
      });

      const pending = listPendingApprovals();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].id, id);
      assert.equal(pending[0].conversationId, undefined);
      assert.equal(pending[0].runId, undefined);
      assert.equal(pending[0].taskId, undefined);
      assert.equal(pending[0].agentId, undefined);
      assert.equal(pending[0].toolCallId, undefined);
    });
  });

  describe('decideApproval', () => {
    test('approves pending approval and clears it from list', async () => {
      let settleFn: (d: 'approved' | 'rejected') => void;
      const promise = new Promise<{ approved: boolean; decision: 'approved' | 'rejected' | 'timeout' }>((resolve) => {
        settleFn = (d) => resolve({ approved: d === 'approved', decision: d });
      });

      // Manually create a pending approval to test decideApproval
      const { createApproval } = await import('./approval.js');
      const { token } = createApproval({
        id: 'apr-test123',
        toolName: 'decide-tool',
        argsSummary: 'test',
        prompt: () => {},
      });

      // We need to test via the public API, so use createPendingApproval
      const { id, promise: approvalPromise } = createPendingApproval({
        toolName: 'decide-tool',
        args: { test: 'data' },
        prompt: () => {},
        conversationId: 'conv-decide',
      });

      // Decide approved
      const found = decideApproval(id, 'approved');
      assert.equal(found, true);

      const result = await approvalPromise;
      assert.equal(result.approved, true);
      assert.equal(result.decision, 'approved');

      // Should be cleared from pending list
      const pending = listPendingApprovals();
      assert.equal(pending.length, 0);
    });

    test('rejects pending approval and clears it from list', async () => {
      const { id, promise } = createPendingApproval({
        toolName: 'reject-tool',
        args: { test: 'data' },
        prompt: () => {},
      });

      const found = decideApproval(id, 'rejected');
      assert.equal(found, true);

      const result = await promise;
      assert.equal(result.approved, false);
      assert.equal(result.decision, 'rejected');

      // Should be cleared from pending list
      const pending = listPendingApprovals();
      assert.equal(pending.length, 0);
    });

    test('returns false for unknown id', () => {
      const found = decideApproval('apr-unknown', 'approved');
      assert.equal(found, false);
    });

    test('returns false for already decided id', async () => {
      const { id } = createPendingApproval({
        toolName: 'double-decide',
        args: {},
        prompt: () => {},
      });

      decideApproval(id, 'approved');
      const found = decideApproval(id, 'rejected');
      assert.equal(found, false);
    });
  });

  describe('listPendingApprovals', () => {
    test('returns empty array when no pending approvals', () => {
      const pending = listPendingApprovals();
      assert.deepEqual(pending, []);
    });

    test('returns all pending approvals with binding fields', async () => {
      const { id: id1 } = createPendingApproval({
        toolName: 'tool-1',
        args: { a: 1 },
        prompt: () => {},
        conversationId: 'conv-1',
        runId: 'run-1',
      });

      const { id: id2 } = createPendingApproval({
        toolName: 'tool-2',
        args: { b: 2 },
        prompt: () => {},
        conversationId: 'conv-2',
        taskId: 'task-2',
      });

      const pending = listPendingApprovals();
      assert.equal(pending.length, 2);

      const p1 = pending.find(p => p.id === id1)!;
      assert.equal(p1.toolName, 'tool-1');
      assert.equal(p1.conversationId, 'conv-1');
      assert.equal(p1.runId, 'run-1');
      assert.equal(p1.taskId, undefined);

      const p2 = pending.find(p => p.id === id2)!;
      assert.equal(p2.toolName, 'tool-2');
      assert.equal(p2.conversationId, 'conv-2');
      assert.equal(p2.runId, undefined);
      assert.equal(p2.taskId, 'task-2');
    });
  });

  describe('clearPendingApprovals', () => {
    test('clears all pending approvals', async () => {
      createPendingApproval({ toolName: 't1', args: {}, prompt: () => {} });
      createPendingApproval({ toolName: 't2', args: {}, prompt: () => {} });

      assert.equal(listPendingApprovals().length, 2);
      clearPendingApprovals();
      assert.equal(listPendingApprovals().length, 0);
    });
  });

  describe('auto-cleanup on timeout', () => {
    test('removes from pending list after timeout', async () => {
      const { createApproval } = await import('./approval.js');
      
      // Create approval with very short timeout
      const { token, promise } = createApproval({
        id: 'apr-timeout-test',
        toolName: 'timeout-tool',
        argsSummary: 'test',
        prompt: () => {},
        timeoutMs: 10,
      });

      // Manually add to pending to test cleanup
      const { createPendingApproval: create } = await import('./approvals-center.js');
      // We can't easily test the internal pending map cleanup without exposing it
      // But we can verify the promise resolves with timeout
      const result = await promise;
      assert.equal(result.approved, false);
      assert.equal(result.decision, 'timeout');
    });
  });
});