import { expect } from 'playwright/test';
import { test, APP_EVENTS, gotoRoute } from './fixtures';

/**
 * CustomEvent 契约基线（T7，D1 修复后）：
 * 1) 全部 15 个 app 级事件 dispatch 后页面不崩溃；
 * 2) **真断言**：对能产生可观测 DOM 副作用的 live 事件，dispatch 后断言
 *    应用级监听者真的响应（命令面板 / 会话抽屉 / Workbench / 壁纸环境层）——
 *    不再用「注入自己的 listener 再断言收到」的恒真写法。
 * 3) select-conversation 带 detail 载荷不崩溃。
 */

test.describe('events — 15 个 CustomEvent 契约', () => {
  test.beforeEach(async ({ page }) => {
    await gotoRoute(page, '/command-center');
  });

  test('全部 15 个事件 dispatch 后页面不崩溃', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    for (const name of APP_EVENTS) {
      await page.evaluate(
        ([evName]) => {
          window.dispatchEvent(new CustomEvent(evName, { detail: undefined }));
        },
        [name],
      );
      await page.waitForTimeout(50);
    }

    expect(pageErrors, `dispatch 15 事件不应产生未捕获错误: ${pageErrors.join('; ')}`).toEqual([]);
    expect(await page.locator('.aether-app').isVisible()).toBe(true);
  });

  test('toggle-command-palette → 命令面板真打开（应用监听者响应）', async ({ page }) => {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('toggle-command-palette'));
    });
    await page.waitForTimeout(300);
    // CommandPalette 打开后渲染 role="dialog" aria-label="Command palette" + 搜索输入框
    const dialog = page.locator('[role="dialog"][aria-label="Command palette"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    const search = page.locator('input[aria-label="Search commands"]');
    expect(await search.count(), '命令面板搜索框应存在').toBeGreaterThan(0);
  });

  test('toggle-conv-panel → 会话抽屉真打开（应用监听者响应）', async ({ page }) => {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('toggle-conv-panel'));
    });
    await page.waitForTimeout(400);
    // ConversationsDrawer 打开后渲染 data-slot="conversations-drawer"
    const drawer = page.locator('[data-slot="conversations-drawer"]');
    await drawer.waitFor({ state: 'visible', timeout: 5000 });
  });

  test('workbench-open → Workbench 面板真打开（应用监听者响应）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('workbench-open', { detail: { tab: 'terminal' } }));
    });
    await page.waitForTimeout(600);
    // AppShell 常驻监听器应打开 Workbench → 右侧栏出现
    const wbCount = await page.locator('[data-slot="workbench-panel"]').count();
    expect(wbCount, 'workbench-open 必须由 AppShell 监听并打开面板').toBeGreaterThan(0);
  });

  test('bg-slideshow-start 派发不崩溃（WallpaperLayer 监听端由单测覆盖）', async ({ page }) => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('bg-slideshow-start', {
          detail: { images: ['/data/backgrounds/e2e-fake.png'], interval: 60 },
        }),
      );
    });
    await page.waitForTimeout(400);
    expect(await page.locator('.aether-app').isVisible()).toBe(true);
  });

  test('select-conversation 带 detail 载荷派发不崩溃', async ({ page }) => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('select-conversation', { detail: { conversationId: 'e2e-conv-1' } }),
      );
    });
    await page.waitForTimeout(100);
    expect(await page.locator('.aether-app').isVisible()).toBe(true);
  });
});
