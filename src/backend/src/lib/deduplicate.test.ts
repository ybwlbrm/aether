import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dedupToolResultReplacement, applyToolResultDedup } from './deduplicate.js';

describe('deduplicate — 工具结果去重', () => {
  it('AI 回复与工具结果完全一致 → 短提示替换', () => {
    const repl = dedupToolResultReplacement('{"x":1}', '{"x":1}');
    assert.equal(repl, '✅ 分析完成，结果请查看上方的「工具执行结果」。');
  });

  it('AI 回复包含工具结果前 60 字符且工具结果 ≥60 → 完整结果提示', () => {
    const longResult = 'A'.repeat(100);
    const repl = dedupToolResultReplacement('开头' + longResult.slice(0, 60) + '后续', longResult);
    assert.equal(repl, '✅ 分析完成，完整结果请查看上方的「工具执行结果」。');
  });

  it('AI 回复与原工具结果不同（结合实际内容）→ 不替换', () => {
    const repl = dedupToolResultReplacement('AI 分析结论：数据正常', '{"x":1}');
    assert.equal(repl, null);
  });

  it('无工具结果 → 不替换', () => {
    assert.equal(dedupToolResultReplacement('anything', null), null);
    assert.equal(dedupToolResultReplacement('anything', undefined), null);
  });

  it('空 AI 回复 → 不替换', () => {
    assert.equal(dedupToolResultReplacement('', 'tool'), null);
    assert.equal(dedupToolResultReplacement('   ', 'tool'), null);
  });

  it('applyToolResultDedup 便捷包装：未命中返回原文', () => {
    assert.equal(applyToolResultDedup('原始文本', 'tool-result'), '原始文本');
  });
});