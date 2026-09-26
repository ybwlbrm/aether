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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runExecutionLoop,
  normalExecutionBudget,
  loopExecutionBudget,
  createExecutionUsage,
  accumulateUsage,
  finalizeOnBudgetExceeded,
  budgetFromAgentLimits,
  type ExecutionLoopDeps,
  type ExecutionLoopResult,
  type ExecutionTool,
} from './execution-loop.js'
import type { ExecutionCheckpoint } from './execution-checkpoint.js'
import type { ModelRequest, ModelResponse, ModelRuntime } from '../models/model-runtime.js'
import { ToolError } from '../errors/index.js'
import type { StreamChunk } from '@pacc/shared'

/** Loop 结果上的 checkpoint 附加字段（additive）：类型化读取，避免 any */
type LoopResultWithCheckpoint = ExecutionLoopResult & { readonly checkpoint?: ExecutionCheckpoint }

function checkpointOf(result: ExecutionLoopResult): ExecutionCheckpoint | undefined {
  return (result as LoopResultWithCheckpoint).checkpoint
}

/** 显式可重试错误：AEX-P0-005 起"未知错误"不再默认重试 */
function retryableFailure(message: string): Error {
  return Object.assign(new Error(message), { retryable: true })
}

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

  it('B2: hasTools=false 收到 tool_calls 不标 completed', async () => {
    // Given
    const model = mockModel([{
      toolCalls: [toolCall('get_weather')],
      finishReason: 'tool_calls',
    }])
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []

    // When
    const result = await runExecutionLoop({
      ...depsFor(model),
      hasTools: false,
      onEvent: (type, payload) => events.push({ type, payload }),
    }, [], { loop: false })

    // Then
    assert.equal(result.state, 'failed')
    const failure = events.find(({ type }) => type === 'execution.failed')
    assert.match(String(failure?.payload.error), /get_weather/)
  })

  it('tool call 消息链回归', async () => {
    const model = mockModel([
      {
        toolCalls: [{
          id: 'call-weather',
          name: 'get_weather',
          arguments: '{"city":"杭州"}',
        }],
        finishReason: 'tool_calls',
      },
      { content: '天气晴，25°C', finishReason: 'stop' },
    ])
    const messagesByTurn: Array<Array<Record<string, unknown>>> = []
    const executedTools: ExecutionTool[] = []

    const result = await runExecutionLoop(
      {
        ...depsFor(model, async (tool) => {
          executedTools.push(tool)
          return '晴，25°C'
        }),
        buildRequest: (messages) => {
          messagesByTurn.push([...messages])
          return { provider: 'mock', model: 'm', messages: [...messages] }
        },
      },
      [],
      { loop: false },
    )

    assert.equal(result.state, 'completed')
    assert.deepEqual(executedTools, [{
      name: 'get_weather',
      arguments: '{"city":"杭州"}',
      id: 'call-weather',
    }])
    assert.deepEqual(messagesByTurn[1], [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-weather',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"city":"杭州"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-weather',
        content: '晴，25°C',
      },
    ])
  })

  it('max-tokens 不标完成', async () => {
    const model = mockModel([
      { content: '回答因 token 上限被截断', finishReason: 'max-tokens' },
    ])

    const result = await runExecutionLoop(depsFor(model), [], { loop: false })

    assert.equal(result.state, 'interrupted')
    assert.equal(result.interrupted, true)
    assert.equal(result.content, '回答因 token 上限被截断')
  })

  it('工具失败状态真实', async () => {
    const model = mockModel([
      { toolCalls: [toolCall('failing_tool')], finishReason: 'tool_calls' },
      { content: '已记录工具失败', finishReason: 'stop' },
    ])
    const messagesByTurn: Array<Array<Record<string, unknown>>> = []
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []

    const result = await runExecutionLoop(
      {
        ...depsFor(model, async () => {
          throw new Error('工具炸了')
        }),
        buildRequest: (messages) => {
          messagesByTurn.push([...messages])
          return { provider: 'mock', model: 'm', messages: [...messages] }
        },
        onEvent: (type, payload) => events.push({ type, payload }),
      },
      [],
      { loop: false },
    )

    const toolEvent = events.find(({ type }) => type === 'execution.tool_completed')
    assert.equal(toolEvent?.payload.status, 'failed', '工具异常事件不得标记 completed')
    assert.equal(messagesByTurn[1]?.[1]?.content, '[tool_error] 工具炸了')
    assert.equal(result.state, 'completed')
    assert.equal(result.content, '已记录工具失败')
  })

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

  it('取消复查: 模型返回后（不协作）signal 中止 → cancelled', async () => {
    const ac = new AbortController();
    // 模拟不协作模型：忽略 request.signal，正常 resolve 后才被外部中止。
    // 若 execution-loop 缺少模型返回后的取消复查，该结果会被当作正常完成。
    const nonCooperative: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        ac.abort();
        return { content: '本应返回', finishReason: 'stop' } as ModelResponse;
      },
      async *stream(): AsyncIterable<StreamChunk> { return; },
    };
    const result = await runExecutionLoop(depsFor(nonCooperative), [], { loop: true, signal: ac.signal });
    assert.equal(result.state, 'cancelled');
    assert.equal(result.budgetExceeded, 'cancelled');
  });

  it('buildRequest 抛错 → state=failed（不裸抛）', async () => {
    const model = mockModel([{ content: '不应到达', finishReason: 'stop' }]);
    const deps = depsFor(model);
    deps.buildRequest = () => { throw new Error('request build boom'); };
    const result = await runExecutionLoop(deps, [], { loop: false });
    assert.equal(result.state, 'failed');
  });

  it('isTaskComplete 抛错 → state=failed（Loop 不默认放行）', async () => {
    const model = mockModel([{ content: '进度文本', finishReason: 'stop' }]);
    const deps = depsFor(model);
    deps.isTaskComplete = () => { throw new Error('evaluator boom'); };
    const result = await runExecutionLoop(deps, [], { loop: true });
    assert.equal(result.state, 'failed');
  });

  it('B1: 模型同时返回 interrupted 且 signal 中止 → cancelled', async () => {
    // Given
    const ac = new AbortController()
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        ac.abort()
        return {
          id: 'interrupted-response',
          provider: 'mock',
          model: 'm',
          content: '部分输出',
          finishReason: 'error',
          interrupted: true,
        }
      },
      async *stream(): AsyncIterable<StreamChunk> { return; },
    }

    // When
    const result = await runExecutionLoop(depsFor(model), [], { loop: false, signal: ac.signal })

    // Then
    assert.equal(result.state, 'cancelled')
    assert.equal(result.budgetExceeded, 'cancelled')
  })

  it('B1: signal 中止与时长预算同时成立 → cancelled', async () => {
    // Given
    const ac = new AbortController()
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        ac.abort()
        await new Promise(resolve => setTimeout(resolve, 10))
        return {
          id: 'slow-response',
          provider: 'mock',
          model: 'm',
          content: '慢响应',
          finishReason: 'stop',
        }
      },
      async *stream(): AsyncIterable<StreamChunk> { return; },
    }
    const budget = {
      ...normalExecutionBudget(),
      maxTurns: 0,
      maxToolCalls: 0,
      maxTimeMs: 1,
      maxTokens: 0,
      maxCostCny: 0,
    }

    // When
    const result = await runExecutionLoop(depsFor(model), [], { loop: false, signal: ac.signal, budget })

    // Then
    assert.equal(result.state, 'cancelled')
    assert.equal(result.budgetExceeded, 'cancelled')
  })

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

  // ============ §3.2 Loop 真实语义：verifying/continuing/完成判定 ============

  it('Loop verify: isTaskComplete=false → 继续下一轮（执行→验证→继续→完成）', async () => {
    // 第一轮无工具但有文本但判定"未完成"；第二轮给工具；第三轮完成
    const model = mockModel([
      { content: '我还在分析...', finishReason: 'stop' },
      { toolCalls: [toolCall('lookup')], finishReason: 'tool_calls' },
      { content: '最终结论：X', finishReason: 'stop' },
    ]);
    const result = await runExecutionLoop(
      {
        ...depsFor(model),
        isTaskComplete: (resp) => resp.content === '最终结论：X',
      },
      [],
      { loop: true },
    );
    assert.equal(result.state, 'completed');
    assert.equal(result.content, '最终结论：X');
    assert.equal(result.turnsUsed, 3, '第一轮判定未完成 → 应继续到第三轮');
  });

  it('Loop continuation: isTaskComplete 始终 false → 预算耗尽不伪造成功', async () => {
    const model = mockModel([{ content: '未完成', finishReason: 'stop' }]);
    const budget = { ...loopExecutionBudget(), maxTurns: 3, maxToolCalls: 0, maxTimeMs: 0, maxTokens: 0, maxCostCny: 0 };
    const result = await runExecutionLoop(
      {
        ...depsFor(model),
        isTaskComplete: () => false,
      },
      [],
      { loop: true, budget },
    );
    assert.equal(result.state, 'budget_exceeded');
    assert.equal(result.budgetExceeded, 'turns');
    assert.ok(result.content.includes('已达到最大轮数'), '未完成且预算耗尽 → finalization 说明停止原因');
  });

  it('Normal 不因 isTaskComplete 拖延：loop=false 时纯文本立即完成', async () => {
    const model = mockModel([{ content: '直接答案', finishReason: 'stop' }]);
    // 即使提供 isTaskComplete=false，Normal 模式也必须立即结束（不无意义继续）
    const result = await runExecutionLoop(
      {
        ...depsFor(model),
        isTaskComplete: () => false,
      },
      [],
      { loop: false },
    );
    assert.equal(result.state, 'completed');
    assert.equal(result.content, '直接答案');
    assert.equal(result.turnsUsed, 1);
  });

  it('B3: 单次模型调用成本未超限 → completed', async () => {
    // Given
    const model = mockModel([{
      content: '单次完成',
      finishReason: 'stop',
      usage: {
        inputTokens: 600_000,
        outputTokens: 400_000,
        totalTokens: 1_000_000,
      },
    }])
    const budget = {
      ...normalExecutionBudget(),
      maxTurns: 0,
      maxToolCalls: 0,
      maxTimeMs: 0,
      maxTokens: 0,
      maxCostCny: 1.5,
    }

    // When
    const result = await runExecutionLoop(depsFor(model), [], { loop: false, budget })

    // Then
    assert.equal(result.state, 'completed')
    assert.equal(result.content, '单次完成')
    assert.equal(result.budgetExceeded, 'none')
  })

  it('B3: 两次模型调用累计成本超限 → budget_exceeded=cost', async () => {
    // Given
    const usage = {
      inputTokens: 600_000,
      outputTokens: 400_000,
      totalTokens: 1_000_000,
    }
    const model = mockModel([
      { content: '继续', finishReason: 'stop', usage },
      { content: '完成', finishReason: 'stop', usage },
    ])
    const budget = {
      ...normalExecutionBudget(),
      maxTurns: 0,
      maxToolCalls: 0,
      maxTimeMs: 0,
      maxTokens: 0,
      maxCostCny: 1.5,
    }

    // When
    const result = await runExecutionLoop({
      ...depsFor(model),
      isTaskComplete: response => response.content === '完成',
    }, [], { loop: true, budget })

    // Then
    assert.equal(result.state, 'budget_exceeded')
    assert.equal(result.budgetExceeded, 'cost')
    assert.equal(result.turnsUsed, 2)
  })

  it('Loop timeout: maxTimeMs 预算 → budget_exceeded=duration', async () => {
    // 让模型调用真实耗时超过 maxTimeMs（同毫秒 elapsedMs=0 无法触发 duration）
    const slowModel: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        await new Promise(r => setTimeout(r, 15));
        return { id: 'slow', provider: 'mock', model: 'm', content: '慢响应', finishReason: 'stop' };
      },
      async *stream(): AsyncIterable<never> { return; },
    } as never;
    const budget = { ...loopExecutionBudget(), maxTurns: 0, maxToolCalls: 0, maxTimeMs: 5, maxTokens: 0, maxCostCny: 0 };
    const result = await runExecutionLoop(depsFor(slowModel), [], { loop: true, budget });
    assert.equal(result.state, 'budget_exceeded');
    assert.equal(result.budgetExceeded, 'duration');
  });

  it('Task Retry：前 8 次失败后成功，retry 不占用 turnsUsed 并发射 attempt/retry 事件', async () => {
    let modelCalls = 0
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        modelCalls += 1
        if (modelCalls <= 8) throw retryableFailure('temporary model failure')
        return {
          id: 'recovered',
          provider: 'mock',
          model: 'm',
          content: 'recovered after task retry',
          finishReason: 'stop',
        }
      },
      async *stream(): AsyncIterable<StreamChunk> { return },
    }

    const result = await runExecutionLoop({
      ...depsFor(model),
      onEvent: (type, payload) => events.push({ type, payload }),
    }, [{ role: 'user', content: 'original task' }], {
      loop: false,
      runId: 'run-task-retry',
      taskId: 'task-task-retry',
      retry: {
        taskMaxRetries: 8,
        baseDelayMs: 0,
        jitter: 0,
      },
    })

    assert.equal(result.state, 'completed')
    assert.equal(modelCalls, 9)
    assert.equal(result.turnsUsed, 1)
    const started = events.find((event) => event.type === 'attempt.started')
    const scheduled = events.find((event) => event.type === 'retry.scheduled')
    assert.equal(started?.payload.runId, 'run-task-retry')
    assert.equal(started?.payload.taskId, 'task-task-retry')
    assert.equal(started?.payload.maxAttempts, 9)
    assert.equal(scheduled?.payload.retryLayer, 'task')
    assert.equal(scheduled?.payload.attempt, 1)
  })

  it('Task Retry：重试全部失败进入 retry_exhausted 终态而不是 completed', async () => {
    let modelCalls = 0
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        modelCalls += 1
        throw retryableFailure('permanent task failure')
      },
      async *stream(): AsyncIterable<StreamChunk> { return },
    }

    const result = await runExecutionLoop(depsFor(model), [], {
      loop: false,
      retry: {
        taskMaxRetries: 8,
        baseDelayMs: 0,
        jitter: 0,
      },
    })

    assert.equal(result.state, 'failed')
    assert.equal(result.retryExhausted, true)
    assert.equal(result.terminalState, 'retry_exhausted')
    assert.notEqual(result.state, 'completed')
    assert.equal(result.turnsUsed, 1)
    assert.equal(modelCalls, 9)
  })

  it('Tool Retry：可重试工具耗尽 → 终态上抛（AEX-P0-005 不再升级为 Task Retry），成功工具仍不重复执行', async () => {
    let modelCalls = 0
    let successfulToolCalls = 0
    let flakyToolCalls = 0
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            id: 'tools-1',
            provider: 'mock',
            model: 'm',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'ok-tool', name: 'ok_tool', arguments: '{}' },
              { id: 'flaky-tool', name: 'flaky_tool', arguments: '{}' },
            ],
          }
        }
        if (modelCalls === 2) {
          return {
            id: 'tools-2',
            provider: 'mock',
            model: 'm',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'ok-tool', name: 'ok_tool', arguments: '{}' }],
          }
        }
        return {
          id: 'tools-3',
          provider: 'mock',
          model: 'm',
          content: 'done',
          finishReason: 'stop',
        }
      },
      async *stream(): AsyncIterable<StreamChunk> { return },
    }

    const result = await runExecutionLoop({
      ...depsFor(model, async (tool) => {
        if (tool.name === 'ok_tool') {
          successfulToolCalls += 1
          return 'cached result'
        }
        flakyToolCalls += 1
        throw new ToolError('temporary tool failure', {
          toolName: 'flaky_tool',
          code: 'NETWORK_ERROR',
          retryable: true,
        })
      }),
      // AEX-P0-006：声明副作用安全（可重放）才允许工具层自动重试
      classifyToolSideEffect: () => 'idempotent',
    }, [], {
      loop: false,
      retry: {
        taskMaxRetries: 1,
        toolMaxRetries: 3,
        baseDelayMs: 0,
        jitter: 0,
      },
    })

    // AEX-P0-005：工具层重试耗尽是终态信号（RetryExhaustedError.retryable=false），
    // 任务层不再从头重启；成功过的工具仍由 checkpoint 保证不重复执行
    assert.equal(result.state, 'failed')
    assert.equal(result.retryExhausted, true)
    assert.equal(modelCalls, 1)
    assert.equal(successfulToolCalls, 1)
    assert.equal(flakyToolCalls, 4)
    assert.equal(result.turnsUsed, 1)
  })

  it('Tool Retry：不可重试参数错误不自动重试，错误交给 Agent 处理', async () => {
    let modelCalls = 0
    let toolCalls = 0
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            id: 'invalid-tool-1',
            provider: 'mock',
            model: 'm',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'invalid-tool', name: 'invalid_tool', arguments: '{}' }],
          }
        }
        return {
          id: 'invalid-tool-2',
          provider: 'mock',
          model: 'm',
          content: 'agent handled invalid arguments',
          finishReason: 'stop',
        }
      },
      async *stream(): AsyncIterable<StreamChunk> { return },
    }

    const result = await runExecutionLoop({
      ...depsFor(model, async () => {
        toolCalls += 1
        throw new ToolError('invalid parameters', {
          toolName: 'invalid_tool',
          code: 'INVALID_INPUT',
          retryable: false,
        })
      }),
    }, [], { loop: false })

    assert.equal(result.state, 'completed')
    assert.equal(toolCalls, 1)
    assert.equal(modelCalls, 2)
  })

  it('Task Retry 保留原始历史并追加失败原因，不从头重发', async () => {
    const requestMessages: Array<Array<Record<string, unknown>>> = []
    let modelCalls = 0
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        modelCalls += 1
        if (modelCalls === 1) throw retryableFailure('retry with context')
        return {
          id: 'context-2',
          provider: 'mock',
          model: 'm',
          content: 'context preserved',
          finishReason: 'stop',
        }
      },
      async *stream(): AsyncIterable<StreamChunk> { return },
    }

    const result = await runExecutionLoop({
      ...depsFor(model),
      buildRequest: (messages) => {
        requestMessages.push([...messages])
        return { provider: 'mock', model: 'm', messages: [...messages] }
      },
    }, [{ role: 'user', content: 'keep this history' }], {
      loop: false,
      retry: { taskMaxRetries: 1, baseDelayMs: 0, jitter: 0 },
    })

    assert.equal(result.state, 'completed')
    assert.equal(requestMessages.length, 2)
    assert.deepEqual(requestMessages[0], [{ role: 'user', content: 'keep this history' }])
    assert.ok(requestMessages[1].some((message) => message.role === 'system'))
    assert.ok(requestMessages[1].some((message) => String(message.content).includes('retry with context')))
  })

  it('Retry 等待中 Stop 立即把 Loop 置为 cancelled', async () => {
    const model: ModelRuntime = {
      async complete(): Promise<ModelResponse> {
        throw retryableFailure('retryable failure')
      },
      async *stream(): AsyncIterable<StreamChunk> { return },
    }
    const abortController = new AbortController()
    const startedAt = Date.now()
    const promise = runExecutionLoop(depsFor(model), [], {
      loop: false,
      signal: abortController.signal,
      retry: { taskMaxRetries: 8, baseDelayMs: 1000, jitter: 0 },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    abortController.abort()
    const result = await promise
    assert.equal(result.state, 'cancelled')
    assert.equal(result.budgetExceeded, 'cancelled')
    assert.ok(Date.now() - startedAt < 500)
  })


  it('§3.1 流式路径: onChunk 转发 text-delta/reasoning/tool/usage/finish 且结果一致', async () => {
    const chunks: Array<StreamChunk> = [
      { type: 'block-start' as const, index: 0, blockType: 'text' as const },
      { type: 'text-delta' as const, index: 0, text: '天气' },
      { type: 'text-delta' as const, index: 0, text: '晴' },
      { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish' as const, reason: { kind: 'stop' as const } },
    ];
    const streamModel: ModelRuntime = {
      async complete(): Promise<ModelResponse> { throw new Error('should use stream'); },
      async *stream(): AsyncIterable<StreamChunk> {
        for (const c of chunks) yield c;
      },
    } as never;
    const forwarded: string[] = [];
    const result = await runExecutionLoop(
      {
        ...depsFor(streamModel),
        onChunk: (c) => forwarded.push(c.type),
      },
      [],
      { loop: false },
    );
    assert.equal(result.state, 'completed');
    assert.equal(result.content, '天气晴');
    assert.equal(result.usage.cumulativeOutputTokens, 5);
    assert.deepEqual(forwarded, ['block-start', 'text-delta', 'text-delta', 'usage', 'finish'], 'onChunk 应按序收到全部 chunk');
  });

  it('§3.1 流式路径: tool-call chunk 聚合为 toolCalls 并继续工具链', async () => {
    // 每轮调用 stream() 时返回对应轮次的 chunk（跨调用保持轮次状态）
    const perTurnChunks: Array<Array<StreamChunk>> = [
      [
        { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const, id: 'c1', name: 'search' },
        { type: 'tool-call-delta' as const, index: 0, argumentsDelta: '{"q":' },
        { type: 'tool-call-delta' as const, index: 0, argumentsDelta: '"x"}' },
        { type: 'block-end' as const, index: 0, block: { kind: 'tool-call' as const, id: 'c1', name: 'search', arguments: '{"q":"x"}' } },
        { type: 'finish' as const, reason: { kind: 'tool_calls' as const } },
      ],
      [
        { type: 'block-start' as const, index: 0, blockType: 'text' as const },
        { type: 'text-delta' as const, index: 0, text: '结果：1 条' },
        { type: 'finish' as const, reason: { kind: 'stop' as const } },
      ],
    ];
    let callIndex = 0;
    const streamModel: ModelRuntime = {
      async complete(): Promise<ModelResponse> { throw new Error('should use stream'); },
      async *stream(): AsyncIterable<StreamChunk> {
        const slice = perTurnChunks[Math.min(callIndex, perTurnChunks.length - 1)];
        callIndex++;
        for (const c of slice) yield c;
      },
    } as never;
    const executed: string[] = [];
    const result = await runExecutionLoop(
      {
        ...depsFor(streamModel, async (t) => { executed.push(t.name); return '1 条结果'; }),
        onChunk: () => {},
      },
      [],
      { loop: false },
    );
    assert.equal(result.state, 'completed');
    assert.equal(result.content, '结果：1 条');
    assert.deepEqual(executed, ['search'], '流式 tool-call 应聚合为工具调用并执行');
    assert.equal(result.toolCallCount, 1);
  });

  // ============ Phase 4：Loop 控制接线（缺省 evaluator / verdict 事件 / checkpoint） ============

  it('P4 缺省判定: 有文本但目标未完成（无产出证据）→ continue 而非立即完成', async () => {
    // Given
    const model = mockModel([
      { content: '我先梳理思路', finishReason: 'stop' },
      { toolCalls: [toolCall('collect_data')], finishReason: 'tool_calls' },
      { content: '结论：已完成调研', finishReason: 'stop' },
    ])

    // When
    const result = await runExecutionLoop(
      depsFor(model),
      [{ role: 'user', content: '调研并给出结论' }],
      { loop: true },
    )

    // Then
    assert.equal(result.turnsUsed, 3, '仅有进度文本、无完成证据 → 必须继续下一轮（不再"有文本即完成"）')
    assert.equal(result.state, 'completed')
    assert.equal(result.content, '结论：已完成调研')
  })

  it('P4 缺省判定: 无文本但已完成工具步骤（目标已满足）→ complete', async () => {
    // Given
    const model = mockModel([
      { toolCalls: [toolCall('write_report')], finishReason: 'tool_calls' },
      { content: '', finishReason: 'stop' },
    ])

    // When
    const result = await runExecutionLoop(
      depsFor(model),
      [{ role: 'user', content: '生成报告' }],
      { loop: true },
    )

    // Then
    assert.equal(result.state, 'completed')
    assert.equal(result.turnsUsed, 2)
    assert.equal(result.content, '', '目标已由工具产出满足 → 无文本也应判完成')
  })

  it('P4 needs_correction: 继续下一轮并把纠正指令注入消息历史', async () => {
    // Given
    const model = mockModel([
      { toolCalls: [toolCall('write_file')], finishReason: 'tool_calls' },
      { content: '已经写好了', finishReason: 'stop' },
    ])
    const requests: Array<Array<Record<string, unknown>>> = []
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const budget = { ...loopExecutionBudget(), maxTurns: 3, maxToolCalls: 0, maxTimeMs: 0, maxTokens: 0, maxCostCny: 0 }

    // When
    const result = await runExecutionLoop({
      ...depsFor(model, async () => { throw new Error('磁盘只读') }),
      buildRequest: (messages) => {
        requests.push([...messages])
        return { provider: 'mock', model: 'm', messages }
      },
      onEvent: (type, payload) => events.push({ type, payload }),
    }, [{ role: 'user', content: '写入文件' }], { loop: true, budget })

    // Then
    const lastRequest = requests.at(-1) ?? []
    assert.ok(
      lastRequest.some(message => typeof message.content === 'string' && message.content.includes('[task_correction]')),
      'needs_correction 必须把纠正指令注入下一轮消息历史',
    )
    assert.ok(
      events.some(event => event.type === 'execution.continuing' && event.payload.verdict === 'needs_correction'),
      '继续事件必须携带 needs_correction verdict',
    )
    assert.notEqual(result.state, 'completed', '工具失败后不得伪造完成')
  })

  it('P4 verifying 事件: payload 携带 evaluator verdict', async () => {
    // Given
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const model = mockModel([
      { content: '进展汇报', finishReason: 'stop' },
      { toolCalls: [toolCall('collect')], finishReason: 'tool_calls' },
      { content: '', finishReason: 'stop' },
    ])

    // When
    const result = await runExecutionLoop({
      ...depsFor(model),
      onEvent: (type, payload) => events.push({ type, payload }),
    }, [{ role: 'user', content: '完成目标' }], { loop: true })

    // Then
    const verdicts = events
      .filter(event => event.type === 'execution.verifying')
      .map(event => event.payload.verdict)
    assert.deepEqual(verdicts, ['continue', 'complete'], '每次进入 verifying 都要补发 evaluator verdict')
    assert.equal(result.state, 'completed')
  })

  it('P4 显式钩子只能收紧不能放宽：返回 true 仍需 evaluator 确认目标满足', async () => {
    // Given: 只有文本、没有任何产出证据
    const model = mockModel([{ content: '好的', finishReason: 'stop' }])
    const budget = { ...loopExecutionBudget(), maxTurns: 3, maxToolCalls: 0, maxTimeMs: 0, maxTokens: 0, maxCostCny: 0 }

    // When
    const result = await runExecutionLoop(
      { ...depsFor(model), isTaskComplete: () => true },
      [{ role: 'user', content: '目标' }],
      { loop: true, budget },
    )

    // Then: 钩子不能把"有文本"升级为完成
    assert.equal(result.state, 'budget_exceeded')
    assert.equal(result.turnsUsed, 3, '钩子返回 true 也必须经过 evaluator（无产出证据不得判完成）')
  })

  it('P4 显式钩子只能收紧：返回 false 时即使已有产出证据也继续下一轮', async () => {
    // Given: 工具已产出结果（evaluator 会判 complete），但钩子要求继续
    const model = mockModel([
      { toolCalls: [toolCall('write_report')], finishReason: 'tool_calls' },
      { content: '报告已生成', finishReason: 'stop' },
    ])
    const budget = { ...loopExecutionBudget(), maxTurns: 3, maxToolCalls: 0, maxTimeMs: 0, maxTokens: 0, maxCostCny: 0 }
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []

    // When
    const result = await runExecutionLoop({
      ...depsFor(model),
      isTaskComplete: () => false,
      onEvent: (type, payload) => events.push({ type, payload }),
    }, [{ role: 'user', content: '生成报告' }], { loop: true, budget })

    // Then
    assert.equal(result.state, 'budget_exceeded')
    assert.equal(result.turnsUsed, 3, '钩子返回 false → 强制继续，不被 evaluator 的 complete 覆盖')
    assert.ok(
      events.some(event => event.type === 'execution.verifying' && event.payload.reason === '调用方显式判定任务未完成'),
      'verifying 事件应反映钩子收紧结果',
    )
  })

  it('P4 显式钩子返回 true 且确有产出证据 → 与缺省 evaluator 一致判完成', async () => {
    // Given
    const model = mockModel([
      { toolCalls: [toolCall('write_report')], finishReason: 'tool_calls' },
      { content: '报告已生成', finishReason: 'stop' },
    ])

    // When
    const result = await runExecutionLoop(
      { ...depsFor(model), isTaskComplete: () => true },
      [{ role: 'user', content: '生成报告' }],
      { loop: true },
    )

    // Then
    assert.equal(result.state, 'completed')
    assert.equal(result.turnsUsed, 2, '钩子与 evaluator 一致时仍按证据判完成')
  })

  it('P4 checkpoint: 预算耗尽时生成并随结果返回（供 Retry 恢复）', async () => {
    // Given
    const model = mockModel([{ content: '仍在处理', finishReason: 'stop' }])
    const budget = { ...loopExecutionBudget(), maxTurns: 2, maxToolCalls: 0, maxTimeMs: 0, maxTokens: 0, maxCostCny: 0 }

    // When
    const result = await runExecutionLoop(
      depsFor(model),
      [{ role: 'user', content: '完成报告' }],
      { loop: true, budget, runId: 'run-budget-checkpoint' },
    )

    // Then
    const checkpoint = checkpointOf(result)
    assert.ok(checkpoint, '预算耗尽时必须返回最新 checkpoint')
    assert.equal(result.state, 'budget_exceeded')
    assert.equal(checkpoint?.runId, 'run-budget-checkpoint')
    assert.equal(checkpoint?.turn, 2)
    assert.equal(checkpoint?.currentObjective, '完成报告')
    assert.deepEqual(checkpoint?.pendingSteps, [])
  })

  it('P4 checkpoint: 取消时生成并随结果返回（供 Retry 恢复）', async () => {
    // Given
    const controller = new AbortController()
    const model = mockModel([{ toolCalls: [toolCall('read_file')], finishReason: 'tool_calls' }])
    const deps = depsFor(model, async (tool) => {
      controller.abort()
      return `ok:${tool.name}`
    })

    // When
    const result = await runExecutionLoop(
      deps,
      [{ role: 'user', content: '读取文件' }],
      { loop: true, signal: controller.signal, runId: 'run-cancel-checkpoint' },
    )

    // Then
    const checkpoint = checkpointOf(result)
    assert.equal(result.state, 'cancelled')
    assert.ok(checkpoint, '取消时必须返回最新 checkpoint')
    assert.equal(checkpoint?.turn, 1)
    assert.deepEqual(checkpoint?.completedSteps, ['read_file'])
    assert.equal(checkpoint?.toolResults.length, 1)
    assert.equal(checkpoint?.lastError, null)
  })

  it('P4 预算优先: 成本预算耗尽时即使目标已满足也不判完成', async () => {
    // Given
    const usage = { inputTokens: 600_000, outputTokens: 400_000, totalTokens: 1_000_000 }
    const model = mockModel([
      { toolCalls: [toolCall('prepare')], finishReason: 'tool_calls', usage },
      { content: '结论：已完成', finishReason: 'stop', usage },
    ])
    const budget = { ...loopExecutionBudget(), maxTurns: 0, maxToolCalls: 0, maxTimeMs: 0, maxTokens: 0, maxCostCny: 1.5 }

    // When
    const result = await runExecutionLoop(
      depsFor(model),
      [{ role: 'user', content: '完成分析' }],
      { loop: true, budget },
    )

    // Then
    assert.equal(result.state, 'budget_exceeded')
    assert.equal(result.budgetExceeded, 'cost')
    assert.ok(result.content.includes('费用预算耗尽'))
  })

  // ============ AEX-P0-001 生产接线守卫：wrapper 不得旁路完成判定 ============

  it('AEX-P0-006: 未声明副作用分级的工具（缺省 unknown）不自动重试', async () => {
    // Given: 可重试的工具错误，但调用方未声明 sideEffectClass
    let toolCalls = 0
    const model = mockModel([
      { toolCalls: [toolCall('side_effect_tool')], finishReason: 'tool_calls' },
      { content: '工具失败已上报', finishReason: 'stop' },
    ])

    // When
    const result = await runExecutionLoop({
      ...depsFor(model, async () => {
        toolCalls += 1
        throw new ToolError('temporary failure', {
          toolName: 'side_effect_tool',
          code: 'NETWORK_ERROR',
          retryable: true,
        })
      }),
    }, [], { loop: false })

    // Then: 错误交给下一轮模型处理，工具不被自动重放
    assert.equal(toolCalls, 1, 'unknown 副作用分级不得自动重试（防重复副作用）')
    assert.equal(result.state, 'completed')
    assert.equal(result.content, '工具失败已上报')
  })

  it('AEX-P0-001: 三个生产 wrapper 不再向 runExecutionLoop 注入内容型完成判据', () => {
    // 守卫针对已编译产物：任何 wrapper 重新注入 `isTaskComplete:` 属性都会失败
    const compiledModules = [
      '../../modules/conversations/tool-loop.js',
      '../../modules/agents/tool-loop.js',
      '../../modules/sync/command-processor.js',
    ]

    for (const relativePath of compiledModules) {
      const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url))
      const source = readFileSync(absolutePath, 'utf8')
      assert.ok(
        !source.includes('isTaskComplete:'),
        `${relativePath} 不得注入内容型完成判据（"有文本≠任务完成"，判定必须走 evaluateTaskCompletion）`,
      )
    }
  })
});
