import { test as base, expect, type Page } from 'playwright/test';

/**
 * Aether E2E fixtures（T7）
 * 提供：路由导航 + CustomEvent 观测 + appearance 状态注入。
 * 所有 helper 只做真实加载与观测，不 mock 页面内容。
 */

export const test = base;

/** 前端 20 条真实路由（与 src/frontend/src/App.tsx 一一对应） */
export const ROUTES = [
  '/command-center',
  '/dashboard',
  '/providers',
  '/chat',
  '/media',
  '/documents',
  '/projects',
  '/library',
  '/browser',
  '/settings',
  '/agent-settings',
  '/toolbox',
  '/search',
  '/knowledge',
  '/vault',
  '/mcp',
  '/monitoring',
  '/selfcheck',
  '/workflows',
  '/terminal',
] as const;

/** 全部 15 个 app 级 CustomEvent 名（aether-stop-run 已从注册表移除：CommandPalette 已改走 runsApi.cancelRun） */
export const APP_EVENTS = [
  'aether-open-approvals',
  'bg-slideshow-start',
  'bg-slideshow-stop',
  'bg-slideshow-clear',
  'bg-slideshow-interval',
  'conversations-changed',
  'custombg-change',
  'remote-command',
  'select-conversation',
  'sync-data-changed',
  'toggle-command-palette',
  'toggle-conv-panel',
  'toggle-ui-mode',
  'workbench-open',
  'workbench-toggle',
] as const;

/** 6 个非默认 uiTheme 变体（liquid-glass 是默认材质，不重复基线） */
export const UI_THEMES = ['shadcn', 'geist', 'magic', 'origin', 'dark-minimal', 'light'] as const;

/** 访问路由并断言 AppShell 挂载 + 无未捕获页面错误 */
export async function gotoRoute(page: Page, path: string): Promise<void> {
  const pageErrors: string[] = [];
  const onError = (err: Error): void => {
    pageErrors.push(err.message);
  };
  page.on('pageerror', onError);
  await page.goto(path);
  await page.waitForSelector('.aether-app', { timeout: 15000 });
  expect(pageErrors, `路由 ${path} 不应有未捕获页面错误: ${pageErrors.join('; ')}`).toEqual([]);
}

/** 在页面上注入一个 CustomEvent 观测器，返回取回记录的句柄 */
export async function observeEvents(page: Page, names: readonly string[]): Promise<() => Promise<string[]>> {
  await page.evaluate(
    ([evNames]) => {
      const records: string[] = [];
      const w = window as unknown as { __observedEvents?: string[] };
      w.__observedEvents = records;
      for (const name of evNames) {
        window.addEventListener(name, () => {
          records.push(name);
        });
      }
    },
    [names],
  );
  return async () => page.evaluate(() => (window as unknown as { __observedEvents?: string[] }).__observedEvents ?? []);
}

/** 注入 appearance 状态并重载，返回注入的 JSON（供断言往返） */
export async function setAppearance(
  page: Page,
  state: { uiTheme: string; colorScheme: string; material: { mode: string } },
): Promise<void> {
  await page.evaluate((payload) => {
    localStorage.setItem('aether.appearance', JSON.stringify(payload));
  }, state);
  await page.reload();
  await page.waitForSelector('.aether-app', { timeout: 15000 });
}
