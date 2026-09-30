# AETHER-FRONTEND-VISUAL-QA

> 视觉 QA 记录。三块内容：**e2e 结果、截图清单、设计原则逐条 pass-fail**。
> 项目：Aether v2.4.0 ｜ 分支：`refactor/codex-workbench`
> 判据来源：`src/frontend/docs/DESIGN-READ.md`（§2 禁令 12 条、§3 三旋钮、§4 Motion、§5 Contrast、§6 材质边界）

---

## 1. e2e 结果

Playwright 全绿：**116 / 116**。

| 套件 | 文件 | 用例数 | 结果 | 覆盖 |
|------|------|-------|------|------|
| smoke | `tests/e2e/smoke.spec.ts` | 44 | **全绿** | 20 路由可达、三栏骨架、基础交互 |
| events | `tests/e2e/events.spec.ts` | 12 | **全绿** | 15 个 CustomEvent 契约派发不崩溃 + 3 个做真实 DOM 断言（命令面板 / 会话抽屉 / Workbench） |
| glass | `tests/e2e/glass.spec.ts` | 48 | **全绿** | Liquid Glass ON/OFF × 6 主题 × 2 明暗 = 24 组合 × 2 材质态 |
| visual-qa | `tests/e2e/visual-qa.spec.ts` | 12 | **全绿** | T1–T6 六个场景（见 §4） |
| **合计** | 4 spec | **116** | **116 pass / 0 fail** | — |

> 每套件在 `desktop-chromium` 与 `mobile-chromium` 两个 project 下各跑一遍：smoke 22×2=44、events 6×2=12、glass 24×2=48、visual-qa 6×2=12 → 116。

### 1.1 visual-qa.spec.ts 逐条

| 编号 | 场景 | 断言要点 | 结果 |
|------|------|---------|------|
| T1 | `/command-center` 三栏就位 | Sidebar ｜ Thread ｜ Composer 三区同时可见、互不遮挡 | PASS |
| T2 | Liquid Glass **ON** | 默认 glass 材质 + 边缘高光成立 | PASS |
| T3 | Liquid Glass **OFF** | `data-material=opaque` 实底化生效，无残留玻璃 | PASS |
| T4 | Workbench 打开 | 右栏渲染，5 个 tab 全部存在 | PASS |
| T5 | 明暗切换有效 | 切到 dark-minimal，无 glow 残留、无对比度塌陷 | PASS |
| T6 | 移动端 390px | Thread 全宽 + Workbench 折叠为 sheet | PASS |

> 12 个用例对应 6 个场景 × 桌面/移动或 ON/OFF 两态断言。

---

## 2. 截图清单

### 2.1 主题基线截图（48 张）

目录：`tests/e2e/screenshots/baseline/<project>/` —— 共 **48 张**（2 project × 24）：`desktop-chromium`（1440×900 @1×）与 `mobile-chromium`（1440×900 CSS @ Pixel 7 2.625×）各 24 张（6 主题 × 2 明暗 × 2 材质，全部为 `command-center.png`）。

desktop-chromium 实测字节数：

| 主题 | glass/dark | glass/light | opaque/dark | opaque/light |
|------|-----------|-------------|-------------|--------------|
| `dark-minimal` | ✅ 53,010 B | ✅ 32,393 B | ✅ 54,955 B | ✅ 32,640 B |
| `geist` | ✅ 32,202 B | ✅ 32,350 B | ✅ 33,284 B | ✅ 32,656 B |
| `light` | ✅ 57,780 B | ✅ 32,082 B | ✅ 58,665 B | ✅ 33,139 B |
| `magic` | ✅ 225,752 B | ✅ 31,879 B | ✅ 222,573 B | ✅ 32,668 B |
| `origin` | ✅ 236,191 B | ✅ 32,358 B | ✅ 232,933 B | ✅ 33,139 B |
| `shadcn` | ✅ 58,907 B | ✅ 55,912 B | ✅ 33,690 B | ✅ 33,008 B |

目录结构：`baseline/<project>/{glass|opaque}/{dark|light}/{theme}/command-center.png`。

> 暗色 `magic` / `origin` 文件明显更大（222–236 KB vs 32–59 KB），因为这两套主题的玻璃层背后有高饱和背景图，玻璃的透射计算产生更多细节层次。属预期，不是异常。

### 2.2 视觉 QA 截图（12 张）

目录：`tests/e2e/screenshots/visual-qa/<project>/`（desktop-chromium 与 mobile-chromium 各 6 张，按 project 隔离）。

| 文件 | 对应用例 | 场景 | desktop 大小 | mobile 大小 |
|------|---------|------|-------------|-------------|
| `thread-home.png` | T1 | `/command-center` 三栏就位 | 386,029 B | 1,810,506 B |
| `liquid-glass-on.png` | T2 | Liquid Glass ON + 边缘高光 | 386,029 B | 1,810,506 B |
| `liquid-glass-off.png` | T3 | `[data-material=opaque]` 实底化 | 57,103 B | 254,266 B |
| `workbench-open.png` | T4 | Workbench 打开，5 tab | 342,252 B | 1,588,520 B |
| `theme-dark-minimal.png` | T5 | dark-minimal 主题切换 | 33,526 B | 142,205 B |
| `mobile-sheet.png` | T6 | 390px 移动端 Workbench sheet | 146,645 B | 713,063 B |

> T1 与 T2 都在默认 glass 材质下截 `/command-center` 首页，两者 PNG 字节相同属预期（同一渲染）。

### 2.3 早期手工巡检截图（18 张，非门禁）

目录：`qa/2026-09-26-visual/`，桌面 + 移动双份，9 条路由 × 2 视口：
`command-center` / `chat` / `documents` / `library` / `monitoring` / `projects` / `search` / `selfcheck` / `vault`，各 `-desktop.png` / `-mobile.png`。
同目录还有 4 个服务日志（`server.out.log` / `server.err.log` / `server.out2.log` / `server.err2.log`）。

> 这批是重构过程中的手工巡检留档，不在 e2e 门禁内。

---

## 3. 设计原则逐条 pass-fail

判据 = `DESIGN-READ.md`。**Pass** 指已落地并有 e2e / 截图 / token 证据；**Fail** 指未达标或未落地。

### 3.1 §2 Anti-Default 禁令（12 条 + 2 条补充）

| # | 禁令 | 结果 | 证据 / 说明 |
|---|------|------|------------|
| 1 | 不用 AI 紫蓝渐变 | **PASS** | `shell.css` 无 `linear-gradient(135deg,#6366f1,...)`；渐变只出现在 `glass-card::after` 径向弱光泽 |
| 2 | 不用居中 hero | **PASS** | 页面头左对齐 `.ui-page-header` + `.ui-page-header-copy`；T1 截图确认 |
| 3 | 不用三张等宽等高卡片 | **PASS** | Dashboard 按信息量分配（Recent Work / Quick / System health 三段宽度不等）；Workbench 用 tab 而非等宽卡片 |
| 4 | 内容区不用玻璃 | **PARTIAL / 未完成** | `.content-surface` 已建（实底 + 1px 边框 + tint 阴影）；但**存量玻璃消费者未迁移** —— 按 `DESIGN-READ.md` §6，迁移排期在 T19 / T25，本次未做 |
| 5 | 不用 Inter + slate-900 | **PASS** | `--font-family-sans: 'Geist Variable'`；灰阶从画布色相 tint；`--bg-base: #0a0b10` off-black |
| 6 | 不用全大写 eyebrow / kicker | **PASS** | `.aether-nav-group-label` 已改 caption + sentence case；48 张基线截图一致 |
| 7 | 不用章节序号（01/02/03） | **PASS** | Run 状态用语义标签（运行中 / 已完成 / 失败 / 预算超限…），无序号装饰 |
| 8 | 不把等宽字体当"技术感"服装 | **PASS** | monospace 仅用于 code / kbd / 路径 / 时长 / 计数 |
| 9 | 不用 emoji / Unicode 字形充当图标 | **PASS** | 统一 lucide-react（`NavModel` 每项带 `icon`）；尺寸 token `--icon-nav` / `--icon-btn` / `--icon-card` |
| 10 | 不用嵌套卡片 | **PASS** | 层级用 `--radius-subtle/control/surface` + `--surface-elevated`（只提一层） |
| 11 | 不用硬偏移阴影 | **PASS** | `--shadow-xs` … `--shadow-xl` 均带偏移 + 模糊 + tint 到画布色相 |
| 12 | 不编造 UI 状态 | **PASS** | Run 状态来自 `runStore` + `runsApi`；空态 `thread/ThreadEmpty.tsx` 说清下一步；`run-status.ts` 11 态全部对应真实 `RUN_STATUSES` |
| 13 | 不做常驻循环动画 | **PASS** | `GradientShimmer` 循环模式不得出现在产品表面；`.glass-card::before` 的 `glass-shimmer` 8s 循环仅留在 shell 材质层且已被 `prefers-reduced-motion` 关闭 |
| 14 | 不做渐变文字 | **PASS** | 无 `background-clip: text` |

### 3.2 §3 三旋钮

| 旋钮 | 结果 | 证据 |
|------|------|------|
| Density | **PASS** | 仪表 / workbench / 列表用 `--list-row-height` 44px + 13–15px 正文；叙述正文用 `--content-prose: 68ch`（T1 / T4 截图确认行高差异） |
| Restraint | **PASS** | 玻璃只在壳层（Sidebar / Workbench / Overlay）；强调色一屏 ≤2 处 tint；动效只有 `.content-surface` 一处作者时刻（`shell-content-settle`，220ms exponential ease-out） |
| Honesty | **PASS** | 状态来自真实 Run 数据；数字来自 DTO；控件写动作（`Resume` 不是 `OK`）；`--on-accent` 对比度问题如实记入遗留项（见 §5） |

### 3.3 §4 Motion

| 检查项 | 结果 | 证据 |
|--------|------|------|
| 单一动效对 `--motion-authoring` / `--motion-exit` | **PASS** | `shell.css` `:root` 声明，无散落手写 `cubic-bezier` |
| 唯一作者时刻 `.content-surface` 落位 | **PASS** | `shell-content-settle`，未复制到每个 section |
| `GradientShimmer` 循环形态不出现于产品表面 | **PASS** | 组件允许存在但产品未用循环模式 |
| `.glass-card::before` 循环已被 reduce 关闭 | **PASS** | `components.css` 已有 `prefers-reduced-motion` 块 |

### 3.4 §5 Contrast

| 角色 | 目标 | 实测 / 推算 | 结果 |
|------|------|------------|------|
| 正文 `--text-primary` | ≥ 4.5:1 | 暗 ≈16:1 | PASS |
| 辅助 `--text-secondary` | ≥ 4.5:1 | 暗 ≈6.2:1 | PASS |
| `--content-text-quiet`（T6a 新增） | ≥ 4.5:1 | 暗 ≈9.6:1 / 浅 ≈7.9:1 | PASS |
| `--text-tertiary` | ≥19px 大字或纯图形 | 暗 ≈3.1:1 / 浅 ≈3.3:1 | PASS（限定用途） |
| `--color-accent`（T6b 重调） | ≥ 4.5:1 | **4.72–6.32:1**（`#4f86d4` / 亮色 `#35609e`） | PASS |
| **`--on-accent` 白字在暗色 accent 上** | ≥ 4.5:1 | **3.69:1**（原 2.69:1） | **FAIL —— 遗留项** |
| 导航分组标签 `.aether-nav-group-label` | 正文级 | 已从 3.1:1 提到 `--content-text-quiet` ≈9.6:1 | PASS |
| 选区 / 光标 / 滚动条 | 从主题取色 | `shell.css` 浏览器表面段；浅色滚动条有兜底 | PASS |

### 3.5 §6 材质边界

| 层 | 允许的类 | 结果 |
|----|----------|------|
| Shell | `.sidebar-glass`、`.glass-card` | PASS（`/command-center` 48 张基线确认） |
| Overlay | `.glass-modal`、`.glass-menu` | PASS |
| 内容区 | `.content-surface`（实底 + 1px 边框 + tint 阴影） | **PARTIAL**：token 已建，存量消费者迁移排期 T19 / T25 |
| 数据密集 | 无材质（靠分隔线与行高） | PASS（Workbench 5 tab 符合） |

> `.glass-menu` / `.sidebar-glass` 无渲染消费者但被 `themes.css` 反向引用，**保留**（删了会破坏引用链）。

### 3.6 §7 本层落地清单（逐项可核对）

| 项 | 位置 | 结果 |
|----|------|------|
| 正文行宽 68ch | `tokens.css` → `--content-prose` | PASS |
| 标题节奏（上 32 / 下 16） | `tokens.css` → `--heading-margin-top` / `--heading-margin-bottom` | PASS |
| 内容区实底 | `shell.css` → `.content-surface` | PASS（消费者迁移见 §3.1 #4） |
| 选区 / 光标 / 滚动条 | `shell.css` 浏览器表面段 | PASS |
| 单一动效对 | `shell.css` → `--motion-authoring` | PASS |
| 导航标签去大写 | `components.css` → `.aether-nav-group-label` | PASS |
| z-index 离刻度 | `.aether-wb-divider` → `--z-fixed`；对话抽屉 → `--z-sticky` | PASS |
| 重复边框清理 | `WorkspaceFrame.tsx` 删 `borderLeft` | PASS |

---

## 4. 视觉 QA 汇总

| 类别 | Pass | Partial | Fail | 合计 |
|------|------|---------|------|------|
| §2 Anti-Default（14 条） | 13 | 1（#4 存量迁移） | 0 | 14 |
| §3 三旋钮（3 条） | 3 | 0 | 0 | 3 |
| §4 Motion（4 条） | 4 | 0 | 0 | 4 |
| §5 Contrast（8 项） | 7 | 0 | **1** | 8 |
| §6 材质边界（4 层） | 3 | 1 | 0 | 4 |
| §7 落地清单（8 项） | 8 | 0 | 0 | 8 |
| **合计** | **38** | **2** | **1** | **41** |

**唯一 Fail**：`--on-accent` 白字在暗色 accent 上 3.69:1 —— 已从 2.69:1 改善，达标需 4.5:1，超出本次授权范围。
**2 项 Partial**：内容区玻璃迁移（§3.1 #4 / §3.5），按 `DESIGN-READ.md` §6 明确排期在 T19 / T25，本次不做。

---

## 5. 遗留视觉问题（完整记录）

| # | 问题 | 量级 | 状态 |
|---|------|------|------|
| V1 | `--on-accent` 白字在暗色 accent 上 3.69:1 | 1 处 | 已改善（原 2.69:1），未达标，超出授权范围 |
| V2 | 22 处 `rgba(94,158,255)` 残留（`components.css` + TSX 内联样式，markdown 表格 / 表头等） | 22 处 | 超出 T6b 指定文件范围，未改 |
| V3 | `.ui-page-shell-header` 疑似样式回归（markup 用 `data-slot` 无 class） | 1 处 | `ui/page-shell.tsx` 超出授权范围未改 |
| V4 | `.glass-menu` / `.sidebar-glass` 无渲染消费者但被 `themes.css` 反向引用 | 2 个 class | 刻意保留 |
| V5 | 存量玻璃消费者未迁到 `.content-surface` | 迁移排期 T19 / T25 | 明确延期，非遗漏 |

---

## 6. 复核命令

```powershell
# e2e 全量
npm run test:e2e

# 48 张基线截图（2 project × 24）
(Get-ChildItem tests/e2e/screenshots/baseline -Recurse -Filter *.png).Count

# 12 张视觉 QA 截图（2 project × 6；文件在 <project>/ 子目录，须 -Recurse）
(Get-ChildItem tests/e2e/screenshots/visual-qa -Recurse -Filter *.png).Count

# visual-qa 用例数
Select-String -Path tests/e2e/visual-qa.spec.ts -Pattern "test\("
```

---

配套文档：
- 功能清单 → `AETHER-FRONTEND-FEATURE-MASTER-INVENTORY.md`
- 迁移映射 → `AETHER-FRONTEND-MIGRATION-MAP.md`
- 重构审计 → `AETHER-FRONTEND-REDESIGN-AUDIT.md`
- 视觉宪法 → `DESIGN-READ.md`
