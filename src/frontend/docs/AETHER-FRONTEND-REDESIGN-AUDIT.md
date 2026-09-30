# AETHER-FRONTEND-REDESIGN-AUDIT

> 重构审计报告。逐项回答：**原来有什么、新 UI 在哪、哪些重构、哪些删除、为什么删、哪些保持原样、
> 哪些 API 复用、哪些 API 新增、哪些测试增加、哪些问题修复、哪些问题仍存在。**
> 项目：Aether v2.4.0 ｜ 分支：`refactor/codex-workbench`（自 `053d58a` 切出）｜ 30+ commit（T1–T26 + 多轮 Oracle 修复）

---

## 1. 原来有什么（重构前的状态）

| 维度 | 重构前 |
|------|--------|
| 外壳形态 | 两套 UI 模式（`uiMode`：`normal` / `coding`），靠 `toggleUiMode` 在渲染路径上切换 |
| 主页面 | `/command-center` 同时承担"仪表盘"和"编码首页"两件事（`CommandCenter.tsx` + `CodingHome.tsx`） |
| 工作台 | 单用途面板（`Workbench.tsx`），tab 定义散落，无统一数据层 |
| Run 状态 | 前端只认 4 态 `RunMeta`，其余状态没有展示单元 |
| 跨模块通信 | 6 个 CustomEvent 裸发裸收，无注册表、无 orphan 声明 |
| Composer | 4 处并行实现（`CodingHomeComposer` / 顶层 `ComposerToolbar` / `chat/composer*` / `chat-thread-extras*`） |
| 页面头 | `components/PageHeader.tsx` 与 `components/ui/page-header.tsx` 双实现并存 |
| Settings 材质 | glass 双轨，两处来源 |
| 死代码 | `ai-elements/` 1849 行零消费者；Store 6 个死字段；`components.css` 2 规则族无消费者 |
| 测试 | 14 文件 / 125 测试 |
| accent | `#5e9eff`（亮色对白字 2.69:1，未达标） |

---

## 2. 新 UI 在哪

| 区域 | 路径 |
|------|------|
| 外壳（三栏骨架） | `src/frontend/src/components/shell/AppShell.tsx` |
| 左栏 Sidebar | `components/shell/Sidebar.tsx` + `components/navigation/NavModel.ts`（20 路由注册表，5 组） |
| 中栏 Thread | `components/thread/`（`Thread` / `ThreadMessage` / `ToolActivity` / `RunStatusStrip` / `ApprovalPrompt` / `ThreadEmpty`） |
| 中栏输入 | `components/composer/`（6 模块 + `index.ts`） |
| 右栏 Workbench | `components/workbench/WorkbenchPanel.tsx`（Browser / Code / Files / Terminal / Preview 5 tab） |
| 会话抽屉 | `components/shell/ConversationsDrawer.tsx` |
| 主路由页 | `routes/ThreadPage.tsx`（`/command-center`） |
| 仪表盘 | `routes/Dashboard.tsx`（`/dashboard`） |
| 设计语言层 | `src/frontend/src/styles/shell.css`（宪法见 `docs/DESIGN-READ.md`） |

三栏：Sidebar（Work/Output/Configure/Operate/Tools） ｜ Thread ｜ Workbench（5 tab 接真实数据）。

---

## 3. 哪些重构（改了实现，功能没变）

| # | 重构项 | 变更 | 功能影响 |
|---|--------|------|---------|
| R1 | `uiMode` 离开渲染路径 | `store/app.ts` 的 `uiMode` / `toggleUiMode` 字段保留，但不再驱动任何分支渲染；唯一消费者是 NavModel `action:ui-mode` | 无（模式切换能力降级为命令面板动作） |
| R2 | CustomEvent 契约化 | 6 个事件（`select-conversation` / `remote-command` / `conversations-changed` / `toggle-conv-panel` / `aether-open-approvals` / `toggle-ui-mode`）迁入 `lib/events.ts` 的 15 事件注册表，每个事件带 `orphan` 分类与 `summary` | 无（调用方式从裸 dispatch 变为注册表派发） |
| R3 | PageHeader 双实现统一 | `components/PageHeader.tsx` 删除，全部页面头走 `components/ui/page-header.tsx` | 无 |
| R4 | Settings glass 双轨合并 | Settings 改为 shell + 单一 glass 来源 | 无 |
| R5 | Composer 四合一 | 4 处旧实现并入 `components/composer/` | 无 |
| R6 | Chat / CodingHome 控制器统一 | `hooks/useThreadController.ts` 同时驱动 `/chat` 与 `/command-center` | 无 |
| R7 | accent 去饱和重调 | `--color-accent`：`#5e9eff` → `#4f86d4`，亮色 `#35609e` | 无功能变化，对比度从 2.69:1 提到 4.72–6.32:1 |
| R8 | Sidebar 导航分组 | 由平铺列表改为 5 组（Work/Output/Configure/Operate/Tools），分组标签去全大写改 caption + sentence case | 无（`DESIGN-READ.md` §2 禁令 6） |
| R9 | 滚动条 / 选区 / 光标取主题色 | `shell.css` 浏览器表面段统一从 token 取色，修掉浅色主题滚动条消失的问题 | 修掉既有 bug |
| R10 | 重复边框清理 | `WorkspaceFrame.tsx` 删外层 `borderLeft`，保留 `Workbench.tsx` 内层 | 无 |
| R11 | 导航分组的 z-index 离刻度 | `.aether-wb-divider` → `var(--z-fixed)`，对话抽屉 → `var(--z-sticky)` | 无 |
| R12 | 导航分组标签换色 | `.aether-nav-group-label` 从 `--text-tertiary` 切到 `--content-text-quiet`（正文级对比度） | 无（对比度从 3.1:1 到约 9.6:1） |

---

## 4. 哪些删除 + 为什么删

| # | 删除对象 | 规模 | 删除理由（可核实） |
|---|---------|------|-------------------|
| X1 | `components/ai-elements/` | 7 文件 / 1849 行 | 目录内 7 个组件全仓零 import，属选型遗留 |
| X2 | `routes/CodingHome.tsx` | 整文件 | 能力 100% 并入 `ThreadPage` |
| X3 | `routes/CommandCenter.tsx` | 整文件 | 能力 100% 并入 `ThreadPage`（仪表盘部分去 `/dashboard`） |
| X4 | `components/CodingHomeComposer.tsx` | 整文件 | 并入 `composer/Composer.tsx` |
| X5 | 顶层 `components/ComposerToolbar.tsx` | 整文件 | 并入 `composer/ComposerToolbar.tsx` |
| X6 | `components/chat/composer*` | 目录 | 并入 `composer/` |
| X7 | `components/chat/chat-thread-extras*` | 目录 | 并入 `composer/` + `conversation/` |
| X8 | `components/PageHeader.tsx` | 整文件 | 双实现，统一到 `ui/page-header` |
| X9 | `app.ts` 死字段 `sidebarOpen` / `currentRoute` / `setUiMode` | 3 字段 | 全仓无读取方（`uiMode` + `toggleUiMode` 保留） |
| X10 | `workspace.ts` 死字段 `projectId` / `setProjectId` / `toggleSidebar` | 3 字段 | 全仓无读取方（`conversationId` 保留） |
| X11 | `components.css` 死规则 `.aether-wb-*` + `.section-header*` 家族 | 2 规则族 | 无 class 消费者 |

**删除的共同判据**：只有"全仓零消费者"或"能力已被 100% 覆盖且新实现有测试"的东西才删。没有任何一项删除伴随功能丢失。

---

## 5. 哪些保持原实现（明确不动）

| 项 | 位置 | 保持原因 |
|----|------|---------|
| 背景切换 | `shell/WallpaperLayer.tsx` + backgrounds API | 功能正确，状态已有测试覆盖 |
| Liquid Glass 实现 | `LiquidGlassFilter` + `assets/liquid-lens-map.png` + `.glass-card` + `[data-material="opaque"]` | 材质层成熟，只在 Settings 合并来源，不重写 |
| 7 种 uiTheme + 6 个主题变体 CSS | `themes.css` | 视觉基线由 48 张截图锁定 |
| 20 条路由的功能实现 | `routes/*.tsx`（除两个已删） | 重构范围是外壳与契约层，不动页面业务 |
| `appearance.ts` Store | `store/appearance.ts` | 主题/背景/glass 状态无需变更 |
| `api/client.ts` / `contract.ts` / `types.ts` | `api/` | 通用 HTTP 与错误模型不变 |
| `lib/notification-center.ts` | — | 通知能力未受影响 |
| `WorkspaceFrame` / `Workbench` 分栏 | `components/shell/` | 拖拽 / pin / maximize 逻辑保留 |
| `hooks/useAutosaveDraft` / `useConversations` / `useMessagePolling` / `useSafeTimeout` / `useStreamSend` | `hooks/` | 既有 hook 保留，仅新增不删 |

---

## 6. 哪些 API 复用

见 `AETHER-FRONTEND-MIGRATION-MAP.md` §3。摘要：

- Run 生命周期状态机**复用后端 11 态**（`@pacc/shared` 的 `RUN_STATUSES`），前端只补展示单元。
- `AgentEvent` 事件模型复用（`api/runs.ts` 的 `fetchRunEvents` 返回 `{ events, nextSeq }`）。
- 背景、Provider、审批、浏览器、终端、文件、代码读取端点全部复用既有后端能力。
- `api/client.ts` 的请求与 `ApiError` 错误模型未改。

**后端没有新增端点**。8 个 Run 端点是既有 Run 生命周期的 HTTP 暴露。

---

## 7. 哪些 API 新增（前端侧）

| # | 新增 | 内容 |
|---|------|------|
| N1 | `api/runs.ts` | 8 端点：`listRuns` / `getRun` / `createRun` / `startRun` / `pauseRun` / `resumeRun` / `cancelRun` / `recoverStaleRuns` + `fetchRunEvents` |
| N2 | `api/sse.ts` | SSE 唯一双向通道，`Last-Event-ID` 续传（帧 id = `<seq>`），`onClose` 回传 `lastEventId` |
| N3 | `lib/events.ts` | 15 事件注册表（`orphan` + `summary`） |
| N4 | `lib/url.ts` | URL 意图解析 |
| N5 | `lib/run-status.ts` | `RUN_STATUS_META`（11 态 `tokenVar`）、`NEXT_RUN_STATUSES` |
| N6 | `store/runStore.ts` | Run 权威状态 |
| N7 | `store/projections.ts` | tool / file / agent / retry 纯投影 |
| N8 | `hooks/useRunStream.ts` | Run 流消费 |
| N9 | `hooks/useThreadController.ts` | Chat / ThreadPage 共用控制器 |
| N10 | `hooks/useMediaQuery.ts` | 移动端 390px 分支 |
| N11 | `hooks/workbench/` × 6 | 5 tab 数据 + `useActiveRunId` |

---

## 8. 哪些测试增加

| 维度 | 基线 | 现在 | 增量 |
|------|------|------|------|
| vitest 文件 | 14 | **47** | +33 |
| vitest 测试 | 125 | **692** | **+567** |
| backend `npm run test` | — | 1448 pass | 全绿 |
| mobile `npm run test` | — | 59 pass | 全绿 |
| Playwright e2e | — | **116 / 116** | smoke 44 + events 12 + glass 48 + visual-qa 12（各 spec × 2 个 project） |
| 截图基线 | — | 48 张（2 project × 6 主题 × 2 明暗 × 2 材质） | — |
| 视觉 QA 截图 | — | 12 张（2 project × 6 场景） | — |

新增覆盖分组：`lib/events` / `lib/url` / `lib/run-status` / `api/runs` / `api/sse` / `store/runStore` / `store/projections` / 6 个 hook / thread 组件 5 / composer 3 / workbench 2 / `NavModel.test.ts` / `CommandPalette` / e2e `visual-qa.spec.ts`（6 项）。

保留：既有 `Chat.test`（2 个）保留；`CodingHome.test` 移植到 `ThreadPage.test.tsx`，**净测试数不减少**。

---

## 9. 哪些问题修复

| # | 问题 | 修复方式 | 证据 |
|---|------|---------|------|
| F1 | **super 模式审批 gap**（审批提示不在统一层，super 模式下审批不可见） | `ask-confirm` 提升到统一层，由 `thread/ApprovalPrompt.tsx` + `conversation/approval-card.tsx` 承载 | 新增 thread 组件测试 5 个 |
| F2 | `pollErrorCountRef` 职责混装 | 拆分为独立引用，错误计数与轮询状态解耦 | `hooks/useMessagePolling.ts` 相关 + `poll-status-banner` |
| F3 | 双 cancel（v1 + v2 两套取消路径） | 统一到 `runsApi.cancelRun` + `aether-stop-run` 单一路径 | `api/runs.test.ts` |
| F4 | `workbench-open` 监听器丢失（切路由后监听器被卸载，工作台打不开） | 监听器提升到 `shell/AppShell.tsx` 常驻 | commit `2b4c591` |
| F5 | PageHeader 双实现 | 统一到 `ui/page-header.tsx` | `ui/page-header.test.tsx` |
| F6 | Settings glass 双轨 | 单一 glass 来源 | commit `ad1a9a0` |
| F7 | accent 对比度不达标（`#5e9eff` 上白字 2.69:1） | 去饱和重调 → `#4f86d4` / 亮色 `#35609e`，4.72–6.32:1 | 48 张主题基线截图 |
| F8 | 浅色主题滚动条消失（`themes.css` 只定义暗色 `--scrollbar-thumb`） | `shell.css` 浏览器表面段补浅色兜底 | `DESIGN-READ.md` §5 |
| F9 | 导航分组标签对比度不足（`--text-tertiary` ≈3.1:1，13px 属正文级） | 切换到 `--content-text-quiet`（≈9.6:1 暗 / 7.9:1 浅） | `DESIGN-READ.md` §5 |
| F10 | z-index 无刻度 | 改用 `--z-fixed` / `--z-sticky` token | `DESIGN-READ.md` §7 |
| F11 | 重复边框 | `WorkspaceFrame` 删外层 `borderLeft` | `DESIGN-READ.md` §7 |
| F12 | 死代码（1849 行 + 6 个 Store 字段 + 2 规则族） | 全部删除 + persist allowlists | commit `5aff096` |

---

## 10. 哪些问题仍存在（诚实记录）

| # | 问题 | 量级 | 为什么不修 | 影响面 |
|---|------|------|-----------|--------|
| R-1 | eslint warning | **738 个**（**全部存量**） | 超出本次重构范围；本次目标是 0 error，已达成 | 无功能影响 |
| R-2 | `--on-accent` 白字在暗色 accent 上对比度 3.69:1 | 1 处 token 组合 | 已从 2.69:1 改善，达标需 4.5:1，超出授权范围 | 暗色 accent 按钮文字对比偏弱 |
| R-3 | `rgba(94,158,255)` 残留 | **22 处**（`components.css` + TSX 内联样式；markdown 表格 / 表头等） | 超出 T6b 指定文件范围 | 旧 accent 硬编码未完全收口 |
| R-4 | 旧审计报告仍提及 `ai-elements` | 历史归档文档 | 归档文档不改写 | 无运行时影响 |
| R-5 | `uiMode` 仍有消费者 | NavModel / Sidebar（`toggle-ui-mode` 命令面板入口） | 该入口是刻意保留的能力 | 已不在渲染路径 |
| R-6 | `.glass-menu` / `.sidebar-glass` 无渲染消费者但被 `themes.css` 反向引用 | 2 个 class | 删了会破坏 `themes.css` 引用链 | 保留 |
| R-7 | `.ui-page-shell-header` 疑似样式回归 | 1 处；markup 用 `data-slot` 无 class | `ui/page-shell.tsx` 超出授权范围未改 | 页面壳头部样式可能丢失 |

---

## 11. 验收门（最终验证）

| 检查 | 结果 |
|------|------|
| `tsc`（4 个项目：shared / backend / frontend / mobile） | **0 错误** |
| `vitest`（frontend） | 47 文件 / 692 测试 **全绿** |
| `npm run test`（全 workspace） | **0 失败**（backend 1448 pass + mobile 59 pass） |
| `eslint` | **0 errors**（738 warnings 全存量） |
| `build:frontend` | **成功** |
| Playwright e2e | **116 / 116 全绿** |
| commit 数 | 31（T1–T26 + 修复） |

---

## 12. 结论

重构达成三件事：外壳从"模式切换"变成"固定三栏工作台"，跨模块通信从"裸事件"变成"15 事件契约"，
Run 状态从"4 态"变成"11 态并接后端权威真值"。功能零丢失，删除项全部零消费者或 100% 能力覆盖。
7 项遗留问题全部有量级与原因记录，无隐瞒。
