/**
 * 安全条件求值（WF-001 / P0-28）
 *
 * 背景：workflow condition 节点仅支持 truthy/equals/contains 且依赖字符串化比较，
 * 无法表达数值比较、前后缀、存在性等常见分支。本模块提供 13 种操作符的安全求值，
 * 全部为纯函数实现 —— 绝不使用 eval / new Function。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, CONDITION_OPERATORS } from './condition.js';

describe('evaluateCondition — 13 operators (WF-001)', () => {
  test('equals / not_equals', () => {
    assert.equal(evaluateCondition('equals', 'deepseek', 'deepseek'), true);
    assert.equal(evaluateCondition('equals', 'DeepSeek', 'deepseek'), false);
    assert.equal(evaluateCondition('not_equals', 'a', 'b'), true);
    assert.equal(evaluateCondition('not_equals', 'a', 'a'), false);
  });

  test('contains', () => {
    assert.equal(evaluateCondition('contains', 'aether runtime', 'runtime'), true);
    assert.equal(evaluateCondition('contains', 'aether', 'zzz'), false);
  });

  test('starts_with / ends_with', () => {
    assert.equal(evaluateCondition('starts_with', 'https://api.deepseek.com', 'https://'), true);
    assert.equal(evaluateCondition('starts_with', 'ftp://x', 'https://'), false);
    assert.equal(evaluateCondition('ends_with', 'file.ts', '.ts'), true);
    assert.equal(evaluateCondition('ends_with', 'file.txt', '.ts'), false);
  });

  test('truthy / falsy（含常见字符串假值）', () => {
    assert.equal(evaluateCondition('truthy', 'hello'), true);
    assert.equal(evaluateCondition('truthy', ''), false);
    assert.equal(evaluateCondition('truthy', 'false'), false);
    assert.equal(evaluateCondition('truthy', '0'), false);
    assert.equal(evaluateCondition('falsy', ''), true);
    assert.equal(evaluateCondition('falsy', 'false'), true);
    assert.equal(evaluateCondition('falsy', 'hello'), false);
  });

  test('数值比较（字符串化输入转为数值）', () => {
    assert.equal(evaluateCondition('greater_than', '500', '100'), true);
    assert.equal(evaluateCondition('greater_than', '1', '2'), false);
    assert.equal(evaluateCondition('less_than', '1', '2'), true);
    assert.equal(evaluateCondition('less_than', '5', '2'), false);
    assert.equal(evaluateCondition('greater_or_equal', '2', '2'), true);
    assert.equal(evaluateCondition('greater_or_equal', '3', '2'), true);
    assert.equal(evaluateCondition('greater_or_equal', '1', '2'), false);
    assert.equal(evaluateCondition('less_or_equal', '2', '2'), true);
    assert.equal(evaluateCondition('less_or_equal', '1', '2'), true);
    assert.equal(evaluateCondition('less_or_equal', '3', '2'), false);
  });

  test('数值比较对非数字输入返回 false（不 NaN 崩溃）', () => {
    assert.equal(evaluateCondition('greater_than', 'abc', '100'), false);
    assert.equal(evaluateCondition('less_than', '', '2'), false);
  });

  test('exists / not_exists', () => {
    assert.equal(evaluateCondition('exists', 'value'), true);
    assert.equal(evaluateCondition('exists', ''), false);
    assert.equal(evaluateCondition('exists', null), false);
    assert.equal(evaluateCondition('not_exists', null), true);
    assert.equal(evaluateCondition('not_exists', 'x'), false);
  });

  test('未知操作符回退 Boolean(value)（保持旧行为兼容）', () => {
    assert.equal(evaluateCondition('unknown-op', 'hello'), true);
    assert.equal(evaluateCondition('unknown-op', ''), false);
  });

  test('操作符清单完整（13 个）', () => {
    assert.deepEqual(CONDITION_OPERATORS, [
      'equals', 'not_equals', 'contains', 'starts_with', 'ends_with',
      'truthy', 'falsy', 'greater_than', 'less_than',
      'greater_or_equal', 'less_or_equal', 'exists', 'not_exists',
    ]);
  });
});