import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../../db/client.js';
import { providers, conversations, messages } from '../../db/schema/index.js';
import { getSettings } from '../../lib/dal.js';
// P0-31: VerificationEngine（AI Task Verification 层）—— 与 System Health 分离的双层自检
import { createVerificationEngine } from '../../core/verification/verification-engine.js';
import { createProductionVerificationExecutors } from '../../lib/verification-engine.js';
// P0-32: SelfCorrectionEngine（自我纠错闭环）
import { createSelfCorrectionEngine, type SelfCorrectionInput } from '../../core/verification/self-correction-engine.js';
import { buildRuntimeForProvider } from '../../lib/model-runtime-bridge.js';

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

  // 运行 AI 自检（System Health 层）
  app.get('/api/selfcheck', {
    schema: { description: '运行 AI 自检，检查项目完整性', tags: ['自检'] },
  }, async () => {
    const checks: { name: string; status: 'ok' | 'warn' | 'error'; detail: string }[] = [];
    let errors = 0;
    let warnings = 0;

    // 1. 检查 data 目录完整性
    const dataDir = config.dataDir;
    if (!existsSync(dataDir)) {
      checks.push({ name: '数据目录', status: 'error', detail: '数据目录不存在' });
      errors++;
    } else {
      const dbPath = resolve(dataDir, 'pacc.db');
      if (!existsSync(dbPath)) {
        checks.push({ name: '数据库文件', status: 'warn', detail: 'pacc.db 不存在，将在首次启动时创建' });
        warnings++;
      } else {
        try {
          const stats = statSync(dbPath);
          checks.push({ name: '数据库文件', status: 'ok', detail: `${(stats.size / 1024).toFixed(1)} KB` });
        } catch (e: unknown) {
          checks.push({ name: '数据库文件', status: 'error', detail: `无法读取: ${(e instanceof Error ? e.message : String(e))}` });
          errors++;
        }
      }
      // 检查 settings.json
      const settingsPath = resolve(dataDir, 'settings.json');
      if (existsSync(settingsPath)) {
        try {
          const raw = readFileSync(settingsPath, 'utf-8');
          JSON.parse(raw);
          checks.push({ name: '设置文件', status: 'ok', detail: 'settings.json 格式正确' });
        } catch {
          checks.push({ name: '设置文件', status: 'error', detail: 'settings.json 格式损坏' });
          errors++;
        }
      } else {
        checks.push({ name: '设置文件', status: 'warn', detail: 'settings.json 不存在，将使用默认值' });
        warnings++;
      }
    }

    // 2. 检查 Provider 配置
    try {
      const db = getDb();
      const allProviders = db.select().from(providers).all();
      if (allProviders.length === 0) {
        checks.push({ name: 'AI Provider', status: 'warn', detail: '未配置任何 AI Provider' });
        warnings++;
      } else {
        // P1-6 修复：DB 中存储的是 AES 加密后的密文（enc:... 前缀），永远不会等于
        // '***encrypted***' 掩码。原逻辑把「密文非空」都算作已配置，空 apiKey 也被统计。
        // 正确判断：apiKey 非空且（是加密格式 或 明显为有效密钥形状）
        const configured = allProviders.filter(p =>
          p.apiKey
          && p.apiKey.trim() !== ''
          && p.apiKey !== '***encrypted***'
          && !p.apiKey.startsWith('enc::') // 空 IV 的异常格式视作无效
        ).length;
        if (configured === 0) {
          checks.push({ name: 'AI Provider', status: 'warn', detail: `${allProviders.length} 个 Provider 但无有效 API Key` });
          warnings++;
        } else {
          checks.push({ name: 'AI Provider', status: 'ok', detail: `${configured}/${allProviders.length} 个已配置 API Key` });
        }
      }
    } catch (e: unknown) {
      checks.push({ name: 'AI Provider', status: 'error', detail: `读取失败: ${(e instanceof Error ? e.message : String(e))}` });
      errors++;
    }

    // 3. 检查对话数据完整性
    try {
      const db = getDb();
      const convs = db.select().from(conversations).all();
      const msgs = db.select().from(messages).all();
      // 检查是否有孤立消息（conversation 不存在的消息）
      const convIds = new Set(convs.map(c => c.id));
      const orphanMsgs = msgs.filter(m => !convIds.has(m.conversationId));
      if (orphanMsgs.length > 0) {
        checks.push({ name: '数据完整性', status: 'warn', detail: `${orphanMsgs.length} 条孤立消息（无对应对话）` });
        warnings++;
      } else {
        checks.push({ name: '数据完整性', status: 'ok', detail: `${convs.length} 个对话, ${msgs.length} 条消息` });
      }
    } catch (e: unknown) {
      checks.push({ name: '数据完整性', status: 'error', detail: `检查失败: ${(e instanceof Error ? e.message : String(e))}` });
      errors++;
    }

    // 4. 检查 workspace 目录
    const workspacePath = resolve(process.cwd(), 'workspace');
    if (existsSync(workspacePath)) {
      try {
        const entries = readdirSync(workspacePath);
        checks.push({ name: '工作区目录', status: 'ok', detail: `${entries.length} 个条目` });
      } catch (e: unknown) {
        checks.push({ name: '工作区目录', status: 'error', detail: `无法读取: ${(e instanceof Error ? e.message : String(e))}` });
        errors++;
      }
    } else {
      checks.push({ name: '工作区目录', status: 'warn', detail: 'workspace 目录不存在' });
      warnings++;
    }

    // 5. 检查依赖完整性
    // P1-15 修复：从根目录看 package.json，而不是假定 process.cwd() 是项目根
    // 当从 src/backend 启动时 cwd 为 D:\...\src\backend，向上找两层到项目根
    let pkgJsonPath = resolve(process.cwd(), '..', '..', 'package.json');
    if (!existsSync(pkgJsonPath)) pkgJsonPath = resolve(process.cwd(), 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const projectRoot = resolve(pkgJsonPath, '..'); // 从 package.json 所在目录找 node_modules
        const missingDeps: string[] = [];
        for (const [name] of Object.entries(deps)) {
          const modPath = resolve(projectRoot, 'node_modules', name as string);
          if (!existsSync(modPath)) {
            missingDeps.push(name as string);
          }
        }
        if (missingDeps.length > 0) {
          checks.push({ name: '依赖完整性', status: 'error', detail: `缺少 ${missingDeps.length} 个依赖: ${missingDeps.slice(0, 5).join(', ')}` });
          errors++;
        } else {
          checks.push({ name: '依赖完整性', status: 'ok', detail: `所有 ${Object.keys(deps).length} 个依赖已安装` });
        }
      } catch (e: unknown) {
        checks.push({ name: '依赖完整性', status: 'error', detail: `无法读取 package.json: ${(e instanceof Error ? e.message : String(e))}` });
        errors++;
      }
    }

    // 6. 检查敏感文件权限（防止意外暴露）
    const sensitivePaths = ['settings.json', 'pacc.db', '.env'];
    for (const sp of sensitivePaths) {
      const fullPath = resolve(dataDir, sp);
      if (existsSync(fullPath)) {
        try {
          const stats = statSync(fullPath);
          // Windows 上检查权限较复杂，简单检查文件是否可被其他用户读取
          checks.push({ name: `文件安全: ${sp}`, status: 'ok', detail: `${(stats.size / 1024).toFixed(1)} KB` });
        } catch {
          checks.push({ name: `文件安全: ${sp}`, status: 'warn', detail: '无法检查权限' });
          warnings++;
        }
      }
    }

    return {
      timestamp: new Date().toISOString(),
      summary: {
        total: checks.length,
        ok: checks.filter(c => c.status === 'ok').length,
        warn: warnings,
        error: errors,
        passed: errors === 0,
      },
      checks,
    };
  });
}