/**
 * VerificationEngine tests (P0-31)
 *
 * 覆盖：
 * - 纯逻辑：computeScore / hasBlockingFindings / sortFindings
 * - 编排：全部通过 → passed=true
 * - 编排：存在未解决 high/critical → passed=false
 * - 编排：单项执行器抛异常 → 不中断其他检查
 * - 可选执行器：lsp/securityScan 不注入时不执行
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VerificationEngine,
  computeScore,
  hasBlockingFindings,
  sortFindings,
  createVerificationEngine,
  type Finding,
  type VerificationExecutors,
  type VerificationRunInput,
} from './verification-engine.js';

const baseInput: VerificationRunInput = {
  goal: '实现 add 函数',
  changedFiles: ['src/add.ts'],
  cwd: '/tmp/proj',
};

function okExecutors(overrides: Partial<VerificationExecutors> = {}): VerificationExecutors {
  return {
    typecheck: async () => ({ ok: true, findings: [], summary: 'tsc ok' }),
    lint: async () => ({ ok: true, findings: [], summary: 'lint ok' }),
    tests: async () => ({ ok: true, findings: [], summary: 'tests ok' }),
    lsp: async () => ({ ok: true, findings: [], summary: 'lsp ok' }),
    securityScan: async () => ({ ok: true, findings: [], summary: 'sec ok' }),
    ...overrides,
  };
}

describe('core/verification/verification-engine (P0-31)', () => {
  describe('纯逻辑', () => {
    it('computeScore: 无发现问题 = 100', () => {
      assert.equal(computeScore([]), 100);
    });

    it('computeScore: high 减 20，critical 减 40', () => {
      const f: Finding[] = [
        { severity: 'high', category: 'logic', file: 'a.ts', message: 'x' },
        { severity: 'critical', category: 'type', file: 'b.ts', message: 'y' },
      ];
      assert.equal(computeScore(f), 40);
    });

    it('computeScore: 已 resolved 的问题不扣分', () => {
      const f: Finding[] = [{ severity: 'critical', category: 'logic', file: 'a.ts', message: 'x', resolved: true }];
      assert.equal(computeScore(f), 100);
    });

    it('computeScore: 不下溢为负', () => {
      const f: Finding[] = [
        { severity: 'critical', category: 'logic', file: 'a', message: '1' },
        { severity: 'critical', category: 'type', file: 'b', message: '2' },
        { severity: 'critical', category: 'type', file: 'c', message: '3' },
      ];
      assert.ok(computeScore(f) >= 0);
    });

    it('hasBlockingFindings: critical/high 未解决 = 阻断', () => {
      assert.equal(hasBlockingFindings([{ severity: 'high', category: 'logic', file: 'a', message: 'x' }]), true);
      assert.equal(hasBlockingFindings([{ severity: 'critical', category: 'type', file: 'a', message: 'x' }]), true);
    });

    it('hasBlockingFindings: medium/low/info 不阻断；resolved 不阻断', () => {
      assert.equal(hasBlockingFindings([{ severity: 'medium', category: 'lint', file: 'a', message: 'x' }]), false);
      assert.equal(hasBlockingFindings([{ severity: 'critical', category: 'logic', file: 'a', message: 'x', resolved: true }]), false);
    });

    it('sortFindings: critical 排在 high 前', () => {
      const sorted = sortFindings([
        { severity: 'high', category: 'logic', file: 'b', message: 'h' },
        { severity: 'critical', category: 'type', file: 'a', message: 'c' },
      ]);
      assert.equal(sorted[0].severity, 'critical');
    });
  });

  describe('编排', () => {
    it('全部检查通过 → passed=true, score=100', async () => {
      const engine = createVerificationEngine(okExecutors());
      const result = await engine.verify(baseInput);
      assert.equal(result.passed, true);
      assert.equal(result.score, 100);
      assert.equal(result.checks.length, 5, 'typecheck/lint/tests/lsp/security 全部执行');
    });

    it('存在未解决 high 类型错误 → passed=false', async () => {
      const engine = createVerificationEngine(okExecutors({
        typecheck: async () => ({
          ok: false,
          findings: [{ severity: 'critical', category: 'type', file: 'src/add.ts', message: 'TS2322: 类型不匹配', code: 'TS2322' }],
          summary: 'tsc 1 error',
        }),
      }));
      const result = await engine.verify(baseInput);
      assert.equal(result.passed, false);
      assert.ok(result.score < 100);
      assert.ok(result.findings.length >= 1);
      assert.equal(result.checks.find((c) => c.name === 'typecheck')?.passed, false);
    });

    it('测试失败 → passed=false，且其他检查仍执行', async () => {
      const engine = createVerificationEngine(okExecutors({
        tests: async () => ({
          ok: false,
          findings: [{ severity: 'critical', category: 'test', file: '', message: '1 failed' }],
          summary: '1 failed',
        }),
      }));
      const result = await engine.verify(baseInput);
      assert.equal(result.passed, false);
      assert.equal(result.checks.length, 5, '测试失败不中断其他检查');
      assert.equal(result.checks.filter((c) => c.passed).length, 4);
    });

    it('单个执行器抛异常 → 记为 critical 但不中断其他检查', async () => {
      const engine = createVerificationEngine(okExecutors({
        lint: async () => { throw new Error('eslint binary missing'); },
      }));
      const result = await engine.verify(baseInput);
      assert.equal(result.passed, false);
      assert.equal(result.checks.find((c) => c.name === 'lint')?.passed, false);
      assert.equal(result.checks.length, 5, 'lint 异常不影响其他检查');
      assert.equal(result.checks.filter((c) => c.passed).length, 4);
    });

    it('可选执行器（lsp/securityScan）不注入时不执行', async () => {
      const engine = createVerificationEngine({
        typecheck: async () => ({ ok: true, findings: [], summary: 'tsc ok' }),
        lint: async () => ({ ok: true, findings: [], summary: 'lint ok' }),
        tests: async () => ({ ok: true, findings: [], summary: 'tests ok' }),
      });
      const result = await engine.verify(baseInput);
      assert.equal(result.checks.length, 3);
      assert.equal(result.passed, true);
    });

    it('lint 问题为 medium（不阻断）但 score 下降，passed 仍可通过（分数没低于阈值）', async () => {
      const engine = createVerificationEngine(okExecutors({
        lint: async () => ({
          ok: false,
          findings: [{ severity: 'medium', category: 'lint', file: 'src/add.ts', message: 'no-unused-vars' }],
          summary: '1 warning',
        }),
      }));
      const result = await engine.verify(baseInput);
      // medium 不阻断 → score 92 > 80 → passed
      assert.equal(result.passed, true);
      assert.equal(result.score, 92);
    });
  });
});