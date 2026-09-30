# AETHER-FRONTEND-MIGRATION-MAP

> 迁移映射（旧 → 新）。回答三个问题：**旧组件去哪了、旧功能从哪个入口进、API 是复用还是新增。**
> 项目：Aether v2.4.0 ｜ 分支：`refactor/codex-workbench`

---

## 1. 旧组件 → 新组件映射

### 1.1 页面级

| 旧组件 | 新组件 | 迁移方式 | 备注 |
|--------|--------|---------|------|
| `routes/CommandCenter.tsx` | `routes/ThreadPage.tsx` | 能力并入 + 重写布局 | 旧仪表盘部分 → `routes/Dashboard.tsx` |
| `routes/CodingHome.tsx` | `routes/ThreadPage.tsx` | 能力并入 | 原 `CodingHome.test` 移植到 `ThreadPage.test.tsx`，测试数不减 |
| `routes/Chat.tsx` | 保留 `routes/Chat.tsx` + `hooks/useThreadController.ts` | 抽出控制器共用 | Chat 与 ThreadPage 共享同一控制器 |
| （旧 dashboard 内容） | `routes/Dashboard.tsx`（路由 `/dashboard`） | **位置变更** | NavModel 中 `hiddenFromSidebar: true` |
| `components/PageHeader.tsx` | `components/ui/page-header.tsx` | 双实现统一 | 旧文件删除 |

### 1.2 Composer 家族（4 处旧实现 → 1 处）

| 旧组件 | 新组件 |
|--------|--------|
| `components/CodingHomeComposer.tsx` | `components/composer/Composer.tsx` |
| `components/ComposerToolbar.tsx`（顶层） | `components/composer/ComposerToolbar.tsx` |
| `components/chat/composer*` | `components/composer/Composer.tsx` + `components/composer/index.ts` |
| `components/chat/chat-thread-extras*` | `components/composer/PromptTemplates.tsx` / `AttachmentTray.tsx` |

新 Composer 目录 6 个模块：`Composer.tsx` / `ComposerToolbar.tsx` / `ProviderSelect.tsx` / `PromptTemplates.tsx` / `AttachmentTray.tsx` / `VoiceButton.tsx`，带 `index.ts` 桶文件。

### 1.3 会话视图家族

| 旧 | 新 |
|----|----|
| （散落在 chat-thread-extras 的会话渲染） | `components/conversation/conversation-thread.tsx` |
| `components/chat/chat-conversation-list.tsx` | `components/conversation/*` + `shell/ConversationsDrawer.tsx` |
| `components/activity/ActivityStream.tsx` / `TaskCard.tsx` | `components/thread/ToolActivity.tsx` + `components/conversation/activity-stream.tsx` |
| （旧审批卡片，散落在 Thread 内） | `components/conversation/approval-card.tsx` + `components/thread/ApprovalPrompt.tsx` |

`components/conversation/` 实际文件：`approval-card` / `conversation-thread` / `poll-status-banner` / `thinking-dots` / `activity-stream` / `message-bubble` / `stream-failure` + `index.ts`。

### 1.4 Shell 层

| 旧 | 新 | 备注 |
|----|----|------|
| （旧 mode 切换外壳） | `components/shell/AppShell.tsx` | **常驻监听 `workbench-open` / `workbench-toggle`**（commit `2b4c591` 修复） |
| （旧会话面板） | `components/shell/ConversationsDrawer.tsx` | 对接 `toggle-conv-panel` |
| `components/shell/Sidebar.tsx` | 保留 + 改由 `NavModel` 驱动 | 5 组分组 Work/Output/Configure/Operate/Tools |
| `components/shell/Workbench.tsx` / `WorkspaceFrame.tsx` | 保留 | 拖拽分栏、pin/maximize |
| `components/shell/WallpaperLayer.tsx` | 保留（未改） | 背景切换 |
| `components/shell/ContextBar.tsx` / `ActiveRunSwitcher.tsx` | 保留（升级） | 后者接 `runStore` + `useActiveRunId` |

### 1.5 Workbench（全新）

| 新文件 | 职责 |
|--------|------|
| `components/workbench/WorkbenchPanel.tsx` | 面板容器 + 5 tab 切换 |
| `components/workbench/tabs.ts` | tab 定义 |
| `components/workbench/shared.ts` | 共享渲染片段 |
| `components/workbench/index.ts` | 桶文件 |
| `hooks/workbench/useWorkbenchBrowser.ts` | Browser tab 数据 |
| `hooks/workbench/useWorkbenchCode.ts` | Code tab 数据（shiki 高亮） |
| `hooks/workbench/useWorkbenchFiles.ts` + `asset-rows.ts` | Files tab 数据 + 行投影 |
| `hooks/workbench/useWorkbenchTerminal.ts` | Terminal tab 数据 |
| `hooks/workbench/useWorkbenchPreview.ts` | Preview tab 数据 |
| `hooks/workbench/useActiveRunId.ts` | 当前 Run 判定 |

### 1.6 死代码删除

| 删除对象 | 规模 |
|---------|------|
| `components/ai-elements/` | 7 文件 / 1849 行 |
| `routes/CodingHome.tsx` | 整文件 |
| `routes/CommandCenter.tsx` | 整文件 |
| `components/CodingHomeComposer.tsx` | 整文件 |
| `components/PageHeader.tsx` | 整文件 |
| `components/chat/composer` / `chat-thread-extras` | 目录 |

---

## 2. 旧功能 → 新入口映射

### 2.1 路由入口

| 旧入口 | 新入口 | 变化 |
|--------|--------|------|
| `/command-center`（CommandCenter，仪表盘+编码首页混合） | `/command-center`（ThreadPage，三栏工作台） | **语义替换**：同一 URL，全 capability |
| `/command-center`（仪表盘部分） | `/dashboard` | **迁出** |
| `/chat` | `/chat`（走 `useThreadController`） | 控制器统一 |
| 其余 17 条路由 | 路径不变 | 无 |
| — | Sidebar → `work` / `output` / `configure` / `operate` / `tools` 五组 | **新增分组** |
| — | Sidebar 紧凑模式 `workspace.sidebarMode` | 保留 |
| — | 会话抽屉 `toggle-conv-panel` | 保留 |
| — | 命令面板 `toggle-command-palette`（`Cmd/Ctrl+K`） | 保留 + 新增 3 个 action |
| — | 命令面板 action：`action:ui-mode` | 保留（唯一 `uiMode` 消费者） |
| — | 命令面板 action：`action:conv-panel` | 新增 |
| — | 命令面板 action：`action:approvals` | 新增 |

### 2.2 CustomEvent 契约（6 个原子迁移）

`uiMode` 离开渲染路径后，跨模块通信全部改走 `lib/events.ts` 的 15 事件注册表（每个事件带 `orphan` 分类与 `summary`）。

| 事件 | 消费者 | 迁移后位置 |
|------|--------|-----------|
| `select-conversation` | 会话点击 → Thread 切数据 | `useThreadUrlIntent` / `lib/url.ts` |
| `remote-command` | 远程指令落地 | `hooks/useRemoteCommandHost.ts` |
| `conversations-changed` | 会话列表刷新 | `shell/ConversationsDrawer.tsx` + Thread |
| `toggle-conv-panel` | 会话抽屉 | `shell/ConversationsDrawer.tsx` |
| `aether-open-approvals` | 审批中心 | 命令面板 action + `thread/ApprovalPrompt.tsx` |
| `toggle-ui-mode` | 模式切换 | NavModel `action:ui-mode`（**仅剩的 uiMode 消费者**） |
| `workbench-open` | 指定 tab 打开工作台 | **`shell/AppShell.tsx` 常驻监听**（修复点） |
| `workbench-toggle` | 工作台开关 | **`shell/AppShell.tsx` 常驻监听**（修复点） |

其余注册事件：`aether-stop-run` / `bg-slideshow-start` / `bg-slideshow-stop` / `bg-slideshow-clear` / `bg-slideshow-interval` / `custombg-change` / `sync-data-changed` / `toggle-command-palette`。合计 16。

---

## 3. API 复用表（不改签名、不新增端点）

| 领域 | 复用 API / 客户端 | 前端文件 | 状态 |
|------|------------------|---------|------|
| Run 生命周期 | 沿用后端 Run 端点语义（11 态来自 `@pacc/shared` `RUN_STATUSES`） | `api/runs.ts` 薄封装 | 复用语义，前端新增客户端 |
| Agent 事件流 | 沿用 EventStore 事件模型（`AgentEvent`） | `api/sse.ts`、`api/runs.ts` `fetchRunEvents` | 复用 |
| 会话 | 沿用 conversation 端点 | `api/client.ts`、`api/contract.ts` | 复用（未改） |
| 背景 | 沿用 backgrounds API | `shell/WallpaperLayer.tsx` + `appearance.ts` | 复用（未改） |
| 模型 / Provider | 沿用 providers 端点 | `routes/Providers.tsx`、`hooks/useProviderSelection.ts` | 复用 |
| 审批 | 沿用审批端点 | `conversation/approval-card.tsx`、`thread/ApprovalPrompt.tsx` | 复用 |
| 浏览器 / 终端 | 沿用 browser / terminal 能力端点 | `hooks/workbench/useWorkbenchBrowser.ts`、`useWorkbenchTerminal.ts` | 复用 |
| 文件 / 资产 | 沿用文件与资产端点 | `hooks/workbench/useWorkbenchFiles.ts`、`asset-rows.ts` | 复用 |
| 代码读取 | 沿用代码/文件读取端点 | `hooks/workbench/useWorkbenchCode.ts` | 复用 |
| 通用 HTTP | 沿用 `api/client.ts` 请求与错误模型（`ApiError`） | 全前端 | 复用（未改） |

---

## 4. 新增 API 表

### 4.1 `api/runs.ts` —— 8 个端点

| 方法 | 函数 | 路径 | 用途 |
|------|------|------|------|
| GET | `listRuns(params)` | `/runs` | 按 `conversationId` / `status` / `mode` / `rootAgentId` / `metadata` + `limit` / `offset` 列表分页 |
| GET | `getRun(runId)` | `/runs/:id` | 单 Run 全量 DTO |
| POST | `createRun(input)` | `/runs` | 建 Run |
| POST | `startRun(runId)` | `/runs/:id/start` | 无 body |
| POST | `pauseRun(runId)` | `/runs/:id/pause` | 无 body（仅 `running` 可用） |
| POST | `resumeRun(runId)` | `/runs/:id/resume` | 无 body（仅 `waiting` 可用） |
| POST | `cancelRun(runId)` | `/runs/:id/cancel` | 无 body（`running`/`waiting`/`retry_waiting`/`retrying`/`verifying` 可用） |
| POST | `recoverStaleRuns()` | `/runs/recover` | 回收僵死 Run，返回 `{ runs, total, recovered, message }` |
| GET | `fetchRunEvents(runId, params)` | `/runs/:id/events` | 按 `afterSeq` / `limit` 拉事件，返回 `{ events, nextSeq }` |

> 上表 9 行、8 个 REST 动作 + 1 个事件查询；`runsApi` 同时提供 `requestResult`（返回 `ApiResult<T>`）与抛错版本两套入口。

### 4.2 `api/sse.ts` —— SSE 续传

| 能力 | 说明 |
|------|------|
| `Last-Event-ID` 续传 | 帧 id 形如 `id: <seq>`，重连时作为 `Last-Event-ID` 请求头下发 |
| fetch + ReadableStream | 唯一双向通道，不与另一套轮询并存 |
| `Authorization` | 帧头，与 `Last-Event-ID` 同时下发 |
| 断线恢复 | `onClose` 回传 `lastEventId`，供上层重连 |

### 4.3 新增契约 / 纯函数（非 HTTP）

| 文件 | 导出 | 用途 |
|------|------|------|
| `lib/events.ts` | 15 事件注册表 | CustomEvent 契约化（`orphan` 分类 + `summary`） |
| `lib/url.ts` | URL 意图解析/生成 | Thread 深链与恢复 |
| `lib/run-status.ts` | `RUN_STATUS_META`（11 态 `tokenVar`）、`NEXT_RUN_STATUSES` | Run 状态展示模型 |
| `store/runStore.ts` | Run 权威状态 | 唯一 Run 真值源 |
| `store/projections.ts` | tool / file / agent / retry 纯投影 | 纯函数，无副作用 |

---

## 5. Store 字段迁移

| Store | 旧 | 新 | 处置 |
|-------|-----|----|------|
| `app.ts` | `uiMode` + `toggleUiMode` | 同名字段保留 | **保留**，但离开渲染路径 |
| `app.ts` | `sidebarOpen` | — | 删除（无读取方） |
| `app.ts` | `currentRoute` | — | 删除（无读取方） |
| `app.ts` | `setUiMode` | — | 删除（无读取方） |
| `workspace.ts` | `workbench{open,activeTab,width,pinned,maximized}` | 同 | 保留 |
| `workspace.ts` | `sidebarMode` | 同 | 保留 |
| `workspace.ts` | `conversationId` + `setConversationId` | 同 | 保留 |
| `workspace.ts` | `projectId` / `setProjectId` / `toggleSidebar` | — | 删除（无读取方） |
| `activityStore.ts` | `RunMeta` 4 态 | **11 态** | 扩宽，对齐 `RUN_STATUSES` |
| `runStore.ts` | （新建） | Run 权威状态 | 新增 |
| `appearance.ts` | 主题 / 背景 / glass | 同 | 保留（未改） |

---

## 6. 测试迁移

| 旧测试 | 新测试 | 处置 |
|--------|--------|------|
| `routes/Chat.test.tsx`（2 个） | 保留 | 保留 |
| `routes/CodingHome.test.tsx` | `routes/ThreadPage.test.tsx` | 移植，**净测试数不减少** |

新增覆盖：`lib/events` / `api/runs` / `api/sse` / `lib/url` / `lib/run-status` / `store/runStore` / `store/projections` / 6 个 hook（`useRunStream` / `useThreadController` / `useVoiceInput` / `useAttachments` / `useProviderSelection` / `useRemoteCommandHost` 中的被测项）/ thread 组件 5 个 / composer 3 个 / workbench 2 个 / `NavModel.test.ts` / `CommandPalette` / e2e `visual-qa.spec.ts`（6 项）。

总量：14 文件 / 125 测试 → **47 文件 / 692 测试**（净增 567）。
