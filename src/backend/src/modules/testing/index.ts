import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { URL } from 'node:url';

/** P0-1: SSRF 防护 — 禁止本地/内网/file 协议 URL */
function isSafeTestUrl(raw: string): { ok: boolean; reason?: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: '非法 URL 格式' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `禁止协议: ${u.protocol}（仅允许 http/https）` };
  }
  const host = u.hostname.toLowerCase();
  const BLOCKED = ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '169.254.169.254', 'metadata.google.internal'];
  if (BLOCKED.includes(host)) return { ok: false, reason: '禁止访问本地/元数据地址' };
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return { ok: false, reason: '禁止访问私网地址' };
  }
  return { ok: true };
}

// SEC-025 修复：测试运行会拉起 Chromium（重资源、有外网访问面），必须限流。
// 1) 并发守卫：同一时刻只允许 1 个测试运行（避免 DoS 堆叠 Chromium）。
// 2) IP 滑动窗口：单 IP 10 秒内最多 2 次（防单点刷量）。
const MAX_CONCURRENT_TESTS = 1;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT_PER_IP = 2;
let activeTests = 0;
const ipHits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (ipHits.get(ip) || []).filter(t => t > cutoff);
  if (recent.length >= RATE_LIMIT_PER_IP) return true;
  recent.push(now);
  ipHits.set(ip, recent);
  // 定期清理，防 Map 无限增长
  if (ipHits.size > 1000) {
    for (const [k, v] of ipHits) {
      if (v[v.length - 1] <= cutoff) ipHits.delete(k);
    }
  }
  return false;
}

export function registerTestingRoutes(app: FastifyInstance, config: BackendConfig): void {
  const screenshotsDir = resolve(config.dataDir, 'test-screenshots');
  if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true });

  // 运行网页测试
  app.post('/api/testing/run', {
    schema: { description: '运行网页自动化测试', tags: ['测试'] },
  }, async (request, reply) => {
    const body = request.body as { url: string; actions?: string[]; width?: number; height?: number };
    if (!body.url) return { error: '请提供测试 URL' };

    // SEC-025：IP 限流 + 并发守卫（在 SSRF 校验后、拉起 Chromium 前执行）
    const clientIp = (request.ip || 'unknown').replace(/^::ffff:/, '');
    if (rateLimited(clientIp)) {
      return reply.code(429).send({ error: '测试请求过于频繁，请稍后再试（10 秒内最多 2 次）' });
    }
    if (activeTests >= MAX_CONCURRENT_TESTS) {
      return reply.code(429).send({ error: '已有测试正在运行，请等待其完成' });
    }

    // P0-1: SSRF 校验
    const urlCheck = isSafeTestUrl(body.url);
    if (!urlCheck.ok) {
      return reply.code(400).send({ error: urlCheck.reason });
    }

    // 通过全部前置校验后才占用并发位（finally 中统一释放，防泄漏）
    activeTests++;

    const testId = randomUUID();
    const logs: string[] = [];
    const errors: string[] = [];
    const results: any[] = [];

    // P2-3: browser 声明提前，finally 保证关闭防 Chromium 泄漏
    let browser: any = null;
    try {
      // P1 修复：playwright 缺失（如精简部署环境）时给出明确安装指引，不再抛出晦涩的 MODULE_NOT_FOUND
      let chromium: any = null;
      try {
        ({ chromium } = await import('playwright'));
      } catch (_importErr: unknown) {
        return reply.code(503).send({
          error: '网页自动化测试需要 playwright 依赖（含 Chromium 浏览器）。\n请在项目根目录执行: npm install playwright && npx playwright install chromium\n然后重启服务。',
        });
      }
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: body.width || 1280, height: body.height || 720 },
      });
      const page = await context.newPage();

      // 监听控制台消息
      page.on('console', (msg: any) => {
        logs.push(`[${msg.type()}] ${msg.text()}`);
      });
      page.on('pageerror', (err: any) => {
        errors.push(err.message);
      });

      // 导航到目标 URL
      const startTime = Date.now();
      await page.goto(body.url, { waitUntil: 'networkidle', timeout: 30000 });
      const loadTime = Date.now() - startTime;

      // 截取全屏截图
      const screenshotPath = resolve(screenshotsDir, `${testId}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // 获取页面标题
      const title = await page.title();

      // 获取页面信息
      const pageInfo: any = await page.evaluate(() => ({
        links: 0, images: 0, scripts: 0, textContent: 0,
      }));
      // 用字符串形式执行 evaluate 获取真实数据
      const realInfo = await page.evaluate(`({
        links: document.querySelectorAll('a').length,
        images: document.querySelectorAll('img').length,
        scripts: document.querySelectorAll('script').length,
        textContent: document.body?.innerText?.length || 0,
      })`);
      pageInfo.links = (realInfo as any).links;
      pageInfo.images = (realInfo as any).images;
      pageInfo.scripts = (realInfo as any).scripts;
      pageInfo.textContent = (realInfo as any).textContent;

      // 如果有自定义操作，执行它们
      if (body.actions && body.actions.length > 0) {
        for (const action of body.actions) {
          try {
            if (action.startsWith('click:')) {
              const sel = action.slice(6);
              await page.click(sel);
              results.push({ action: `click ${sel}`, status: 'ok' });
            } else if (action.startsWith('screenshot:')) {
              // P2-3: basename 校验防路径穿越
              const rawName = action.slice(11) || `step-${results.length}`;
              const safeName = basename(rawName).replace(/[.\\\/]/g, '_');
              const stepPath = resolve(screenshotsDir, `${testId}-${safeName}.png`);
              await page.screenshot({ path: stepPath });
              results.push({ action: `screenshot ${safeName}`, status: 'ok' });
            } else if (action.startsWith('wait:')) {
              const ms = parseInt(action.slice(5)) || 1000;
              await page.waitForTimeout(ms);
              results.push({ action: `wait ${ms}ms`, status: 'ok' });
            } else if (action.startsWith('type:')) {
              const [sel, ...textParts] = action.slice(5).split('|');
              await page.fill(sel, textParts.join('|'));
              results.push({ action: `type ${sel}`, status: 'ok' });
            }
          } catch (e: unknown) {
            results.push({ action, status: 'error', error: (e instanceof Error ? e.message : String(e)) });
          }
        }
      }

      // 读取截图 base64
      const screenshotBase64 = existsSync(screenshotPath)
        ? readFileSync(screenshotPath).toString('base64')
        : null;

      return {
        testId,
        success: errors.length === 0,
        url: body.url,
        title,
        loadTime,
        pageInfo,
        logs: logs.slice(-50),
        errors,
        results,
        screenshot: screenshotBase64 ? `data:image/png;base64,${screenshotBase64}` : null,
      };
    } catch (e: unknown) {
      console.error('[Testing] 运行失败:', (e instanceof Error ? e.message : String(e)) || e);
      return { testId, success: false, error: '测试运行失败，请检查 URL 和网络', url: body.url };
    } finally {
      // P2-3: 无论成功失败都关闭 browser 防 Chromium 进程泄漏
      if (browser) { try { await browser.close(); } catch (_e: unknown) { /* ignore - intentional */ } }
      // SEC-025：释放并发位（覆盖成功/失败/异常所有路径，防 activeTests 泄漏）
      activeTests--;
    }
  });
}