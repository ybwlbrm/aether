import { expect } from 'playwright/test';
import { test, ROUTES, gotoRoute } from './fixtures';

/**
 * 冒烟基线（T7）：全部 20 条路由可加载、AppShell 挂载、无未捕获错误。
 * 这是重构前的视觉/运行基线；重构后此套件必须保持全绿。
 */

test.describe('smoke — 路由加载', () => {
  for (const path of ROUTES) {
    test(`${path} 加载且无未捕获错误`, async ({ page }) => {
      await gotoRoute(page, path);
      const title = await page.title();
      expect(title.length).toBeGreaterThan(0);
      expect(await page.locator('.aether-app').isVisible()).toBe(true);
    });
  }
});

test('根路径重定向到 /command-center', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.aether-app', { timeout: 15000 });
  expect(page.url()).toContain('/command-center');
});

test('无边框拖拽区域存在（Electron 桌面形态）', async ({ page }) => {
  await gotoRoute(page, '/command-center');
  expect(await page.locator('.app-drag-region').count()).toBeGreaterThan(0);
});
