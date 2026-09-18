import { defineConfig, devices } from 'playwright/test';

/**
 * Playwright E2E 配置（整改计划第 11 章，P0/P1）。
 * CI 质量关：Playwright desktop/mobile E2E 覆盖核心链路：
 * - 新建对话首条消息可见 / 轮询失败可重试
 * - 上滑阅读不被拉回底部
 * - 默认工作目录一致 / Provider 选择 / 搜索分页
 * - 鉴权矩阵（写接口默认 401）
 *
 * 本地启动：`npx playwright test`（需先 `npm start` 或 `npm run dev`）。
 * CI：由 ci.yml 的 quality-gate 或独立 e2e job 调用。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // 本地单服务端口，避免并发端口冲突
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : [['list']],

  use: {
    baseURL: process.env.AETHER_BASE_URL || 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // E2E 需要写入（后端默认拒绝鉴权），从 /api/auth/token 获取 token 附加到请求
    extraHTTPHeaders: {},
  },

  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],

  webServer: process.env.CI
    ? {
        command: 'npm start',
        port: 3000,
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
});
