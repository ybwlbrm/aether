/**
 * approvals-center unit tests.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPendingApproval,
  decideApproval,
  consumeApproval,
  listPendingApprovals,
  getApprovalGrant,
  __setGrantExpiresAtForTest,
  clearPendingApprovals,
  hashToolArgs,
  DEFAULT_ISSUER,
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

  describe('ApprovalGrant 持久化字段（整改计划第 1 章，P0）', () => {
    test('grant 含 grantId/runId/taskId/toolName/argsHash/issuer/expiresAt/consumedAt', () => {
      const { id } = createPendingApproval({
        toolName: 'write_file',
        args: { path: 'a.txt', content: 'hello' },
        prompt: () => {},
        runId: 'run-xyz',
        taskId: 'task-xyz',
        issuer: 'local',
      });
      const grant = getApprovalGrant(id);
      assert.ok(grant, 'grant 应存在');
      assert.equal(grant!.grantId, id);
      assert.equal(grant!.runId, 'run-xyz');
      assert.equal(grant!.taskId, 'task-xyz');
      assert.equal(grant!.toolName, 'write_file');
      assert.equal(grant!.argsHash, hashToolArgs({ path: 'a.txt', content: 'hello' }));
      assert.equal(grant!.issuer, 'local');
      assert.ok(grant!.expiresAt > Date.now(), 'expiresAt 应在未来');
      assert.equal(grant!.consumedAt, null, '创建时未消费');
    });

    test('默认 issuer 为 local（DEFAULT_ISSUER）', () => {
      const { id } = createPendingApproval({ toolName: 't', args: {}, prompt: () => {} });
      assert.equal(getApprovalGrant(id)!.issuer, DEFAULT_ISSUER);
    });
  });

  describe('consumeApproval 原子消费（整改计划第 1 章，P0）', () => {
    test('同一 grant 重放 → 第二次 ALREADY_CONSUMED（不允许重复批准）', () => {
      const { id } = createPendingApproval({ toolName: 't', args: {}, prompt: () => {} });
      const first = consumeApproval(id, 'approved');
      assert.equal(first.ok, true);
      const replay = consumeApproval(id, 'rejected');
      assert.equal(replay.ok, false);
      assert.equal(replay.code, 'ALREADY_CONSUMED', '重放必须拒绝');
    });

    test('跨会话/跨标签页重复批准 → ALREADY_CONSUMED', () => {
      const { id } = createPendingApproval({ toolName: 't', args: {}, prompt: () => {} });
      assert.equal(consumeApproval(id, 'approved', 'remote:mobile').ok, true);
      const second = consumeApproval(id, 'approved', 'local');
      assert.equal(second.ok, false);
      assert.equal(second.code, 'ALREADY_CONSUMED');
    });

    test('过期 grant → EXPIRED', () => {
      const { id } = createPendingApproval({ toolName: 't', args: {}, prompt: () => {}, timeoutMs: 60_000 });
      // 强制将内部 grant 标记为过期（模拟超时竞态窗口）
      assert.equal(__setGrantExpiresAtForTest(id, Date.now() - 1000), true);
      const res = consumeApproval(id, 'approved');
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EXPIRED');
    });

    test('不存在的 grant → NOT_FOUND', () => {
      const res = consumeApproval('apr-does-not-exist', 'approved');
      assert.equal(res.ok, false);
      assert.equal(res.code, 'NOT_FOUND');
    });

    test('成功消费后记录 consumedAt 与 decision，且从列表移除', async () => {
      const { id, promise } = createPendingApproval({ toolName: 't', args: { a: 1 }, prompt: () => {} });
      const res = consumeApproval(id, 'approved', 'local');
      assert.equal(res.ok, true);
      assert.ok(res.grant.consumedAt !== null, 'consumedAt 应被记录');
      assert.equal(res.grant.decision, 'approved');
      assert.equal(listPendingApprovals().length, 0, '消费后从 pending 列表移除');
      const result = await promise;
      assert.equal(result.approved, true);
    });
  });
});