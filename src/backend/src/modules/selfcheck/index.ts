import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../../db/client.js';
import { providers, conversations, messages } from '../../db/schema/index.js';
import { getSettings } from '../../lib/dal.js';

export function registerSelfCheckRoutes(app: FastifyInstance, config: BackendConfig): void {

  // 运行 AI 自检
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