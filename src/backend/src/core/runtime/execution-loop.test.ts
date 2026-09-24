/**
 * Unified Execution Loop tests (P0-01/02/03/04/05/06 + §17 + §57)
 *
 * 覆盖：
 * - Normal（loop=false）：允许 Model→Tool→Tool Result→Model→Final Answer
 * - Loop（loop=true）：自主执行直到完成/预算耗尽/取消
 * - 预算检查（turns/tool_calls/tokens/cancelled）
 * - §17 流中断（interrupted）→ failed 语义
 * - Usage 累计（cumulative vs lastRequest 区分，§八）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runExecutionLoop,
  normalExecutionBudget,
  loopExecutionBudget,
  createExecutionUsage,
  accumulateUsage,
  finalizeOnBudgetExceeded,
  budgetFromAgentLimits,
  type ExecutionLoopDeps,
  type ExecutionTool,
} from './execution-loop.js';
import type { ModelRequest, ModelResponse, ModelRuntime } from '../models/model-runtime.js';

/** 可编程 ModelRuntime mock：按序号返回预设响应 */
function mockModel(responses: Array<Partial<ModelResponse>>): ModelRuntime & { calls: number } {
  let calls = 0;
  return {
    calls: 0,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      calls++;
      (this as { calls: number }).calls = calls;
      const preset = responses[Math.min(calls - 1, responses.length - 1)];
      return {
        id: `resp-${calls}`,
        provider: req.provider,
        model: req.model,
        content: '',
        finishReason: 'stop',
        ...preset,
      };
    },
    async *stream(): AsyncIterable<never> { return; },
  } as never;
}

function toolCall(name: string, id = `call-${name}`): { id: string; name: string; arguments: string } {
  return { id, name, arguments: '{}' };
}

function depsFor(model: ModelRuntime, executeTool: (t: ExecutionTool) => Promise<string> = async (t) => `ok:${t.name}`): ExecutionLoopDeps {
  return {
    model,
    hasTools: true,
    buildRequest: (messages) => ({ provider: 'mock', model: 'm', messages }),
    executeTool: (t, _turn) => executeTool(t),
  };
}

describe('core/runtime/execution-loop', () => {
  it('Normal: Model→Tool→Tool Result→Model→Final Answer（必要工具链后结束）', async () => {
    const model = mockModel([
      { toolCalls: [toolCall('get_weather')], finishReason: 'tool_calls' },
      { content: '天气晴，25°C', finishReason: 'stop' },
    ]);
    const executed: string[] = [];
    const result = await runExecutionLoop(
      depsFor(model, async (t) => { executed.push(t.name); return '晴，25°C'; }),
      [],
      { loop: false },
    );
    assert.equal(result.state, 'completed');
    assert.equal(result.content, '天气晴，25°C');
    assert.deepEqual(executed, ['get_weather']);
    assert.equal(result.turnsUsed, 2);
    assert.equal(result.toolCallCount, 1);
  });

  it('Normal: 模型直接给出最终回答（无工具）即结束，不自动重新问模型', async () => {
    const model = mockModel([{ content: '直接回答', finishReason: 'stop' }]);
    const result = await runExecutionLoop(depsFor(model), [], { loop: false });
    assert.equal(result.state, 'completed');
    assert.equal(result.content, '直接回答');
    assert.equal(result.turnsUsed, 1, 'Normal 模式直接回答后不得自动再次调用模型');
    assert.equal((model as unknown as { calls: number }).calls, 1);
  });

  it('Loop: 持续执行直到无工具调用（自主完成）', async () => {
    const model = mockModel([
      { toolCalls: [toolCall('step_a')], finishReason: 'tool_calls' },
      { toolCalls: [toolCall('step_b')], finishReason: 'tool_calls' },
      { content: '任务完成', finishReason: 'stop' },
    ]);
    const result = await runExecutionLoop(depsFor(model), [], { loop: true });
    assert.equal(result.state, 'completed');
    assert.equal(result.content, '任务完成');
    assert.equal(result.turnsUsed, 3);
    assert.equal(result.toolCallCount, 2);
  });

  it('Loop: turns 预算耗尽 → budget_exceeded + finalization（不伪造成功）', async () => {
    // 每次都给 tool_calls，永不完成 → 触发 maxTurns 预算
    const model = mockModel([{ toolCalls: [toolCall('x')], finishReason: 'tool_calls' }]);
    const budget = { ...loopExecutionBudget(), maxTurns: 3, maxToolCalls: 0, maxTimeMs: 0, maxTokens: 0, maxCostCny: 0 };
    const result = await runExecutionLoop(depsFor(model), [], { loop: true, budget });
    assert.equal(result.state, 'budget_exceeded');
    assert.equal(result.budgetExceeded, 'turns');
    assert.equal(result.turnsUsed, 3);
    assert.ok(result.content.includes('已达到最大轮数'), `finalization 应说明预算耗尽，实际: ${result.content}`);
  });

  it('Loop: tool_calls 预算耗尽 → budget_exceeded=tool_calls', async () => {
    const model = mockModel([{ toolCalls: [toolCall('a'), toolCall('b')], finishReason: 'tool_calls' }]);
    const budget = { ...loopExecutionBudget(), maxTurns: 0, maxToolCalls: 3, maxTimeMs: 0, maxTokens: 0, maxCostCny: 0 };
    const result = await runExecutionLoop(depsFor(model), [], { loop: true, budget });
    assert.equal(result.state, 'budget_exceeded');
    assert.equal(result.budgetExceeded, 'tool_calls');
  });

  it('§17: 流中断（interrupted）→ state=failed + interrupted=true', async () => {
    const model = mockModel([
      { content: '部分输出', finishReason: 'error', interrupted: true } as ModelResponse,
    ]);
    const result = await runExecutionLoop(depsFor(model), [], { loop: false });
    assert.equal(result.state, 'failed');
    assert.equal(result.interrupted, true);
    assert.equal(result.content, '部分输出');
  });

  it('取消: signal.aborted → cancelled', async () => {
    const model = mockModel([{ content: '不会返回', finishReason: 'stop' }]);
    const ac = new AbortController();
    // 立即中止，使首个模型调用前就检查到取消
    ac.abort();
    const result = await runExecutionLoop(depsFor(model), [], { loop: true, signal: ac.signal });
    assert.equal(result.state, 'cancelled');
    assert.equal(result.budgetExceeded, 'cancelled');
  });

  it('Normal 与 Loop 预算确实不同（P0-07）', () => {
    const normal = normalExecutionBudget();
    const loop = loopExecutionBudget();
    assert.ok(normal.maxTurns < loop.maxTurns, 'Normal 轮数预算应小于 Loop');
    assert.ok(normal.maxToolCalls < loop.maxToolCalls, 'Normal 工具预算应小于 Loop');
  });

  it('Usage: cumulative 与 lastRequest 区分（§八）', () => {
    const usage = createExecutionUsage();
    accumulateUsage(usage, { inputTokens: 100, outputTokens: 20 });
    assert.equal(usage.lastRequestInputTokens, 100);
    assert.equal(usage.lastRequestTotalTokens, 120);
    assert.equal(usage.cumulativeTotalTokens, 120);
    // 第二轮
    accumulateUsage(usage, { inputTokens: 50, outputTokens: 10 });
    assert.equal(usage.lastRequestInputTokens, 50);
    assert.equal(usage.cumulativeInputTokens, 150);
    assert.equal(usage.cumulativeOutputTokens, 30);
    assert.equal(usage.cumulativeTotalTokens, 180, 'cumulative total = sum of all input+output');
  });

  it('finalizeOnBudgetExceeded 结构化总结（P0-06）', () => {
    const msg = finalizeOnBudgetExceeded('tokens', 4, 6);
    assert.ok(msg.includes('Token 预算耗尽'));
    assert.ok(msg.includes('4'));
    assert.ok(msg.includes('6'));
  });

  it('§31: budgetFromAgentLimits — AgentDefinition limits 覆盖默认预算（配置源生效）', () => {
    const limits = { maxTurns: 12, maxToolCalls: 60, maxTimeMs: 600_000, maxTokens: 32_000 };
    const normal = budgetFromAgentLimits(limits, false);
    assert.equal(normal.maxTurns, 12, 'Normal 模式使用 Agent 配置的 turns');
    assert.equal(normal.maxToolCalls, 60, 'Normal 模式使用 Agent 配置的工具上限');
    assert.equal(normal.maxTimeMs, 600_000);
    assert.equal(normal.maxTokens, 32_000);

    const loop = budgetFromAgentLimits(limits, true);
    assert.equal(loop.maxTurns, 12, 'Loop 模式同样继承 Agent 配置（而非散落 30）');
    assert.equal(loop.maxToolCalls, 60);
  });

  it('§31: budgetFromAgentLimits — 未配置时回退 Normal/Loop 默认预算', () => {
    const normal = budgetFromAgentLimits(undefined, false);
    assert.equal(normal.maxTurns, normalExecutionBudget().maxTurns);
    assert.equal(normal.maxToolCalls, normalExecutionBudget().maxToolCalls);

    const loop = budgetFromAgentLimits(undefined, true);
    assert.equal(loop.maxTurns, loopExecutionBudget().maxTurns);
    assert.equal(loop.maxToolCalls, loopExecutionBudget().maxToolCalls);
  });
});
