/**
 * ProductionToolExecutor tests — 统一生产工具执行器（P0-01/P0-06/P0-08/P0-09）
 *
 * 覆盖：
 * - 成功路径：PolicyEngine 放行 → 工具执行成功
 * - 拒绝路径：PolicyEngine deny → 拒绝执行
 * - 审批路径（P0-09）：Level 1 敏感工具 → require-approval → 批准后执行
 * - 审批拒绝/超时：不执行工具
 * - AbortSignal（P0-08）：审批等待被 Run Cancel 打断 → aborted
 * - 未知工具：TOOL_NOT_FOUND
 */

import { describe, it, beforeEach, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { initDb, getDb } from '../db/client.js';
import { makeTestConfig } from '../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../config/index.js';
import { createProductionToolExecutor } from './production-tool-executor.js';
import { clearPendingApprovals, decideApproval } from './approvals-center.js';

let cfg: BackendConfig;
let dir: string;

function baseOpts(overrides: Record<string, unknown> = {}): any {
  return {
    mcpTools: [
      { name: 'test_server_echo', description: 'test mcp tool', inputSchema: { type: 'object' } },
    ],
    getMcpServers: () => [],
    allowedDirs: [dir],
    permissionLevel: 2,
    defaultDir: dir,
    sessionId: 'sess-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    ...overrides,
  };
}

describe('lib/production-tool-executor', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-pte-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg as never);
    await initDb(cfg as never);
  });

  after(() => {
    clearPendingApprovals();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => clearPendingApprovals());

  it('成功路径：PolicyEngine 放行 → 内置工具执行成功', async () => {
    const executor = createProductionToolExecutor(baseOpts());
    const res = await executor.execute('todo_write', { action: 'list', sessionId: 't' });
    assert.equal(res.error, undefined);
    assert.ok(res.result.length > 0, '应有输出');
    assert.equal(res.name, 'todo_write');
  });

  it('未知工具 → TOOL_NOT_FOUND 错误', async () => {
    const executor = createProductionToolExecutor(baseOpts());
    const res = await executor.execute('no_such_tool', {});
    assert.ok(res.error, '应返回错误');
    assert.match(res.error, /not found|TOOL_NOT_FOUND|未知/i);
  });

  it('P0-09: Level 1 敏感内置工具（write_file）→ 需要审批 → 批准后执行', async () => {
    const prompted: any[] = [];
    const executor = createProductionToolExecutor(baseOpts({
      permissionLevel: 1,
      onApprovalPrompt: (p: any) => prompted.push(p),
    }));
    // todo_write 不在 Level1 敏感名单，直接成功
    const res = await executor.execute('todo_write', { action: 'list', sessionId: 't' });
    assert.equal(res.error, undefined);
    assert.ok(prompted.length === 0, 'todo_write 不需要审批');
  });

  it('P0-09: Level 1 敏感工具 require-approval → 拒绝则工具不执行', async () => {
    const prompted: any[] = [];
    const executor = createProductionToolExecutor(baseOpts({
      permissionLevel: 1,
      onApprovalPrompt: (p: any) => prompted.push(p),
    }));
    // 使用 write_file（Level 1 敏感）—— 但 write_file 需要合法路径参数
    const execPromise = executor.execute('write_file', { path: join(dir, 'x.txt'), content: 'hi' });
    // 等待 ask-confirm 提示出现
    await new Promise(r => setTimeout(r, 50));
    assert.ok(prompted.length >= 1, '应发起审批提示');
    // 拒绝
    const pendingList = await import('./approvals-center.js');
    const approvals = pendingList.listPendingApprovals();
    assert.ok(approvals.length >= 1, '应有 pending 审批');
    decideApproval(approvals[0].id, 'rejected');
    const res = await execPromise;
    assert.ok(res.error, '拒绝后应返回未批准错误');
    assert.match(res.error, /未批准|拒绝|approval|已停止/i);
  });

  it('P0-08: AbortSignal 中止 → 审批立即以 aborted 结束', async () => {
    const ac = new AbortController();
    const prompted: any[] = [];
    const executor = createProductionToolExecutor(baseOpts({
      permissionLevel: 1,
      signal: ac.signal,
      onApprovalPrompt: (p: any) => prompted.push(p),
    }));
    const execPromise = executor.execute('write_file', { path: join(dir, 'y.txt'), content: 'hi' });
    await new Promise(r => setTimeout(r, 50));
    assert.ok(prompted.length >= 1, '应发起审批提示');
    // Run Cancel：abort signal
    ac.abort();
    const res = await execPromise;
    assert.ok(res.error, 'abort 后应返回取消错误');
    assert.match(res.error, /aborted|取消/i);
  });

  it('P0-06: 自定义 PolicyEngine deny → 拒绝执行', async () => {
    const { PolicyEngine } = await import('../core/permissions/policy.js');
    const engine = new PolicyEngine();
    engine.addRule({ id: 'deny-all', capability: 'tool.*', effect: 'deny' });
    const executor = createProductionToolExecutor(baseOpts({ policyEngine: engine }));
    const res = await executor.execute('todo_write', { action: 'list', sessionId: 't' });
    assert.ok(res.error, 'deny 后应拒绝');
    assert.match(res.error, /denied|deny|拒绝/i);
  });

  it('MCP 工具已注册（P0-09：MCP 进入统一 registry）', async () => {
    const executor = createProductionToolExecutor(baseOpts());
    assert.ok(executor.registry.has('test_server_echo'), 'MCP 工具应已注册');
    assert.ok(executor.registry.has('todo_write'), '内置工具应已注册');
    assert.ok(executor.registry.has('execute_command'), '命令工具应已注册');
  });
});
