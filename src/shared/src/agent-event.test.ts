import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_EVENT_TYPES,
  EVENT_STATUSES,
  buildToolPayload,
  toolEventLabel,
  type AgentEventEnvelope,
  type AgentEventType,
  type EventStatus,
  type ToolEventPayload,
} from './agent-event.js';

describe('agent-event protocol', () => {
  it('事件类型集合非空且互不重复', () => {
    assert.ok(AGENT_EVENT_TYPES.length > 0);
    assert.equal(new Set(AGENT_EVENT_TYPES).size, AGENT_EVENT_TYPES.length);
  });

  it('事件类型全为字符串且覆盖核心生命周期', () => {
    for (const t of AGENT_EVENT_TYPES) assert.equal(typeof t, 'string');
    // 核心事件必须在集合内
    for (const core of ['task.started', 'task.completed', 'agent.status', 'agent.message.delta',
      'tool.started', 'tool.completed', 'tool.error', 'token'] as const) {
      assert.ok((AGENT_EVENT_TYPES as readonly string[]).includes(core), `缺少核心事件 ${core}`);
    }
  });

  it('状态集合覆盖完整生命周期', () => {
    assert.deepEqual([...EVENT_STATUSES].sort(), ['cancelled', 'completed', 'error', 'interrupted', 'retry', 'running', 'started']);
  });

  it('buildToolPayload 从常用参数提取紧凑展示', () => {
    const p = buildToolPayload('read_file', { path: 'src/agent/core.ts', encoding: 'utf-8' });
    assert.equal(p.toolName, 'read_file');
    assert.equal(p.toolInput, 'src/agent/core.ts');
    assert.deepEqual(p.inputDetail, { path: 'src/agent/core.ts', encoding: 'utf-8' });
    assert.equal(p.toolOutput, undefined);
  });

  it('buildToolPayload 无识别字段时退化为键值对概览', () => {
    const p = buildToolPayload('custom_tool', { a: 1, b: 'x', c: true, d: 'y', e: 2 });
    assert.ok(p.toolInput.includes('a=1'));
    assert.ok(p.toolInput.length > 0);
  });

  it('buildToolPayload 输出长文本时摘要 200 字符并保留完整详情', () => {
    const long = 'x'.repeat(500);
    const p = buildToolPayload('read_file', { path: 'big.ts' }, long);
    assert.equal(p.toolOutput!.length, 201); // 200 + '…'
    assert.equal(p.outputDetail, long);
  });

  it('toolEventLabel 映射常见工具为渲染标签', () => {
    assert.equal(toolEventLabel('read_file'), 'Read');
    assert.equal(toolEventLabel('write_file'), 'Write');
    assert.equal(toolEventLabel('edit_file'), 'Edit');
    assert.equal(toolEventLabel('grep'), 'Grep');
    assert.equal(toolEventLabel('browser.search'), 'Search');
    assert.equal(toolEventLabel('run_tests'), 'Test');
    assert.equal(toolEventLabel('filesystem_read'), 'MCP');
    assert.equal(toolEventLabel('execute_command'), 'Shell');
    // 下划线命名是 MCP 工具格式（{server}_{tool}）；仅无下划线未知工具才回落 Tool
    assert.equal(toolEventLabel('some_server_parse_doc'), 'MCP');
    assert.equal(toolEventLabel('myCustomTool'), 'Tool');
  });

  it('信封结构可构造（类型层面）', () => {
    const env: AgentEventEnvelope = {
      eventId: 'e-1', sessionId: 's-1', taskId: 't-1', agentId: 'main', agentType: 'conversation',
      eventType: 'tool.started', timestamp: '2026-08-24T00:00:00Z', seq: 1,
      status: 'started', tool: {} as ToolEventPayload,
    };
    assert.equal(env.eventType, 'tool.started');
    assert.equal(env.seq, 1);
  });

  it('事件与状态类型是细粒度判别联合（编译期校验）', () => {
    const t: AgentEventType = 'agent.message.delta';
    const s: EventStatus = 'completed';
    assert.ok(t.length > 0 && s.length > 0);
  });
});