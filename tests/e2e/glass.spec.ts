import { expect } from 'playwright/test';
import { test, UI_THEMES, gotoRoute, setAppearance } from './fixtures';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Liquid Glass / 多主题视觉基线（T7，D2 修复后）：
 * {material: glass|opaque} × {colorScheme: dark|light} × {uiTheme: 6} = 24 张截图，
 * 存入 tests/e2e/screenshots/baseline/<project>/。
 *
 * D2 修复：playwright.config 有 desktop-chromium + mobile-chromium 两个 project 且
 * workers=1 —— 若两个 project 写同一路径，后跑的 mobile 会覆盖 desktop 的截图，
 * 使"24 张基线"全是移动端宽度。因此：
 *   1) 输出路径按 project 名隔离；
 *   2) 两 project 均显式固定 1440×900 CSS 视口（同一布局；PNG 物理尺寸随
 *      deviceScaleFactor 变化：desktop 1× → 1440×900，Pixel 7 2.625× → 3780×2363）。
 * 重构后此矩阵必须逐张匹配（T25 用）。
 */

const BASELINE_ROOT = join(process.cwd(), 'tests', 'e2e', 'screenshots', 'baseline');

test.describe('glass — 24 张主题矩阵基线', () => {
  for (const uiTheme of UI_THEMES) {
    for (const colorScheme of ['dark', 'light'] as const) {
      for (const material of ['glass', 'opaque'] as const) {
        test(`${uiTheme} × ${colorScheme} × ${material}`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await gotoRoute(page, '/command-center');
          await setAppearance(page, {
            uiTheme,
            colorScheme,
            material: { mode: material },
          });
          const dir = join(BASELINE_ROOT, testInfo.project.name, material, colorScheme, uiTheme);
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: join(dir, 'command-center.png'), fullPage: false });
          // 断言：截图确实在桌面视口下（mobile project 也在 desktop viewport 里截——见注释）
          const viewport = page.viewportSize();
          expect(viewport?.width).toBe(1440);
        });
      }
    }
  }
});
