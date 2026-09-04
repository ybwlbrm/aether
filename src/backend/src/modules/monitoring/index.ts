import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb } from '../../db/client.js';
import { providers, messages, conversations, mcpServers } from '../../db/schema/index.js';
import { eq, desc, gte } from 'drizzle-orm';
import { cpus, totalmem, freemem, loadavg, uptime, networkInterfaces, hostname } from 'node:os';
import { decrypt as decryptKey } from '../../lib/crypto.js';
import { isSafeFetchUrl } from '../../lib/safe-fetch.js';

// CPU 使用率采样：用 os.cpus() 的 times 差值计算系统级 CPU 使用率
// 之前用 process.cpuUsage() 只测量 Node.js 进程自身，与任务管理器不一致
let lastCpuSample: { idle: number; total: number } | null = null;

// SEC-027 修复：/api/monitoring/models 每次请求都解密所有 API Key 并外部探测全部 Provider。
// 加 5 分钟 TTL 缓存，避免轮询 / 滥用时的高频解密与外部请求（也降低触发 Provider 限流的风险）。
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache: { data: unknown[]; time: number } | null = null;

function getCpuUsagePercent(): string {
  const cpuInfos = cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpuInfos) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  if (lastCpuSample) {
    const idleDelta = idle - lastCpuSample.idle;
    const totalDelta = total - lastCpuSample.total;
    lastCpuSample = { idle, total };
    if (totalDelta === 0) return '0.0';
    const pct = ((1 - idleDelta / totalDelta) * 100);
    return pct.toFixed(1);
  }
  lastCpuSample = { idle, total };
  return '0.0';
}

export function registerMonitoringRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();

  // 系统资源监控（CPU/内存/磁盘/网络）
  app.get('/api/monitoring/system', {
    schema: { description: '获取系统资源使用情况', tags: ['监控'] },
  }, async () => {
    const cpuInfo = cpus();
    const cpuModel = cpuInfo[0]?.model || 'Unknown';
    const cpuCores = cpuInfo.length;
    const load = loadavg();
    const memTotal = totalmem();
    const memFree = freemem();
    const memUsed = memTotal - memFree;

    // 网络接口信息（修复：networkInterfaces() 可能返回 null）
    const nets = networkInterfaces() || {};
    const networkInfo: Record<string, any[]> = {};
    for (const [name, addrs] of Object.entries(nets)) {
      if (addrs) networkInfo[name] = addrs.map(a => ({ address: a.address, family: a.family, internal: a.internal }));
    }

    return {
      hostname: hostname(),
      uptime: Math.floor(uptime()),
      cpu: {
        model: cpuModel,
        cores: cpuCores,
        loadAvg1: load[0]?.toFixed(2),
        loadAvg5: load[1]?.toFixed(2),
        loadAvg15: load[2]?.toFixed(2),
        usagePercent: getCpuUsagePercent(),
      },
      memory: {
        total: memTotal,
        free: memFree,
        used: memUsed,
        usagePercent: ((memUsed / memTotal) * 100).toFixed(1),
        totalGB: (memTotal / 1024 / 1024 / 1024).toFixed(1),
        usedGB: (memUsed / 1024 / 1024 / 1024).toFixed(1),
      },
      network: networkInfo,
    };
  });

  // 模型健康监控（测试所有 Provider 的连接状态）
  app.get('/api/monitoring/models', {
    schema: { description: '获取所有 AI 模型健康状态', tags: ['监控'] },
  }, async () => {
    // SEC-027：命中 5 分钟 TTL 缓存则直接返回，避免频繁解密 Key 与外部探测
    if (modelsCache && Date.now() - modelsCache.time < MODELS_CACHE_TTL_MS) {
      return modelsCache.data;
    }
    const allProviders = db.select().from(providers).all();
    const results = await Promise.all(allProviders.map(async (p) => {
      const models = (() => {
      // P1-7 修复：JSON.parse(null)/parse('') 等脏数据不进数组，避免 [null]
      try {
        const parsed = JSON.parse(p.models || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    })();
      let status = 'unknown';
      let latency = 0;
      let error = '';
      try {
        const start = Date.now();
        // P0-3 修复：解密 API Key 后再用于健康检查，避免用密文导致永远失败
        const plainKey = decryptKey(p.apiKey, config.encryptionKey);
        // 纵深防御：显式校验 baseUrl（监控不应因单个 provider 失败崩溃，校验不通过则跳过）
        if (!p.baseUrl || !isSafeFetchUrl(p.baseUrl)) {
          return {
            id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
            models, status: 'error', latency: 0, error: 'baseUrl 存在 SSRF 风险或未配置', isDefault: p.isDefault,
          };
        }
        const res = await fetch(`${p.baseUrl.replace(/\/$/, '')}/models`, {
          headers: { 'Authorization': `Bearer ${plainKey}` },
          signal: AbortSignal.timeout(5000),
        });
        latency = Date.now() - start;
        if (res.ok) {
          status = 'ok';
          // 读取 rate-limit 头
          const remaining = res.headers.get('x-ratelimit-remaining');
          const limit = res.headers.get('x-ratelimit-limit');
          if (remaining && limit) {
            status = Number(remaining) < Number(limit) * 0.1 ? 'quota_low' : 'ok';
          }
        } else {
          status = 'error';
          error = `HTTP ${res.status}`;
        }
      } catch (e: unknown) {
        status = 'error';
        error = (e instanceof Error ? e.message : String(e));
      }
      return {
        id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
        models, status, latency, error, isDefault: p.isDefault,
      };
    }));
    // 写入缓存供后续请求复用
    modelsCache = { data: results, time: Date.now() };
    return results;
  });

  // Agent 与资源监控
  app.get('/api/monitoring/agents', {
    schema: { description: '获取 Agent 运行状态', tags: ['监控'] },
  }, async () => {
    // MCP 服务器状态
    const mcpList = db.select().from(mcpServers).all();
    const mcpStats = {
      total: mcpList.length,
      enabled: mcpList.filter(m => m.enabled).length,
      local: mcpList.filter(m => m.type === 'local').length,
      remote: mcpList.filter(m => m.type === 'remote').length,
    };

    // 活跃对话数
    const activeConversations = db.select().from(conversations).all().length;

    // 最近消息数（24h）
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const recentMessages = db.select().from(messages).where(gte(messages.createdAt, oneDayAgo)).all().length;

    return {
      mcp: mcpStats,
      activeConversations,
      recentMessages24h: recentMessages,
    };
  });

  // Token 消耗统计（今天/30天）
  app.get('/api/monitoring/tokens', {
    schema: { description: '获取 Token 消耗统计', tags: ['监控'] },
  }, async () => {
    const now = new Date();
    // P2-7: 用 UTC 今天零点替代本地时区，防跨时区统计偏差
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

    const allMessages = db.select().from(messages)
      .where(eq(messages.role, 'assistant'))
      .all();

    let todayTokens = 0;
    let monthTokens = 0;
    let totalTokens = 0;

    for (const msg of allMessages) {
      if (!msg.toolResults) continue;
      try {
        const usage = JSON.parse(msg.toolResults);
        const tokens = usage.total_tokens || 0;
        totalTokens += tokens;
        if (msg.createdAt >= todayStart) todayTokens += tokens;
        if (msg.createdAt >= monthAgo) monthTokens += tokens;
      } catch (_e: unknown) { /* ignore - intentional */ }
    }

    return {
      today: todayTokens,
      month30: monthTokens,
      total: totalTokens,
      since: allMessages.length > 0 ? allMessages[0]?.createdAt : null,
    };
  });
}