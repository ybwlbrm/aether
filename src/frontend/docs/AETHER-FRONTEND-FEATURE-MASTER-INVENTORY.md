# AETHER-FRONTEND-FEATURE-MASTER-INVENTORY

> 功能总清单（重构前后对照）。可作为交付验收的第一份依据。
> 项目：Aether v2.4.0 ｜ 分支：`refactor/codex-workbench`（自 `053d58a` 切出）
> 基线核对：`git log --oneline -1` → `2b4c591 fix(frontend): register workbench-open/toggle listeners on AppShell`
> 本表所有"当前组件/Store"列均可在 `src/frontend/src` 下按路径核实。

---

## 0. 一句话结论

20 条路由的功能**一条没丢**；外壳从「两种 UI 模式切换」改成「固定三栏 Codex 工作台」；
新增的是 Run 生命周期展示模型（11 态）、Run 权威状态 Store、5 个接真实数据的 Workbench tab、
15 个 CustomEvent 的契约化注册表。删除的全是零消费者死代码。

---

## 1. 路由级功能清单（20 条，全部保留）

路由注册表：`src/frontend/src/components/navigation/NavModel.ts`（`ROUTE_SURFACES`，含 `path` / `label` / `group` / `icon` / `keywords`）。

| # | 功能 | 当前入口（重构后） | 当前组件 | Store | 是否保留 | 新入口 |
|---|------|------------------|---------|-------|---------|--------|
| 1 | Command center（总能力工作台） | `/command-center` | `routes/ThreadPage.tsx` | `runStore` / `activityStore` | 保留（升级） | Sidebar → `work` 组第 1 项 |
| 2 | Chat（会话） | `/chat` | `routes/Chat.tsx` | `activityStore` | 保留 | Sidebar → `work` 组 |
| 3 | Projects（项目看板） | `/projects` | `routes/Projects.tsx` | — | 保留 | Sidebar → `work` 组 |
| 4 | Documents（文档编辑） | `/documents` | `routes/Documents.tsx` | — | 保留 | Sidebar → `output` 组 |
| 5 | Media（图音生成） | `/media` | `routes/Media.tsx` | — | 保留 | Sidebar → `output` 组 |
| 6 | Library（资源库） | `/library` | `routes/Library.tsx` | — | 保留 | Sidebar → `output` 组 |
| 7 | Providers（模型/接入/密钥） | `/providers` | `routes/Providers.tsx` | — | 保留 | Sidebar → `configure` 组 |
| 8 | Agent settings（角色/权限） | `/agent-settings` | `routes/AgentSettings.tsx` | — | 保留 | Sidebar → `configure` 组 |
| 9 | MCP（Model Context Protocol） | `/mcp` | `routes/McpSettings.tsx` | — | 保留 | Sidebar → `configure` 组 |
| 10 | Workflows（画布/自动化） | `/workflows` | `routes/Workflows.tsx` | — | 保留 | Sidebar → `configure` 组 |
| 11 | Settings（外观/通道） | `/settings` | `routes/Settings.tsx` | `appearance` | 保留（玻璃双轨合并） | Sidebar → `configure` 组 |
| 12 | Monitoring（健康/延迟/失败率） | `/monitoring` | `routes/Monitoring.tsx` | — | 保留 | Sidebar → `operate` 组 |
| 13 | Self check（自检/环境） | `/selfcheck` | `routes/SelfCheck.tsx` | — | 保留 | Sidebar → `operate` 组 |
| 14 | Knowledge（知识源） | `/knowledge` | `routes/Knowledge.tsx` | — | 保留 | Sidebar → `operate` 组 |
| 15 | Vault（密钥保险库） | `/vault` | `routes/Vault.tsx` | — | 保留 | Sidebar → `operate` 组 |
| 16 | Toolbox（格式/转换） | `/toolbox` | `routes/Toolbox.tsx` | — | 保留 | Sidebar → `tools` 组 |
| 17 | Search（知识库检索） | `/search` | `routes/Search.tsx` | — | 保留 | Sidebar → `tools` 组 |
| 18 | Browser（内置浏览器） | `/browser` | `routes/Browser.tsx` | — | 保留 | Sidebar → `tools` 组 + Workbench tab |
| 19 | Terminal（Shell 控制台） | `/terminal` | `routes/Terminal.tsx` | — | 保留 | Sidebar → `tools` 组 + Workbench tab |
| 20 | Dashboard（仪表盘） | `/dashboard` | `routes/Dashboard.tsx` | — | 保留（**位置变更**） | Sidebar 隐藏项（`hiddenFromSidebar: true`），旧 `/command-center` 的仪表盘能力迁到这里 |

Sidebar 分组（5 组，Codex 风格）：`work` / `output` / `configure` / `operate` / `tools`，主组 `NAV_PRIMARY_GROUP = 'work'`。

---

## 2. 三栏工作台功能（重构核心，全部为新增）

外壳：`components/shell/AppShell.tsx`（常驻监听 `workbench-open` / `workbench-toggle`）。

| # | 功能 | 当前入口 | 当前组件 | Store | 是否保留 | 新入口 |
|---|------|---------|---------|-------|---------|--------|
| 21 | Sidebar（5 组导航 + 20 路由注册表） | 常驻左栏 | `shell/Sidebar.tsx` + `navigation/NavModel.ts` + `NavSurfaceList.tsx` | — | 新增（替换旧 mode 切换） | 左栏固定 |
| 22 | Thread（消息流 + 工具活动） | `/command-center` 中栏 | `thread/Thread.tsx`、`ThreadMessage.tsx`、`ToolActivity.tsx` | `runStore` | 新增（合并 CodingHome/Chat） | 中栏 |
| 23 | Run 状态条（11 态展示模型） | Thread 顶部 | `thread/RunStatusStrip.tsx` + `lib/run-status.ts` | `runStore` | 新增 | Thread 顶部 |
| 24 | 审批提示（统一层） | Thread 内 | `thread/ApprovalPrompt.tsx`、`conversation/approval-card.tsx` | `runStore` | 新增（**修复 super 模式 gap**） | Thread 内 + 审批中心命令 |
| 25 | 空态引导 | 无会话时 | `thread/ThreadEmpty.tsx` | — | 新增 | 中栏空态 |
| 26 | Composer（输入区） | `/command-center` 底部 | `composer/Composer.tsx` + `ComposerToolbar`、`ProviderSelect`、`PromptTemplates`、`AttachmentTray`、`VoiceButton` | `runStore` | 新增（合并 4 处旧实现） | 中栏底部 |
| 27 | 会话抽屉 | 抽屉 | `shell/ConversationsDrawer.tsx` | `workspace.conversationId` | 保留（`toggle-conv-panel` 契约） | 左侧抽屉 / 命令面板 |
| 28 | Workbench 面板容器 | 右侧栏 | `workbench/WorkbenchPanel.tsx` | `workspace.workbench` | 新增 | 右栏 |
| 29 | Workbench → Browser tab | 右栏 tab 1 | `workbench/tabs.ts` + `hooks/workbench/useWorkbenchBrowser.ts` | `workspace.workbench.activeTab` | 新增 | 右栏 |
| 30 | Workbench → Code tab | 右栏 tab 2 | `hooks/workbench/useWorkbenchCode.ts` | 同上 | 新增 | 右栏 |
| 31 | Workbench → Files tab | 右栏 tab 3 | `hooks/workbench/useWorkbenchFiles.ts` + `asset-rows.ts` | 同上 | 新增 | 右栏 |
| 32 | Workbench → Terminal tab | 右栏 tab 4 | `hooks/workbench/useWorkbenchTerminal.ts` | 同上 | 新增 | 右栏 |
| 33 | Workbench → Preview tab | 右栏 tab 5 | `hooks/workbench/useWorkbenchPreview.ts` | 同上 | 新增 | 右栏 |
| 34 | 命令面板（含 3 个 action 入口） | `Cmd/Ctrl+K` | `components/CommandPalette`（NavModel action 项） | — | 保留（新增 3 个 action） | 命令面板 |

Workbench 状态：`workspace.ts` 的 `workbench` 子对象 —— `open` / `activeTab` / `width` / `pinned` / `maximized`，操作 `openWorkbench` / `closeWorkbench` / `toggleWorkbench` / `setWorkbenchTab` / `setWorkbenchWidth` / `toggleWorkbenchPin` / `toggleWorkbenchMaximize`。

---

## 3. 外观 / 材质功能（全部保留，功能未动）

| # | 功能 | 当前入口 | 当前组件 | Store | 是否保留 | 新入口 |
|---|------|---------|---------|-------|---------|--------|
| 35 | 背景切换（含自定义图 + 目录轮播） | `/settings` → 外观 | `shell/WallpaperLayer.tsx` + backgrounds API | `appearance` | 保留 | Settings → 外观 |
| 36 | Liquid Glass 开关 | `/settings` → 外观 | `LiquidGlassFilter` + `assets/liquid-lens-map.png` + `.glass-card` | `appearance` | 保留 | Settings → 外观；`[data-material="opaque"]` 实底化 |
| 37 | 7 种 uiTheme | `/settings` → 外观 | `themes.css` 变量组 | `appearance` | 保留 | Settings → 主题 |
| 38 | 6 个主题变体 CSS | 随 uiTheme | `themes.css` | — | 保留 | 同上 |
| 39 | accent 去饱和重调 | token | `tokens.css` / `themes.css` | — | 保留（**值已改**） | `--color-accent`：`#5e9eff` → `#4f86d4`，亮色 `#35609e`；对比度 4.72–6.32:1 |
| 40 | Sidebar 布局模式 | 常驻 | `workspace.sidebarMode`（expanded / compact / hidden） | `workspace` | 保留 | Sidebar 内 |
| 41 | Context bar | Thread 顶部 | `shell/ContextBar.tsx` | — | 保留 | Thread 上方 |
| 42 | Active run 切换器 | Workbench 顶部 | `shell/ActiveRunSwitcher.tsx` + `hooks/workbench/useActiveRunId.ts` | `runStore` | 保留（升级为 Run 权威状态） | Workbench 头部 |
| 43 | glass 弹层 | Overlay | `.glass-modal` / `.glass-menu` | — | 保留 | Modal / Menu |

---

## 4. 能力层（新增模块，全部为重构后交付物）

| # | 能力 | 入口 | 文件 | 是否新增 |
|---|------|------|------|---------|
| 44 | CustomEvent 契约注册表（15 事件） | 全局 | `lib/events.ts` | 新增 |
| 45 | URL 意图解析（`?conv=` 等） | Thread | `lib/url.ts` | 新增 |
| 46 | Run 状态展示模型（11 态） | Thread / Workbench | `lib/run-status.ts` | 新增 |
| 47 | Run REST 客户端（8 端点） | Workbench / Store | `api/runs.ts` | 新增 |
| 48 | SSE 续传（`Last-Event-ID`） | Run 流 | `api/sse.ts` | 新增 |
| 49 | Run 权威 Store | 全局 | `store/runStore.ts` | 新增 |
| 50 | 纯投影（tool / file / agent / retry） | Thread / Workbench | `store/projections.ts` | 新增 |
| 51 | Run 流 hook | Thread | `hooks/useRunStream.ts` | 新增 |
| 52 | Thread 控制器（统一 Chat / CodingHome） | `/chat` `/command-center` | `hooks/useThreadController.ts` | 新增 |
| 53 | 语音输入 | Composer | `hooks/useVoiceInput.ts` | 保留（接入新 Composer） |
| 54 | 附件 | Composer | `hooks/useAttachments.ts` | 保留（接入新 Composer） |
| 55 | Provider 选择 | Composer | `hooks/useProviderSelection.ts` | 保留（接入新 Composer） |
| 56 | 远程命令宿主 | 全局 | `hooks/useRemoteCommandHost.ts` | 保留（对接 `remote-command`） |
| 57 | 媒体查询（移动端 390px 分支） | 全局 | `hooks/useMediaQuery.ts` | 新增 |
| 58 | 通知中心 | 全局 | `lib/notification-center.ts` | 保留 |

11 个 Run 状态（来自 `@pacc/shared` 的 `RUN_STATUSES`，本仓只写"展示单元"）：
`created` / `running` / `waiting` / `retry_waiting` / `retrying` / `verifying` / `completed` / `failed` / `cancelled` / `interrupted` / `budget_exceeded`。
每个状态在 `lib/run-status.ts` 的 `RUN_STATUS_META` 里有一条 `tokenVar`（如 `--status-retry-waiting`）。

`activityStore` 的 `RunMeta` 从 4 态扩到 **11 态**（对齐上面的全集）。

---

## 5. 明确删除 / 退役的功能与文件

| # | 删除对象 | 规模 | 理由 | 能力去向 |
|---|---------|------|------|---------|
| D1 | `components/ai-elements/` | 7 文件 / 1849 行 | 零消费者（无任何 import） | 无 —— 纯死代码 |
| D2 | `routes/CodingHome.tsx` | 整文件 | 能力并入 `ThreadPage` | `/command-center` |
| D3 | `routes/CommandCenter.tsx` | 整文件 | 同上 | `/command-center` |
| D4 | `components/CodingHomeComposer.tsx` | 整文件 | 并入 `composer/` | Composer |
| D5 | `components/ComposerToolbar.tsx`（顶层那份） | 整文件 | 并入 `composer/ComposerToolbar.tsx` | Composer 工具条 |
| D6 | `components/chat/composer*` | 目录 | 并入 `composer/` | Composer |
| D7 | `components/chat/chat-thread-extras*` | 目录 | 并入 `composer/` + `conversation/` | Composer / 会话视图 |
| D8 | `components/PageHeader.tsx` | 整文件 | 双实现统一到 `components/ui/page-header.tsx` | 全部页面头 |
| D9 | `store/app.ts` 死字段 `sidebarOpen` / `currentRoute` / `setUiMode` | 3 字段 | 无读取方 | 无 |
| D10 | `store/workspace.ts` 死字段 `projectId` / `setProjectId` / `toggleSidebar` | 3 字段 | 无读取方 | 无（`conversationId` **保留**） |
| D11 | `components.css` 死规则 `.aether-wb-*` + `.section-header*` 家族 | 2 规则族 | 无 class 消费者 | 无 |

保留但降级：`uiMode` 仍在 `store/app.ts`（`uiMode` + `toggleUiMode`），已**离开渲染路径**，只剩 NavModel action / Sidebar 消费者（命令面板入口）。

---

## 6. 功能数量小结

| 分类 | 数量 |
|------|------|
| 路由功能 | 20（全部保留） |
| 三栏工作台功能 | 14（其中 1 条为保留的会话抽屉、1 条为保留的 shell 组件） |
| 外观 / 材质功能 | 9 |
| 能力层模块 | 15 |
| 删除项 | 11 类（含 2 个整路由文件 + 1 个零消费者目录） |

---

## 7. 核对方式

```powershell
# 路由条数（20；NavModel.ts:99 有 1 处接口类型声明 surfaceKind: 'route' 会被一并匹配 → 21）
(Select-String -Path src/frontend/src/components/navigation/NavModel.ts -Pattern "id: '[a-z-]+', path:").Count

# 事件条数（15）
Select-String -Path src/frontend/src/lib/events.ts -Pattern "^\s{2}'[a-z-]+':"

# Run 端点（9：8 REST + 1 fetchRunEvents；runs.ts 每端点有 result/throw 双层定义，锚定 result 层去重）
(Select-String -Path src/frontend/src/api/runs.ts -Pattern "^\s{2}(listRuns|getRun|createRun|startRun|pauseRun|resumeRun|cancelRun|recoverStaleRuns|fetchRunEvents):.*Promise<ApiResult").Count

# 截图基线（48 张 = 2 project × 6 主题 × 2 明暗 × 2 材质）
(Get-ChildItem tests/e2e/screenshots/baseline -Recurse -Filter *.png).Count
```

---

配套文档：
- 迁移映射 → `AETHER-FRONTEND-MIGRATION-MAP.md`
- 重构审计 → `AETHER-FRONTEND-REDESIGN-AUDIT.md`
- 视觉 QA → `AETHER-FRONTEND-VISUAL-QA.md`
- 视觉宪法 → `DESIGN-READ.md`
