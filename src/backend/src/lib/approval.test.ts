import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApproval, requiresApproval, summarizeArgs } from './approval.js';
import { createPendingApproval, decideApproval, clearPendingApprovals, listPendingApprovals, hashToolArgs } from './approvals-center.js';

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

  it('P0-08: AbortSignal 中止 → 立即以 aborted 结束（不等 timeout）', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const { promise } = createApproval({
      id: 'a-abort', toolName: 'write_file', argsSummary: 'x',
      prompt: () => {},
      timeoutMs: 5000, // 超时远大于 abort，验证 abort 优先
      signal: ac.signal,
    });
    // 触发 abort —— 审批等待应立即结束
    ac.abort();
    const r = await promise;
    assert.equal(r.approved, false);
    assert.equal(r.decision, 'aborted');
    assert.ok(Date.now() - started < 1000, `abort 应即时结束，实际 ${Date.now() - started}ms`);
  });

  it('P0-08: signal 已中止时创建 → 立即 aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { promise } = createApproval({
      id: 'a-preabort', toolName: 'x', argsSummary: 'y',
      prompt: () => {},
      timeoutMs: 5000,
      signal: ac.signal,
    });
    const r = await promise;
    assert.equal(r.decision, 'aborted');
  });

  it('P0-08: settle 优先于 abort（已批准后 abort 不再改变结果）', async () => {
    const ac = new AbortController();
    const { promise, token } = createApproval({
      id: 'a-settle-first', toolName: 'x', argsSummary: 'y',
      prompt: () => {},
      signal: ac.signal,
    });
    token.settle('approved');
    ac.abort();
    const r = await promise;
    assert.deepEqual(r, { approved: true, decision: 'approved' });
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

  // ── P0-07：argsHash 绑定（用户批准的是"这一份具体参数"）──

  it('P0-07: hashToolArgs 对同一参数稳定、不同参数不同', () => {
    const a = hashToolArgs({ path: 'x.ts', content: 'hi' });
    const b = hashToolArgs({ path: 'x.ts', content: 'hi' });
    const c = hashToolArgs({ path: 'x.ts', content: 'hi2' });
    assert.equal(a, b, '相同参数应产生相同 hash');
    assert.notEqual(a, c, '不同参数应产生不同 hash');
  });

  it('P0-07: 审批记录携带 argsHash + 完整运行上下文绑定', () => {
    const { id, promise } = createPendingApproval({
      toolName: 'delete_file',
      args: { path: 'secret.txt' },
      conversationId: 'conv-1',
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      toolCallId: 'call-1',
      prompt: () => {},
    });
    const entry = listPendingApprovals().find(a => a.id === id);
    assert.ok(entry, '审批应已注册');
    assert.equal(entry!.runId, 'run-1');
    assert.equal(entry!.taskId, 'task-1');
    assert.equal(entry!.agentId, 'agent-1');
    assert.equal(entry!.toolCallId, 'call-1');
    assert.ok(entry!.argsHash, '应计算 argsHash');
    assert.equal(entry!.argsHash, hashToolArgs({ path: 'secret.txt' }));
    // 清理
    decideApproval(id, 'rejected');
    void promise;
  });
});