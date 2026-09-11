/**
 * VerificationEngine — Aether 2.0 客观任务验证引擎（P0-31）
 *
 * 目标：任务不能在未经验证的情况下进入 completed（P0-34）。
 * VerificationEngine 是「客观检查层」—— 独立于执行者（Hephaestus/Builder），
 * 用真实的工具链（TypeCheck / Lint / Tests / LSP / 静态风险扫描）验证代码变更，
 * 输出 { passed, score, findings }。
 *
 * 设计：
 * - 输入：runId / taskId / changedFiles / goal / 可选 cwd
 * - 检查项可注入（VerificationExecutor 接口），核心引擎为纯逻辑（可单测）
 * - 输出：passed（无 critical + 无 unresolved high + score ≥ 阈值）、score、findings
 * - 与 SelfCorrectionEngine（P0-32）配合：verify → fail → diagnose → correct → reverify
 *
 * Transport-agnostic：无 Fastify/SSE/React 依赖。
 */

// ============================================================================
// 类型
// ============================================================================

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingCategory =
  | 'logic'          // 逻辑错误（空指针/竞态/错误分支）
  | 'type'           // 类型错误
  | 'lint'           // 风格/死代码（unused/any）
  | 'test'           // 测试失败
  | 'security'       // 安全（注入/越权/密钥泄漏/SSRF）
  | 'performance'    // 性能（O(n²)/未缓存的循环）
  | 'correctness'    // 行为正确性（结果不符合目标）
  | 'maintainability'; // 可维护性

export interface Finding {
  severity: FindingSeverity;
  category: FindingCategory;
  file: string;
  message: string;
  code?: string;          // 可选的错误码（如 tsc 错误号）
  line?: number;
  resolved?: boolean;     // 后续轮次是否已修复
}

/** 单个检查项结果 */
export interface VerificationCheck {
  name: 'typecheck' | 'lint' | 'tests' | 'lsp' | 'security' | 'behavior';
  passed: boolean;
  summary: string;
  findings: Finding[];
  durationMs: number;
}

/** VerificationEngine 输出 */
export interface VerificationResult {
  passed: boolean;          // no critical + no unresolved high + score ≥ threshold
  score: number;            // 0-100
  checks: VerificationCheck[];
  findings: Finding[];
  summarizedAt: string;
}

// ============================================================================
// 执行器接口（生产实现注入：真实 tsc/eslint/vitest/lsp；测试注入 mock）
// ============================================================================

export interface VerificationRunInput {
  runId?: string;
  taskId?: string;
  goal: string;              // 任务目标（判断行为正确性）
  changedFiles: string[];    // 本次任务修改的文件
  cwd?: string;              // 工作目录（项目根）
}

export interface TypeCheckResult { ok: boolean; findings: Finding[]; summary: string }
export interface LintResult { ok: boolean; findings: Finding[]; summary: string }
export interface TestResult { ok: boolean; findings: Finding[]; summary: string; total?: number; passed?: number }
export interface LspResult { ok: boolean; findings: Finding[]; summary: string }
export interface SecurityScanResult { ok: boolean; findings: Finding[]; summary: string }
export interface BehaviorCheckResult { ok: boolean; findings: Finding[]; summary: string }

/** 每个检查项的注入执行器 */
export interface VerificationExecutors {
  typecheck: (input: VerificationRunInput) => Promise<TypeCheckResult>;
  lint: (input: VerificationRunInput) => Promise<LintResult>;
  tests: (input: VerificationRunInput) => Promise<TestResult>;
  lsp?: (input: VerificationRunInput) => Promise<LspResult>;
  securityScan?: (input: VerificationRunInput) => Promise<SecurityScanResult>;
  behavior?: (input: VerificationRunInput) => Promise<BehaviorCheckResult>;
}

// ============================================================================
// 评分与门禁
// ============================================================================

export const VERIFICATION_PASS_SCORE = 80;

export const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 40,
  high: 20,
  medium: 8,
  low: 3,
  info: 0,
};

function severityRank(s: FindingSeverity): number {
  return { critical: 5, high: 4, medium: 3, low: 2, info: 1 }[s];
}

/** 是否存在未解决的 critical/high 问题（门禁判定） */
export function hasBlockingFindings(findings: Finding[]): boolean {
  return findings.some(f => !f.resolved && severityRank(f.severity) >= 4);
}

/** 计算 0-100 分数（满分减权重；重复文件/类别不重复扣） */
export function computeScore(findings: Finding[], base = 100): number {
  let penalty = 0;
  for (const f of findings) {
    if (f.resolved) continue;
    penalty += SEVERITY_WEIGHT[f.severity] ?? 0;
  }
  return Math.max(0, Math.min(base, base - penalty));
}

/** 按严重度排序（critical → info） */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

// ============================================================================
// VerificationEngine — 纯逻辑编排（执行器注入）
// ============================================================================

export class VerificationEngine {
  #executors: VerificationExecutors;

  constructor(executors: VerificationExecutors) {
    this.#executors = executors;
  }

  /**
   * 运行完整验证：TypeCheck → Lint → Tests → LSP → Security → Behavior。
   * 每个检查项独立执行；单项失败不中断后续（收集全部发现）。
   */
  async verify(input: VerificationRunInput): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const allFindings: Finding[] = [];

    const runCheck = async (
      name: VerificationCheck['name'],
      fn: () => Promise<{ ok: boolean; findings: Finding[]; summary: string }>,
    ): Promise<void> => {
      const started = Date.now();
      try {
        const r = await fn();
        checks.push({ name, passed: r.ok, summary: r.summary, findings: r.findings, durationMs: Date.now() - started });
        allFindings.push(...r.findings);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        checks.push({
          name, passed: false, summary: `执行异常: ${msg}`,
          findings: [{ severity: 'critical', category: 'logic', file: '', message: msg, code: 'CHECK_EXEC_FAILED' }],
          durationMs: Date.now() - started,
        });
        allFindings.push({ severity: 'critical', category: 'logic', file: '', message: msg, code: 'CHECK_EXEC_FAILED' });
      }
    };

    await runCheck('typecheck', () => this.#executors.typecheck(input));
    await runCheck('lint', () => this.#executors.lint(input));
    await runCheck('tests', () => this.#executors.tests(input));
    if (this.#executors.lsp) await runCheck('lsp', () => this.#executors.lsp!(input));
    if (this.#executors.securityScan) await runCheck('security', () => this.#executors.securityScan!(input));
    if (this.#executors.behavior) await runCheck('behavior', () => this.#executors.behavior!(input));

    const sorted = sortFindings(allFindings);
    const score = Math.round(computeScore(sorted));
    const passed = !hasBlockingFindings(sorted) && score >= VERIFICATION_PASS_SCORE;

    return {
      passed,
      score,
      checks,
      findings: sorted,
      summarizedAt: new Date().toISOString(),
    };
  }
}

/** 便捷：构建 VerificationEngine（executors 必填） */
export function createVerificationEngine(executors: VerificationExecutors): VerificationEngine {
  return new VerificationEngine(executors);
}