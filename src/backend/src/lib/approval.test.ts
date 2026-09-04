import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApproval, requiresApproval, summarizeArgs } from './approval.js';
import { createPendingApproval, decideApproval, clearPendingApprovals, listPendingApprovals } from './approvals-center.js';

describe('approval — 挂起/决议/超时', () => {
  beforeEach(() => clearPendingApprovals());

  it('approved → resolve 为 {approved:true}', async () => {
    let prompted = false;
    const { promise, token } = createApproval({
      id: 'a1', toolName: 'write_file', argsSummary: 'path=a.ts',
      prompt: () => { prompted = true; },
    });
    assert.ok(prompted);
    token.settle('approved');
    const r = await promise;
    assert.deepEqual(r, { approved: true, decision: 'approved' });
  });

  it('rejected → resolve 为 {approved:false}', async () => {
    const { promise, token } = createApproval({ id: 'a2', toolName: 'command', argsSummary: 'x', prompt: () => {} });
    token.settle('rejected');
    const r = await promise;
    assert.deepEqual(r, { approved: false, decision: 'rejected' });
  });

  it('超时自动拒绝（timeout）', async () => {
    const { promise } = createApproval({ id: 'a3', toolName: 'x', argsSummary: 'y', prompt: () => {}, timeoutMs: 50 });
    const r = await promise;
    assert.equal(r.approved, false);
    assert.equal(r.decision, 'timeout');
  });

  it('requiresApproval：Level 1 敏感工具需要确认，其余不需要', () => {
    assert.equal(requiresApproval('write_file', 1), true);
    assert.equal(requiresApproval('execute_command', 1), true);
    assert.equal(requiresApproval('read_file', 1), false);
    assert.equal(requiresApproval('write_file', 2), false); // Level 2 自动
  });

  it('summarizeArgs 生成简洁摘要', () => {
    assert.equal(summarizeArgs({}), '(无参数)');
    assert.ok(summarizeArgs({ path: 'a.ts' }).includes('path=a.ts'));
  });
});

describe('approvals-center — 注册中心与决议路由', () => {
  beforeEach(() => clearPendingApprovals());

  it('createPendingApproval 注册并可被 decide', async () => {
    const prompted: any[] = [];
    const { id, promise } = createPendingApproval({
      toolName: 'delete_file',
      args: { path: 'x.ts' },
      prompt: (p) => prompted.push(p),
    });
    assert.equal(prompted.length, 1);
    assert.equal(prompted[0].toolName, 'delete_file');
    assert.ok(listPendingApprovals().some(a => a.id === id));

    assert.equal(decideApproval(id, 'approved'), true);
    const r = await promise;
    assert.equal(r.approved, true);
    // 决议后 pending 自动清理
    await new Promise(res => setTimeout(res, 10));
    assert.ok(!listPendingApprovals().some(a => a.id === id));
  });

  it('对不存在的 id 决议返回 false', () => {
    assert.equal(decideApproval('nope', 'approved'), false);
  });

  it('超时后从 pending 移除', async () => {
    const { id, promise } = createPendingApproval({
      toolName: 'x', args: {}, prompt: () => {},
    });
    // 默认 60s 太长，这里直接 settle 模拟（超时路径已由 approval.test 覆盖）
    decideApproval(id, 'rejected');
    await promise;
    assert.ok(!listPendingApprovals().some(a => a.id === id));
  });
});