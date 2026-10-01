import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb } from '../../db/client.js';
// P0-31: VerificationEngine（AI Task Verification 层）—— 与 System Health 分离的双层自检
import { createVerificationEngine } from '../../core/verification/verification-engine.js';
import { createProductionVerificationExecutors } from '../../lib/verification-engine.js';
// P0-32: SelfCorrectionEngine（自我纠错闭环）
import { createSelfCorrectionEngine, type SelfCorrectionInput } from '../../core/verification/self-correction-engine.js';
import { buildRuntimeForProvider } from '../../lib/model-runtime-bridge.js';
// 诉求3「一键修复」：步骤批次执行器 + 合法步骤 id 清单
import { findStepId, runRepairSteps } from './repair-steps.js';
// System Health 报告构建（GET /api/selfcheck 与 POST /api/selfcheck/repair 共用同一份）
import { buildSelfCheckReport } from './selfcheck-report.js';

export function registerSelfCheckRoutes(app: FastifyInstance, config: BackendConfig): void {

  // P1-30/P0-31: AI Task Verification 层 —— 对一次任务（runId/taskId + changedFiles + goal）
  // 执行客观验证（TypeCheck/Lint/Tests/LSP/Security/Behavior），输出 { passed, score, findings }。
  // 与下方的 System Health 自检（/api/selfcheck）分层：这是"任务是否正确"的验证器。
  app.post('/api/selfcheck/verify', {
    schema: {
      description: 'AI 任务验证（P0-31：TypeCheck/Lint/Tests/LSP/Security 客观检查）',
      tags: ['自检'],
      body: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          taskId: { type: 'string' },
          goal: { type: 'string' },
          changedFiles: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      runId?: string;
      taskId?: string;
      goal?: string;
      changedFiles?: string[];
      cwd?: string;
    };
    if (!Array.isArray(body?.changedFiles) || body.changedFiles.length === 0) {
      return reply.code(400).send({ error: { message: 'changedFiles 必须是非空数组（至少一个改动文件）' } });
    }

    const engine = createVerificationEngine(createProductionVerificationExecutors());
    const result = await engine.verify({
      runId: body.runId,
      taskId: body.taskId,
      goal: body.goal ?? '',
      changedFiles: body.changedFiles,
      cwd: body.cwd || process.cwd(),
    });

    // 任务验证未通过 → 不能进入 completed（P0-34：tool succeeded ≠ task succeeded）
    if (!result.passed) {
      reply.code(422).send({ ok: false, ...result });
      return;
    }
    return { ok: true, ...result };
  });

  // P0-32: 自我纠错闭环端点 —— 对一次失败任务执行
  // Builder(LLM 诊断修复) → Verify(VerificationEngine) → Review → Diagnose → Correct → Re-Verify
  // 最大 5 轮；只有通过质量门禁才返回 done。
  app.post('/api/selfcheck/correct', {
    schema: {
      description: 'AI 自我纠错（P0-32：Builder/Verifier/Reviewer 分离，最大 5 轮，质量门禁）',
      tags: ['自检'],
      body: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          taskId: { type: 'string' },
          goal: { type: 'string' },
          context: { type: 'string' },
          changedFiles: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      runId?: string;
      taskId?: string;
      goal?: string;
      context?: string;
      changedFiles?: string[];
      cwd?: string;
    };
    if (!body?.goal) {
      return reply.code(400).send({ error: { message: 'goal 必填' } });
    }

    // Builder 执行器：调用 LLM 生成修复方案（基于诊断与验证结果）
    const verifier = createVerificationEngine(createProductionVerificationExecutors());
    const builder = {
      async execute(input: SelfCorrectionInput, diagnosis: string, context?: string) {
        // 冷静一步：从 providers 表找可用 text provider 做 LLM 诊断+修复建议
        let advice = diagnosis || '请根据目标重新实现';
        try {
          const runtime = buildRuntimeForProvider(getDb(), 'sisyphus', config.encryptionKey);
          if (runtime) {
            const resp = await runtime.runtime.complete({
              provider: runtime.config.type,
              model: runtime.config.defaultModel,
              messages: [{
                role: 'user',
                content: `你是代码修复执行者（Hephaestus）。\n目标: ${input.goal}\n上下文: ${context ?? ''}\n\n当前诊断/失败: ${diagnosis || '未知'}\n\n请给出具体修复意见（文件路径 + 修改方向，不要写完整代码）。`,
              }],
              maxTokens: 500,
              temperature: 0,
            });
            advice = `${diagnosis ? `诊断: ${diagnosis}\n` : ''}修复建议: ${resp.content.trim()}`;
          }
        } catch (e: unknown) {
          console.warn('[SelfCorrection] LLM 修复建议失败，使用诊断兜底:',
            e instanceof Error ? e.message : String(e));
        }
        // changedFiles 由调用方提供；本轮「变更」为修复建议文本
        return { changes: body.changedFiles ?? [], failureHint: undefined };
      },
    };

    const reviewer = {
      async review(input: SelfCorrectionInput & { verification: import('../../core/verification/verification-engine.js').VerificationResult }) {
        const critical = input.verification.findings.filter(f => !f.resolved && (f.severity === 'critical' || f.severity === 'high'));
        if (critical.length > 0) {
          return { approved: false, failure: `验证发现 ${critical.length} 个严重问题，需继续修复` };
        }
        if (!input.verification.passed) {
          return { approved: false, failure: `验证未通过 score=${input.verification.score}` };
        }
        return { approved: true, comments: [] };
      },
    };

    const diagnose = {
      async diagnose(input: SelfCorrectionInput, failure: string, verification?: import('../../core/verification/verification-engine.js').VerificationResult) {
        const first = verification?.findings[0];
        const detail = first ? `${first.file || ''}: ${first.message}` : failure;
        return { diagnosis: `第 ${failure ? 'N' : '1'} 轮失败: ${detail}` };
      },
    };

    const engine = createSelfCorrectionEngine({
      builder,
      verifier: { verify: verifier.verify.bind(verifier) },
      reviewer,
      diagnose,
      maxRounds: 5,
    });

    const result = await engine.run({
      runId: body.runId,
      taskId: body.taskId,
      goal: body.goal,
      context: body.context,
    });

    if (result.status !== 'done') {
      reply.code(422).send({ ok: false, ...result });
      return;
    }
    return { ok: true, ...result };
  });

// 运行 AI 自检（System Health 层）—— 报告构建见 selfcheck-report.ts（POST /repair 复用同一份）
  app.get('/api/selfcheck', {
    schema: { description: '运行 AI 自检，检查项目完整性', tags: ['自检'] },
  }, async () => buildSelfCheckReport(config));

  // 诉求3「一键修复」：执行修复步骤批次，回传逐条结果 + 修复后的自检报告。
  // steps 省略 → 跑全部步骤；给出则只跑指定 id，未知 id 直接 400（不静默忽略，避免前端以为修过了）。
  app.post('/api/selfcheck/repair', {
    schema: {
      description: '一键修复（P0-35：落盘/孤立数据/陈旧Run/缓存/同步监听恢复）',
      tags: ['自检'],
      body: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { steps?: string[] } | undefined;
    const stepIds = Array.isArray(body?.steps) ? body.steps : undefined;
    if (stepIds !== undefined) {
      // 用 findStepId 解析（连字符/下划线等价 + db_flush 等别名），与 runRepairSteps 内部一致；
      // 未知 id 直接 400，绝不静默忽略（避免前端以为修过了）。
      const unknown = stepIds.filter(id => findStepId(id) === null);
      if (unknown.length > 0) {
        return reply.code(400).send({ error: { message: `未知的修复步骤: ${unknown.join(', ')}` } });
      }
    }

    const steps = await runRepairSteps({ config }, stepIds);
    return {
      timestamp: new Date().toISOString(),
      summary: {
        total: steps.length,
        fixed: steps.filter(s => s.outcome === 'fixed').length,
        alreadyHealthy: steps.filter(s => s.outcome === 'already-healthy').length,
        skipped: steps.filter(s => s.outcome === 'skipped').length,
        failed: steps.filter(s => s.outcome === 'failed').length,
      },
      steps,
      // 修复后立刻回传同一份自检报告，前端可在同一次响应里刷新健康度而无需二次请求
      selfcheck: await buildSelfCheckReport(config),
    };
  });
}

export { buildSelfCheckReport } from './selfcheck-report.js';
export type { SelfCheckItem, SelfCheckReport } from './selfcheck-report.js';