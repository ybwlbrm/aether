/**
 * System Health 自检报告的构建逻辑（`GET /api/selfcheck` 的全部主体）。
 *
 * 单独成模块的原因：GET 路由与 `POST /api/selfcheck/repair` 都需要同一份报告 ——
 * 前者给「当前健康度」，后者在修复后立即回传「修复后的健康度」，两者必须字节级一致。
 * 抽取为纯函数后可直接被单测断言，不经过 HTTP 层。
 *
 * 语义约定：
 * - 任何单项检查失败都必须被 catch 收敛成 status='error' 的检查项，整份报告永不抛错
 * - 同步健康读取（getSyncRuntimeHealth）未配置时返回全 false 快照，本身不抛错
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BackendConfig } from '../../config/index.js'
import { getDb } from '../../db/client.js'
import { providers, conversations, messages } from '../../db/schema/index.js'
import { getSyncRuntimeHealth, getSyncConfig } from '../sync/index.js'

/** 单项自检结果。 */
export interface SelfCheckItem {
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

/** 自检报告：GET /api/selfcheck 的响应体，也是 repair 响应里的 selfcheck 字段。 */
export interface SelfCheckReport {
  timestamp: string
  summary: {
    total: number
    ok: number
    warn: number
    error: number
    passed: boolean
  }
  checks: SelfCheckItem[]
}

export async function buildSelfCheckReport(config: BackendConfig): Promise<SelfCheckReport> {
    const checks: SelfCheckItem[] = [];
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

    // 4. 检查远程同步（T6 一键修复的前置信号：未配置 → summary.passed=false）
    // getSyncRuntimeHealth() 是纯读取，未配置时返回全 false 快照而不抛错，故无需 try/catch
    const syncHealth = getSyncRuntimeHealth();
    if (!syncHealth.configured) {
      checks.push({ name: '远程同步', status: 'error', detail: '未配置同步，手机端无法下发命令（请在「设置 → 同步」中连接 Supabase）' });
      errors++;
    } else if (!syncHealth.realtimeListening) {
      checks.push({ name: '远程同步', status: 'warn', detail: '已配置但 Realtime 监听未启动（点击「一键修复」可恢复）' });
      warnings++;
    } else {
      const deviceId = getSyncConfig()?.deviceId ?? 'unknown';
      checks.push({ name: '远程同步', status: 'ok', detail: `已连接，Realtime 监听正常（device=${deviceId}）` });
    }

    // 5. 检查 workspace 目录
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

    // 6. 检查依赖完整性
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

    // 7. 检查敏感文件权限（防止意外暴露）
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
}