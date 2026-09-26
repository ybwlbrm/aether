/**
 * SelfCorrectionEngine tests (P0-32/P0-33/P0-34/P0-35)
 *
 * 覆盖：
 * - 一次通过：Builder → Verify(PASS) → Review(ok) → Gate → done（1 轮）
 * - 修复闭环：首轮 Verify FAIL → Diagnose → 次轮 PASS → done（2 轮）
 * - 轮次耗尽：持续失败 → failed（maxRounds 后停止）
 * - Builder 异常 → failed
 * - Verifier 异常 → failed
 * - Review 否决但 Verify PASS → 继续纠正（不误判完成）
 * - Final Judge 否决 → 继续纠正（避免 Builder 自评分）
 * - CompletionPolicy：缺验证/有 high/critical → 阻塞 completed
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSelfCorrectionEngine,
  evaluateCompletionPolicy,
  type SelfCorrectionEngineOptions,
  type SelfCorrectionInput,
  type BuilderExecutor,
  type VerifierExecutor,
  type ReviewerExecutor,
  type DiagnoserExecutor,
  type FinalJudgeExecutor,
} from './self-correction-engine.js';
import type { VerificationResult } from './verification-engine.js';

const baseInput = { goal: '实现 add 函数', context: 'add(a,b) 返回 a+b' };

function okVerification(): VerificationResult {
  return {
    passed: true,
    score: 100,
    checks: [
      { name: 'typecheck', passed: true, summary: 'ok', findings: [], durationMs: 1 },
      { name: 'lint', passed: true, summary: 'ok', findings: [], durationMs: 1 },
      { name: 'tests', passed: true, summary: 'ok', findings: [], durationMs: 1 },
    ],
    findings: [],
    summarizedAt: new Date().toISOString(),
  };
}

function failVerification(severity: 'critical' | 'high' | 'medium' = 'critical'): VerificationResult {
  return {
    passed: false,
    score: 40,
    checks: [
      { name: 'typecheck', passed: true, summary: 'ok', findings: [], durationMs: 1 },
      { name: 'lint', passed: true, summary: 'ok', findings: [], durationMs: 1 },
      { name: 'tests', passed: false, summary: '1 failed', findings: [{ severity: 'critical', category: 'test', file: 'a.test.ts', message: 'expected 2 got 1' }], durationMs: 1 },
    ],
    findings: [{ severity, category: 'test', file: 'a.test.ts', message: 'expected 2 got 1' }],
    summarizedAt: new Date().toISOString(),
  };
}

function buildOptions(overrides: {
  verifyResults?: Array<VerificationResult>;
  reviewApproved?: boolean;
  judgeApproved?: boolean;
  builderThrow?: boolean;
  verifierThrow?: boolean;
  reviewComments?: string[];
} = {}): SelfCorrectionEngineOptions {
  const verifyQueue = [...(overrides.verifyResults ?? [okVerification()])];
  const builder: BuilderExecutor = {
    execute: async () => {
      if (overrides.builderThrow) throw new Error('builder crashed');
      return { changes: ['src/add.ts'] };
    },
  };
  const verifier: VerifierExecutor = {
    verify: async () => {
      if (overrides.verifierThrow) throw new Error('verifier crashed');
      return verifyQueue.shift() ?? okVerification();
    },
  };
  const reviewer: ReviewerExecutor = {
    review: async () => ({
      approved: overrides.reviewApproved ?? true,
      comments: overrides.reviewComments ?? ['reviewed'],
    }),
  };
  const diagnose: DiagnoserExecutor = {
    diagnose: async (_input: SelfCorrectionInput, failure: string) => ({ diagnosis: `修复: ${failure}` }),
  };
  const finalJudge: FinalJudgeExecutor | undefined = overrides.judgeApproved !== undefined
    ? { judge: async () => ({ approved: overrides.judgeApproved!, reason: overrides.judgeApproved ? undefined : '裁判否决' }) }
    : undefined;
  return { builder, verifier, reviewer, diagnose, ...(finalJudge ? { finalJudge } : {}) };
}

describe('core/verification/self-correction-engine (P0-32)', () => {
  it('一次通过：Builder → Verify(PASS) → Review(ok) → Gate → done（1 轮）', async () => {
    const engine = createSelfCorrectionEngine(buildOptions());
    const result = await engine.run(baseInput);
    assert.equal(result.status, 'done');
    assert.equal(result.rounds.length, 1);
    assert.equal(result.rounds[0].decision, 'done');
  });

  it('修复闭环：首轮 Verify FAIL → Diagnose → 次轮 PASS → done（2 轮）', async () => {
    const engine = createSelfCorrectionEngine(buildOptions({
      verifyResults: [failVerification(), okVerification()],
    }));
    const result = await engine.run(baseInput);
    assert.equal(result.status, 'done');
    assert.equal(result.rounds.length, 2);
    assert.equal(result.rounds[0].decision, 'correct');
    assert.equal(result.rounds[1].decision, 'done');
    assert.ok(result.rounds[0].diagnosis, '首轮应产生诊断');
  });

  it('轮次耗尽：持续失败 → failed（maxRounds 后停止）', async () => {
    const engine = createSelfCorrectionEngine(buildOptions({
      verifyResults: [failVerification(), failVerification(), failVerification(), failVerification(), failVerification(), failVerification()],
    }));
    const result = await engine.run(baseInput);
    assert.equal(result.status, 'failed');
    assert.equal(result.rounds.length, 5, '最多 5 轮');
    assert.ok(/最大纠错轮次/.test(result.reason ?? ''));
  });

  it('Builder 异常 → failed', async () => {
    const engine = createSelfCorrectionEngine(buildOptions({ builderThrow: true }));
    const result = await engine.run(baseInput);
    assert.equal(result.status, 'failed');
  });

  it('Verifier 异常 → failed', async () => {
    const engine = createSelfCorrectionEngine(buildOptions({ verifierThrow: true }));
    const result = await engine.run(baseInput);
    assert.equal(result.status, 'failed');
  });

  it('Review 否决但 Verify PASS → 继续纠正（不误判完成）', async () => {
    const engine = createSelfCorrectionEngine(buildOptions({
      reviewApproved: false,
      verifyResults: [okVerification(), okVerification()],
    }));
    const result = await engine.run(baseInput);
    // Verify 通过但 Review 否决 → 不 done，继续纠正
    assert.notEqual(result.status === 'done' && result.rounds[0].decision === 'done', true);
    assert.equal(result.rounds[0].decision, 'correct', 'review 否决后不应立即 done');
  });

  it('Final Judge 否决 → 继续纠正（避免 Builder 自评分）', async () => {
    const engine = createSelfCorrectionEngine(buildOptions({
      verifyResults: [okVerification(), okVerification()],
      judgeApproved: false,
    }));
    const result = await engine.run(baseInput);
    assert.equal(result.rounds[0].decision, 'correct', 'Final Judge 否决后不应 done');
    assert.ok(result.rounds[0].decisionReason?.includes('否决'), '应记录否决原因');
  });
});

describe('core/verification/completion-policy (P0-35)', () => {
  it('全部条件满足 → canComplete=true', () => {
    const r = evaluateCompletionPolicy({
      verification: okVerification(),
      reviewApproved: true,
      unreviewedModifications: false,
      pendingToolCalls: false,
      activeCorrectionRound: false,
    });
    assert.equal(r.canComplete, true);
    assert.equal(r.blockers.length, 0);
  });

  it('缺少验证结果 → 阻塞', () => {
    const r = evaluateCompletionPolicy({ reviewApproved: true });
    assert.equal(r.canComplete, false);
    assert.ok(r.blockers.some(b => /Validation|验证/.test(b)));
  });

  it('存在未解决 critical/high → 阻塞', () => {
    const v = failVerification('critical');
    const r = evaluateCompletionPolicy({ verification: v, reviewApproved: true });
    assert.equal(r.canComplete, false);
    assert.ok(r.blockers.some(b => /critical|high/.test(b)));
  });

  it('审查未通过 → 阻塞', () => {
    const r = evaluateCompletionPolicy({ verification: okVerification(), reviewApproved: false });
    assert.equal(r.canComplete, false);
  });

  it('测试未通过 → 阻塞', () => {
    const v = failVerification('critical');
    const r = evaluateCompletionPolicy({ verification: v, reviewApproved: true });
    assert.ok(r.blockers.some(b => /测试/.test(b)));
  });

  it('存在待处理工具调用 / 进行中纠错轮次 → 阻塞', () => {
    const r1 = evaluateCompletionPolicy({ verification: okVerification(), reviewApproved: true, pendingToolCalls: true });
    assert.equal(r1.canComplete, false);
    const r2 = evaluateCompletionPolicy({ verification: okVerification(), reviewApproved: true, activeCorrectionRound: true });
    assert.equal(r2.canComplete, false);
  });
});