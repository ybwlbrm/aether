/**
 * SelfCorrectionEngine — Aether 2.0 自我纠错闭环（P0-32/P0-33/P0-34/P0-35）
 *
 * 完整流程：Plan → Execute → Verify → Review → Diagnose → Correct → Re-Verify → Quality Gate
 * 最大 5 轮。每轮保存 round / failure / diagnosis / changes / test result / review result / decision。
 *
 * 设计要点：
 * - 避免「AI 自己给自己打满分」（P0-33）：
 *   * Builder（执行变更）与 Verifier（客观检查，VerificationEngine）分离
 *   * Reviewer（独立审查）与 Final Judge（独立裁决）由调用方注入不同的执行器
 * - 任务不能在没有 Verification 的情况下进入 completed（P0-34）：
 *   * 只有 verify.passed=true 且 review approved 且 CompletionPolicy 通过才返回 DONE
 * - Quality Gate（P0-35）：CompletionPolicy 检查全部条件
 *
 * Transport-agnostic：无 Fastify/SSE/React 依赖。执行能力全部注入。
 */

import { type VerificationResult } from './verification-engine.js';

// ============================================================================
// 类型
// ============================================================================

export type CorrectionDecision = 'done' | 'correct' | 'fail';

export interface CorrectionRound {
  round: number;                     // 第几轮（1-based）
  failure?: string;                  // 本轮发现的失败描述（verify/review 摘要）
  diagnosis?: string;                // 诊断
  changes?: string[];                // 本轮变更（文件列表或描述）
  testResult?: VerificationResult;   // verify 结果
  reviewResult?: {
    approved: boolean;
    comments?: string[];
  };
  decision: CorrectionDecision;      // done / correct（继续） / fail（放弃）
  decisionReason?: string;
  executedAt: string;
}

export interface SelfCorrectionInput {
  runId?: string;
  taskId?: string;
  goal: string;
  context?: string;                  // 任务上下文 / 需求描述
}

export interface SelfCorrectionResult {
  status: 'done' | 'failed';         // done = 质量门禁通过；failed = 轮次耗尽或裁判否决
  rounds: CorrectionRound[];
  finalVerification?: VerificationResult;
  reason?: string;
  finishedAt: string;
}

/** Builder 执行器：执行一轮修复并返回变更描述 */
export interface BuilderExecutor {
  execute(input: SelfCorrectionInput, diagnosis: string, context?: string): Promise<{
    changes: string[];
    failureHint?: string;
  }>;
}

/** Verifier 执行器：客观检查（由 VerificationEngine 提供） */
export interface VerifierExecutor {
  verify(input: SelfCorrectionInput & { changedFiles: string[] }): Promise<VerificationResult>;
}

/** Reviewer 执行器：独立审查找问题（Momus 角色） */
export interface ReviewerExecutor {
  review(input: SelfCorrectionInput & { verification: VerificationResult; changes: string[] }): Promise<{
    approved: boolean;
    comments?: string[];
    failure?: string;
  }>;
}

/** Diagnoser 执行器：根据失败/审查评论给出诊断与修复建议（Oracle 角色） */
export interface DiagnoserExecutor {
  diagnose(input: SelfCorrectionInput, failure: string, verification?: VerificationResult): Promise<{
    diagnosis: string;
  }>;
}

/** Final Judge 执行器：最终裁决（最高权威，避免 Builder 自评分） */
export interface FinalJudgeExecutor {
  judge(input: SelfCorrectionInput & { verification: VerificationResult; rounds: CorrectionRound[] }): Promise<{
    approved: boolean;
    reason?: string;
  }>;
}

export interface SelfCorrectionEngineOptions {
  builder: BuilderExecutor;
  verifier: VerifierExecutor;
  reviewer: ReviewerExecutor;
  diagnose: DiagnoserExecutor;
  finalJudge?: FinalJudgeExecutor;   // 可选；缺省用 verify+review 结果裁决
  maxRounds?: number;                // 默认 5
  changedFilesResolver?: (input: SelfCorrectionInput) => Promise<string[]>;
}

// ============================================================================
// CompletionPolicy（P0-35 质量门禁）
// ============================================================================

export interface CompletionPolicyState {
  verification?: VerificationResult;
  reviewApproved?: boolean;
  pendingToolCalls?: boolean;
  activeCorrectionRound?: boolean;
  unreviewedModifications?: boolean;
}

/**
 * P0-35: 质量门禁 —— 未满足任一条件，completed 不得发出。
 * 最低要求：No critical errors / No unresolved high / Relevant tests passed /
 * No unreviewed modifications / No pending tool calls / No active correction round。
 */
export function evaluateCompletionPolicy(state: CompletionPolicyState): {
  canComplete: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];

  if (!state.verification) {
    blockers.push('缺少验证结果（Verification 未运行）');
  } else {
    if (state.verification.findings.some(f => !f.resolved && (f.severity === 'critical' || f.severity === 'high'))) {
      blockers.push('存在未解决的 critical/high 严重问题');
    }
    const testsCheck = state.verification.checks.find(c => c.name === 'tests');
    if (testsCheck && !testsCheck.passed) {
      blockers.push('相关测试未通过');
    }
  }

  if (state.reviewApproved !== true) {
    blockers.push('审查未通过（Review 未批准）');
  }

  if (state.unreviewedModifications) {
    blockers.push('存在未经审查的修改');
  }

  if (state.pendingToolCalls) {
    blockers.push('存在待处理的工具调用');
  }

  if (state.activeCorrectionRound) {
    blockers.push('存在进行中的纠错轮次');
  }

  return { canComplete: blockers.length === 0, blockers };
}

// ============================================================================
// SelfCorrectionEngine
// ============================================================================

export const DEFAULT_MAX_ROUNDS = 5;

export class SelfCorrectionEngine {
  #builder: BuilderExecutor;
  #verifier: VerifierExecutor;
  #reviewer: ReviewerExecutor;
  #diagnoser: DiagnoserExecutor;
  #finalJudge?: FinalJudgeExecutor;
  #maxRounds: number;
  #changedFilesResolver: (input: SelfCorrectionInput) => Promise<string[]>;

  constructor(options: SelfCorrectionEngineOptions) {
    this.#builder = options.builder;
    this.#verifier = options.verifier;
    this.#reviewer = options.reviewer;
    this.#diagnoser = options.diagnose;
    this.#finalJudge = options.finalJudge;
    this.#maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.#changedFilesResolver = options.changedFilesResolver ?? (async () => []);
  }

  get maxRounds(): number {
    return this.#maxRounds;
  }

  /**
   * 运行完整自我纠错闭环。最多 5 轮：
   * 每轮 Builder 执行 → Verifier 客观检查 → Reviewer 独立审查 →
   * 通过 → Quality Gate → done；未通过 → Diagnoser → 下一轮修复。
   */
  async run(input: SelfCorrectionInput): Promise<SelfCorrectionResult> {
    const rounds: CorrectionRound[] = [];
    let failure = '初始执行';

    for (let round = 1; round <= this.#maxRounds; round++) {
      // 1. Builder 执行（首轮 = 初始实现；后续轮 = 修复）
      let changes: string[] = [];
      try {
        const built = await this.#builder.execute(input, round === 1 ? '' : failure, input.context);
        changes = built.changes;
        if (built.failureHint) failure = built.failureHint;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        rounds.push({
          round, failure: msg, decision: 'fail',
          decisionReason: `Builder 执行异常: ${msg}`,
          executedAt: new Date().toISOString(),
        });
        return { status: 'failed', rounds, reason: `第 ${round} 轮 Builder 失败: ${msg}`, finishedAt: new Date().toISOString() };
      }

      // 2. Verifier 客观检查（VerificationEngine —— 非 Builder 自评）
      const changedFiles = changes.length > 0 ? changes : await this.#changedFilesResolver(input);
      let verification: VerificationResult;
      try {
        verification = await this.#verifier.verify({ ...input, changedFiles });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        rounds.push({
          round, failure: msg, changes, decision: 'fail',
          decisionReason: `Verifier 执行异常: ${msg}`,
          executedAt: new Date().toISOString(),
        });
        return { status: 'failed', rounds, reason: `第 ${round} 轮 Verifier 失败: ${msg}`, finishedAt: new Date().toISOString() };
      }

      // 3. Reviewer 独立审查（Momus 角色 —— 专门找问题）
      let reviewResult: { approved: boolean; comments?: string[]; failure?: string };
      try {
        reviewResult = await this.#reviewer.review({ ...input, verification, changes });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        reviewResult = { approved: false, comments: [], failure: `Reviewer 异常: ${msg}` };
      }

      let reviewApproved = reviewResult.approved && verification.passed;
      let roundFailure = reviewResult.failure ?? (reviewApproved ? undefined : (verification.findings[0]?.message ?? '验证未通过'));

      rounds.push({
        round,
        failure: roundFailure,
        changes,
        testResult: verification,
        reviewResult,
        decision: reviewApproved ? 'done' : 'correct',
        executedAt: new Date().toISOString(),
      });

      // 4. Final Judge（可选最高权威；避免 Builder 自评分）
      if (this.#finalJudge && reviewApproved) {
        const judged = await this.#finalJudge.judge({ ...input, verification, rounds });
        if (!judged.approved) {
          reviewApproved = false;
          roundFailure = judged.reason ?? 'Final Judge 未通过';
          const last = rounds[rounds.length - 1];
          last.decision = 'correct';
          last.decisionReason = `Final Judge 否决: ${judged.reason ?? ''}`;
          last.failure = roundFailure;
        }
      }

      // 5. 通过 → 质量门禁
      if (reviewApproved) {
        const gate = evaluateCompletionPolicy({
          verification,
          reviewApproved: true,
          unreviewedModifications: false,
          pendingToolCalls: false,
          activeCorrectionRound: false,
        });
        if (gate.canComplete) {
          const last = rounds[rounds.length - 1];
          last.decision = 'done';
          return {
            status: 'done',
            rounds,
            finalVerification: verification,
            finishedAt: new Date().toISOString(),
          };
        }
        // 门禁未过 → 记录并继续下一轮
        const last = rounds[rounds.length - 1];
        last.decision = 'correct';
        last.decisionReason = `质量门禁未通过: ${gate.blockers.join('; ')}`;
      }

      // 6. 诊断（Oracle 角色）→ 下一轮修复
      if (round < this.#maxRounds) {
        try {
          const { diagnosis } = await this.#diagnoser.diagnose(input, roundFailure ?? '', verification);
          const last = rounds[rounds.length - 1];
          last.diagnosis = diagnosis;
          failure = diagnosis || roundFailure || '继续修正';
        } catch {
          failure = roundFailure ?? '继续修正';
        }
      }
    }

    return {
      status: 'failed',
      rounds,
      reason: `达到最大纠错轮次（${this.#maxRounds}），仍未通过验证`,
      finishedAt: new Date().toISOString(),
    };
  }
}

/** 便捷工厂 */
export function createSelfCorrectionEngine(options: SelfCorrectionEngineOptions): SelfCorrectionEngine {
  return new SelfCorrectionEngine(options);
}