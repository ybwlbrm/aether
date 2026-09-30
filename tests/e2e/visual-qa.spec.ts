/**
 * T27 视觉 QA 脚本：真实启动应用，截图验证 Codex 三栏布局 + Liquid Glass。
 * 运行：npx playwright test tests/e2e/visual-qa.spec.ts
 *
 * D2 修复：输出路径按 project 名隔离（desktop-chromium / mobile-chromium 各自成目录），
 * 并在每个截图用例显式 setViewportSize —— 避免 mobile project 后跑覆盖 desktop 截图。
 * D3 修复：断言真实 —— T1 三区可见不重叠 / T4 逐个断言 5 个 tab data-slot / T6 断言 sheet 存在。
 */
import { expect } from 'playwright/test';
import { test } from './fixtures';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT_ROOT = join(process.cwd(), 'tests', 'e2e', 'screenshots', 'visual-qa');
const TABS = ['browser', 'code', 'files', 'terminal', 'preview'] as const;

/** 输出路径按 project 名隔离（desktop-chromium / mobile-chromium），避免后跑 project 覆盖前者的截图 */
function outDir(testInfo: { project: { name: string } }): string {
  return join(OUT_ROOT, testInfo.project.name);
}

test.describe('visual-qa — Codex 工作台视觉验收', () => {
  test('T1: /command-center 三栏布局（Sidebar | Thread | Composer）', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/command-center');
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    // Sidebar 存在（导航 —— 显式等待渲染，避免与整仓库件并行时的时序竞态）
    const nav = page.locator('.aether-sidebar, nav, aside').first();
    await nav.waitFor({ state: 'visible', timeout: 10000 });
    // Composer 存在（Thread 底部输入区 —— input 而非 textarea）
    const composer = page.locator('textarea, input[type="text"], [role="textbox"], [data-slot*="composer"]').first();
    await composer.waitFor({ state: 'visible', timeout: 10000 });
    // 三区不重叠：Sidebar（左列）、main（中）
    const navBox = await nav.boundingBox();
    const main = page.locator('main.aether-workspace-main').first();
    const mainBox = await main.boundingBox();
    expect(navBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    if (navBox && mainBox) {
      // Sidebar 右边缘 ≤ main 左边缘（相邻不重叠）
      expect(navBox.x + navBox.width).toBeLessThanOrEqual(mainBox.x + 1);
    }
    // 无未捕获错误
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForTimeout(800);
    expect(errors).toEqual([]);
    mkdirSync(outDir(testInfo), { recursive: true });
    await page.screenshot({ path: join(outDir(testInfo), 'thread-home.png'), fullPage: false });
  });

  test('T2: Liquid Glass ON（默认 glass 材质 + 壁纸环境层）', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/command-center');
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    const material = await page.evaluate(() => document.documentElement.getAttribute('data-material'));
    expect(material).toBe('glass');
    // Glass 参数 token 已在 DOM（--glass-blur-radius 被设置）
    const blur = await page.evaluate(() => document.documentElement.style.getPropertyValue('--glass-blur-radius'));
    expect(blur.length).toBeGreaterThan(0);
    mkdirSync(outDir(testInfo), { recursive: true });
    await page.screenshot({ path: join(outDir(testInfo), 'liquid-glass-on.png'), fullPage: false });
  });

  test('T3: Liquid Glass OFF（data-material=opaque 实底化）', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/command-center');
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    await page.evaluate(() => {
      localStorage.setItem('aether.appearance', JSON.stringify({ uiTheme: 'dark-minimal', colorScheme: 'dark', material: { mode: 'opaque' } }));
    });
    await page.reload();
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    const material = await page.evaluate(() => document.documentElement.getAttribute('data-material'));
    expect(material).toBe('opaque');
    mkdirSync(outDir(testInfo), { recursive: true });
    await page.screenshot({ path: join(outDir(testInfo), 'liquid-glass-off.png'), fullPage: false });
  });

  test('T4: Workbench 打开并渲染 5 个 tab', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/command-center');
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    // 通过 store 事件打开 Workbench
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('workbench-open', { detail: { tab: 'terminal' } }));
    });
    await page.waitForTimeout(800);
    // D3：逐个 tab 切换并断言其 data-slot 真实渲染（只渲染 activeTab 面板）
    for (const tab of TABS) {
      await page.evaluate((t) => {
        window.dispatchEvent(new CustomEvent('workbench-open', { detail: { tab: t } }));
      }, tab);
      await page.waitForTimeout(300);
      const slot = `workbench-${tab}`;
      expect(await page.locator(`[data-slot="${slot}"]`).count(), `tab ${tab} 的 data-slot 应存在`).toBeGreaterThan(0);
    }
    // 停留在最后一个 tab 截图
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('workbench-open', { detail: { tab: 'terminal' } }));
    });
    await page.waitForTimeout(300);
    mkdirSync(outDir(testInfo), { recursive: true });
    await page.screenshot({ path: join(outDir(testInfo), 'workbench-open.png'), fullPage: false });
    // 面板已打开
    expect(await page.locator('[data-slot="workbench-panel"]').count()).toBeGreaterThan(0);
  });

  test('T5: 主题切换即时生效（dark-minimal 无 glow 中性主题）', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/command-center');
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    await page.evaluate(() => {
      localStorage.setItem('aether.appearance', JSON.stringify({ uiTheme: 'dark-minimal', colorScheme: 'dark', material: { mode: 'opaque' } }));
    });
    await page.reload();
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark-minimal');
    mkdirSync(outDir(testInfo), { recursive: true });
    await page.screenshot({ path: join(outDir(testInfo), 'theme-dark-minimal.png'), fullPage: false });
  });

  test('T6: 移动端 390px Thread 全宽 + Workbench 底部 sheet', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/command-center');
    await page.waitForSelector('.aether-app', { timeout: 15000 });
    // 无横向溢出
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('workbench-open', { detail: { tab: 'browser' } }));
    });
    await page.waitForTimeout(800);
    // D3：断言底部 sheet 出现（data-slot="workbench-sheet" 且可见）
    const sheet = page.locator('[data-slot="workbench-sheet"]');
    await sheet.waitFor({ state: 'visible', timeout: 5000 });
    mkdirSync(outDir(testInfo), { recursive: true });
    await page.screenshot({ path: join(outDir(testInfo), 'mobile-sheet.png'), fullPage: false });
  });
});
