import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { truncateHistoryByTokenBudget, estimateCharsPerToken, contentCharCount } from './context-window.js';

describe('context-window — CJK 字符/token 估算', () => {
  it('纯 ASCII 文本按 4 字符/token', () => {
    const rate = estimateCharsPerToken('hello world this is a test');
    assert.ok(rate >= 4, `expected ~4, got ${rate}`);
  });

  it('CJK 文本按更低字符/token（中文更密集）', () => {
    const rate = estimateCharsPerToken('人工智能正在改变世界').toString();
    assert.ok(parseFloat(rate) < 4, `expected <4 for CJK, got ${rate}`);
  });

  it('非字符串内容按 200 字符计', () => {
    assert.equal(contentCharCount(undefined), 200);
    assert.equal(contentCharCount(123), 200);
    assert.equal(contentCharCount('abc'), 3);
  });
});

describe('context-window — token 预算截断', () => {
  const mk = (id: number, content: string) => ({ id, role: 'user' as const, content });

  it('预算充足时不截断', () => {
    const hist = [mk(1, 'a'), mk(2, 'b')];
    const out = truncateHistoryByTokenBudget(hist, 1000000, 0.75);
    assert.equal(out.length, 2);
  });

  it('预算不足时从最早消息截断', () => {
    const hist = [
      mk(1, 'x'.repeat(2000)),
      mk(2, 'x'.repeat(2000)),
      mk(3, 'x'.repeat(2000)),
      mk(4, 'x'.repeat(2000)),
      mk(5, 'x'.repeat(2000)),
      mk(6, 'x'.repeat(2000)),
    ];
    // 预算极小 → 必须截断但保持 ≥ minKeep(5)
    const out = truncateHistoryByTokenBudget(hist, 10, 0.75, 5);
    assert.ok(out.length <= hist.length, '应发生截断');
    assert.ok(out.length >= 5, '保底保留 5 条');
    // 保底 5 条时移除的是最早消息
    assert.equal(out[0].id, 2, '最早消息被移除');
  });

  it('默认 minKeep=5 且不修改入参数组', () => {
    const hist = [mk(1, 'a'), mk(2, 'b')];
    const snapshot = hist.slice();
    truncateHistoryByTokenBudget(hist, 1000000, 0.75);
    assert.deepEqual(hist, snapshot, '入参不被修改');
  });

  it('空历史返回空', () => {
    assert.deepEqual(truncateHistoryByTokenBudget([], 1000000, 0.75), []);
  });
});