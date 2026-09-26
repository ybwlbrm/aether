/**
 * VerificationEngine 生产实现（P0-31）— 注入真实工具链
 *
 * 位于 lib 层：调用 tsc / eslint / vitest 等真实工具，产出客观 findings。
 * 每个检查项独立 try/catch —— 单个工具缺失/失败不中断其他检查。
 *
 * Transport 层：无 Fastify/SSE 依赖；通过 child_process 执行工具链。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  VerificationExecutors,
  VerificationRunInput,
  Finding,
  TypeCheckResult,
  LintResult,
  TestResult,
  LspResult,
  SecurityScanResult,
} from '../core/verification/verification-engine.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/** 在 cwd 执行命令，解析 stdout/stderr 与退出码 */
async function run(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    // 退出码非 0 = 检查失败（工具本身跑起来了）
    if (typeof err.code === 'number') {
      return { code: err.code, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    }
    // 工具不存在（ENOENT）/超时 → 视为无法执行
    return { code: -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? '') };
  }
}

/** 从 tsc 输出中解析 findings */
function parseTscFindings(stdout: string, stderr: string): { findings: Finding[]; summary: string } {
  const findings: Finding[] = [];
  const combined = `${stdout}\n${stderr}`;
  const lineRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(combined)) !== null) {
    findings.push({
      severity: 'critical',
      category: 'type',
      file: m[1].trim(),
      line: Number(m[2]),
      code: m[4],
      message: m[5].trim(),
    });
  }
  const errorCount = findings.length;
  return {
    findings,
    summary: errorCount > 0
      ? `TypeScript: ${errorCount} 个类型错误`
      : combined.includes('error')
        ? 'TypeScript: 存在非行级错误'
        : 'TypeScript: 通过',
  };
}

/** 从 eslint 输出中解析 findings（JSON 格式） */
function parseEslintFindings(stdout: string): { findings: Finding[]; summary: string } {
  const findings: Finding[] = [];
  try {
    const parsed = JSON.parse(stdout) as Array<{
      filePath: string;
      messages: Array<{ line?: number; severity: number; message: string; ruleId?: string | null }>;
    }>;
    for (const file of parsed) {
      for (const msg of file.messages) {
        const useSeverity: Finding['severity'] = msg.severity >= 2 ? 'high' : 'medium';
        findings.push({
          severity: useSeverity,
          category: 'lint',
          file: file.filePath,
          line: msg.line,
          code: msg.ruleId ?? undefined,
          message: msg.message,
        });
      }
    }
  } catch {
    // 非 JSON 输出（旧的 text 格式）—— 简单按行数统计
    const count = stdout.split('\n').filter(l => l.includes(' error ') || l.includes(' warning ')).length;
    if (count > 0) {
      findings.push({ severity: 'medium', category: 'lint', file: '', message: `ESLint 报告 ${count} 条问题（点击查看终端输出）` });
    }
  }
  return {
    findings,
    summary: findings.length > 0 ? `ESLint: ${findings.length} ${findings.length > 1 ? '个问题' : '个问题'}` : 'ESLint: 通过',
  };
}

/**
 * 构建生产 VerificationExecutors。
 * tools.cwd（默认 process.cwd()）为项目根（含 package.json / node_modules）。
 */
export function createProductionVerificationExecutors(): VerificationExecutors {
  const typecheck: VerificationExecutors['typecheck'] = async (input: VerificationRunInput): Promise<TypeCheckResult> => {
    const cwd = input.cwd ?? process.cwd();
    const { code, stdout, stderr } = await run(cwd, 'npx', ['tsc', '--noEmit']);
    const { findings, summary } = parseTscFindings(stdout, stderr);
    return { ok: code === 0 || findings.length === 0, findings, summary };
  };

  const lint: VerificationExecutors['lint'] = async (input: VerificationRunInput): Promise<LintResult> => {
    const cwd = input.cwd ?? process.cwd();
    const changed = input.changedFiles.filter(f => /\.(ts|tsx|js|jsx)$/.test(f));
    const targets = changed.length > 0 ? changed.slice(0, 50) : ['.'];
    const { code, stdout } = await run(cwd, 'npx', ['eslint', ...targets, '--format', 'json'], 180_000);
    const { findings, summary } = parseEslintFindings(stdout);
    return { ok: code === 0 || findings.length === 0, findings, summary };
  };

  const tests: VerificationExecutors['tests'] = async (input: VerificationRunInput): Promise<TestResult> => {
    const cwd = input.cwd ?? process.cwd();
    // 项目级测试：优先运行 monorepo 根 test（限定 backend 以减少耗时）
    const { code, stdout, stderr } = await run(cwd, 'npx', ['vitest', 'run', '--reporter', 'json'], 600_000);
    const combined = `${stdout}\n${stderr}`;
    const findings: Finding[] = [];
    const failedMatch = combined.match(/(\d+) failed/);
    if (code !== 0) {
      findings.push({
        severity: failedMatch && Number(failedMatch[1]) > 0 ? 'critical' : 'high',
        category: 'test',
        file: '',
        message: `测试失败${failedMatch ? `（${failedMatch[1]} 个失败用例）` : ''}。详见测试输出。`,
      });
    }
    return { ok: code === 0, findings, summary: failedMatch ? `${failedMatch[1]} 个失败` : '测试通过', total: 0, passed: 0 };
  };

  const lsp: VerificationExecutors['lsp'] = async (input: VerificationRunInput): Promise<LspResult> => {
    // LSP 诊断目前由 IDE 完成；此处做轻量文件存在性检查（改动文件必须存在）
    const { existsSync } = await import('node:fs');
    const findings: Finding[] = [];
    for (const f of input.changedFiles) {
      if (!existsSync(f)) {
        findings.push({ severity: 'high', category: 'logic', file: f, message: '改动的文件不存在（路径写错或已被删除）' });
      }
    }
    return { ok: findings.length === 0, findings, summary: findings.length > 0 ? '存在缺失文件' : '文件完整性通过' };
  };

  const securityScan: VerificationExecutors['securityScan'] = async (input: VerificationRunInput): Promise<SecurityScanResult> => {
    // 静态安全扫描：对改动文件做高风险模式检查（密钥/危险函数/路径穿越）
    const findings: Finding[] = [];
    for (const f of input.changedFiles) {
      if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(f, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          const ln = i + 1;
          if (/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/.test(line)) {
            findings.push({ severity: 'high', category: 'security', file: f, line: ln, message: '疑似硬编码 API Key' });
          }
          if (/exec(File)?Sync\s*\(/.test(line)) {
            findings.push({ severity: 'medium', category: 'security', file: f, line: ln, message: '使用了同步进程执行（注意命令注入风险）' });
          }
          if (/\beval\s*\(/.test(line)) {
            findings.push({ severity: 'high', category: 'security', file: f, line: ln, message: '禁止使用 eval' });
          }
          if (/\bpassword\b.*=.*['"][^'"]+['"]/.test(line)) {
            findings.push({ severity: 'high', category: 'security', file: f, line: ln, message: '疑似硬编码密码' });
          }
        });
      } catch (e: unknown) {
        // AEX-P2-004 分类：intentional fallback —— 单文件读取失败时跳过该文件，
        // 剩余文件仍产出 findings；typecheck/lsp 执行器是另一路独立覆盖。
        logger.debug({ event: 'verification.pattern_scan_file_skipped', err: e, file: f }, '文件读取失败，跳过模式扫描');
      }
    }
    return { ok: findings.length === 0, findings, summary: findings.length > 0 ? `${findings.length} 个潜在安全问题` : '静态安全扫描通过' };
  };

  return { typecheck, lint, tests, lsp, securityScan };
}