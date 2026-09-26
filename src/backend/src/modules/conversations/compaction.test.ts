/**
 * AEX-P0-003 — 工具循环结束后的「补文本」决策
 *
 * 缺陷：chat-handler 用三段重复的 `!aiContent && !aiError` 内联条件分别决定
 * ①是否发起隐藏的 executeForceSummary 模型调用 ②是否填「✅ 处理完成（工具调用已执行）」
 * ③是否填「处理完成（无文本输出）」。三处条件各自演化，预算耗尽（budgetExceeded）
 * 从未进入任何一处判断 —— 规范要求 budget_exceeded / cancelled / interrupted / failed
 * 一律不得触发隐藏模型调用，也不得伪造「处理完成」文案。
 *
 * 修法：把决策收敛成一个纯函数 resolveTextFallback（唯一事实源），
 * 三处消费点全部由它驱动，禁止再出现内联副本。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTextFallback } from './compaction.js';

describe('AEX-P0-003 resolveTextFallback', () => {
  it('预算耗尽 + 无文本 → budget-notice（禁止隐藏模型调用）', () => {
    assert.equal(
      resolveTextFallback({
        endedNormally: false,
        executionEndReason: 'completed',
        budgetExceeded: 'turns',
        aiContent: '',
        aiError: null,
      }),
      'budget-notice',
    );
  });

  it('预算耗尽的各种 kind 都不得降级为 force-summary', () => {
    for (const kind of ['turns', 'duration', 'tokens', 'tool_calls', 'cost'] as const) {
      assert.notEqual(
        resolveTextFallback({
          endedNormally: false,
          executionEndReason: 'completed',
          budgetExceeded: kind,
          aiContent: '',
          aiError: null,
        }),
        'force-summary',
        `预算耗尽(${kind}) 不得触发隐藏模型调用`,
      );
    }
  });

  it('预算耗尽 + 已有文本 → none（保留执行循环的结构化停止说明，不覆盖）', () => {
    assert.equal(
      resolveTextFallback({
        endedNormally: false,
        executionEndReason: 'completed',
        budgetExceeded: 'turns',
        aiContent: '⚠️ 已达到最大轮数（已执行 8 轮、8 次工具调用）。',
        aiError: null,
      }),
      'none',
    );
  });

  it('正常结束但无文本（非预算耗尽）→ force-summary', () => {
    assert.equal(
      resolveTextFallback({
        endedNormally: false,
        executionEndReason: 'completed',
        budgetExceeded: null,
        aiContent: '',
        aiError: null,
      }),
      'force-summary',
    );
  });

  it('取消 → none（不得补文本，也不得发起模型调用）', () => {
    assert.equal(
      resolveTextFallback({
        endedNormally: false,
        executionEndReason: 'cancelled',
        budgetExceeded: null,
        aiContent: '',
        aiError: null,
      }),
      'none',
    );
  });

  it('中断 / 失败 → force-summary 之外的分支由 aiError 拦截；无错误信息时走 force-summary', () => {
    assert.equal(
      resolveTextFallback({
        endedNormally: false,
        executionEndReason: 'interrupted',
        budgetExceeded: null,
        aiContent: '',
        aiError: '回答被截断',
      }),
      'none',
      '已有真实错误信息时不得伪造任何兜底文案',
    );
    assert.equal(
      resolveTextFallback({
        endedNormally: false,
        executionEndReason: 'error',
        budgetExceeded: null,
        aiContent: '',
        aiError: null,
      }),
      'force-summary',
    );
  });

  it('已正常完成 / 已有文本 → none', () => {
    assert.equal(
      resolveTextFallback({
        endedNormally: true,
        executionEndReason: 'completed',
        budgetExceeded: null,
        aiContent: '已有回答',
        aiError: null,
      }),
      'none',
    );
    assert.equal(
      resolveTextFallback({
        endedNormally: true,
        executionEndReason: 'completed',
        budgetExceeded: null,
        aiContent: '',
        aiError: null,
      }),
      'none',
    );
  });
});
