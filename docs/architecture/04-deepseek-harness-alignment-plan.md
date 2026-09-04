# Aether → DeepSeek Harness 架构对齐计划

> 基于 DeepSeek Harness（commit b150a551）源码分析，覆盖 UI 对话界面、权限设置、工具调用、错误处理四个领域。
> 计划日期：2026-08-24

---

## 一、核心架构差异

| 维度 | Aether 现状 | DeepSeek Harness 参考 | 改动量 |
|---|---|---|---|
| 事实源 | messages 表（聚合后的消息行） | SessionEvent 日志（append-only 事件） | 🔴 大 |
| UI 渲染 | MessageBubble/MemoBubble → Card | ConversationNode → Slot 渲染器 | 🔴 大 |
| 工具显示 | 旧协议 toolCalls JSON 字符串，已移除 | presentCall/presentResult 纯函数 | 🟡 中 |
| 权限 | 单一 Level 1/2/3 整型 | 每个工具独立 pre-execute waterfall | 🟡 中 |
| 错误/重试 | fetchWithRetry 全局重试 | llm-retry on agent/request-error，durable-first | 🟢 小 |
| 传输 | SSE（双轨：旧+新事件名） | WebSocket 下行 + HTTP 上行 | 🟡 中 |
| 前端分层 | 页面组件内 useState 全部内联 | 三层红线：数据层/渲染层/展示层 | 🔴 大 |

---

## 二、UI 对话界面改造

### 2.1 目标
从「MessageBubble → Card」改为「Event → ConversationNode → Slot 渲染器」，对应 DeepSeek Harness 的 `ui-conversation` + `ui-renderer` 架构。

### 2.2 关键参考

DeepSeek Harness 的 `packages/client/ui-conversation/src/client/chat/` 包含：
- `turn-assistant.ts` — 助手 turn 渲染（纯文字，无卡片包裹）
- `message-chrome.ts` — 消息容器的视觉外框（chrome）
- `tool-node-reader.ts` — 工具节点渲染
- `register-node-renderers.ts` — 节点渲染器注册
- `contract/chat-nodes.ts` — ConversationNodeDefinition 定义

**核心机制：**
1. `ConversationNodeDefinition` 注册一个业务特性：`match(event)` 只读当前事件，`update` fold 一个 Match into State，按 seq 确定性可重放
2. `ConversationNodeAssembler`（conversation-assembler.ts）：双通道 — `replaceWindow`（全量重建）+ `append`（增量 tail）
3. 发布节奏三级：`none < animation-frame < immediate`（Notifier）
4. 渲染器通过 `ctx.slots.register({name, children?, store?, inject?}, Component)` 注册

### 2.3 改造步骤

**Phase 1: 数据层（React-free）**
1. 将 `activityStore` 升级为完整的事件源：用 `useMemo` 投影 events → message thread / activity stream / tool calls
2. 新增 `ConversationNode` 概念：`match(event)` + `update(state, event)` 纯函数
3. 新增 `ConversationNodeAssembler`：`replaceWindow`（断线重连/gap repair）+ `append`（tail 增量）

**Phase 2: 渲染层**
4. 移除 `MessageBubble`/`MemoBubble` 组件的玻璃卡片容器（background/border/backdropFilter）
5. 新增 `ConversationRenderer`：按 eventType 分支渲染纯文字行
6. 工具行：`✓ List D:\gongzuo`（格式对齐 DeepSeek Harness 的 text-only 风格）
7. 消息行：`Streamdown` 渲染模型回复，无卡片包裹

**Phase 3: 传输层（二期）**
8. 可选：SSE → WebSocket 下行 + HTTP 上行（参考 DeepSeek Harness 的 `websocket-downlink.ts`）

### 2.4 触碰红线检查
- ✅ 只改 Agent 输出区域（Chat.tsx/CodingHome.tsx 的渲染部分）
- ✅ 不碰 Sidebar/Header/主题系统/设置页
- ⚠️ 消息气泡的玻璃卡片风格会被纯文字替代（你已明确要求）

---

## 三、权限设置改造

### 3.1 目标
从「单一 Level 1/2/3 整型」改为「per-tool 权限水门（waterfall）」+「预设权限配置」，对应 DeepSeek Harness 的 `ui-permission-presets` + `interaction/`。

### 3.2 关键参考

DeepSeek Harness 的 `packages/client/ui-permission-presets/src/client/`：
- `index.ts` — 权限预设全权选择器（popupSelect），全权访问有显式风险确认
- `presentation.ts` — 权限预设展示
- `settings-store.ts` — 权限设置持久化
- `PermissionRow.tsx` — 权限行组件

**核心机制：**
1. 权限预设是 session 的 `permissions` projection（投影）
2. 每个工具通过 `tools/pre-execute` waterfall 执行权限检查：`allow | deny | ask`
3. Full access 有显式风险确认对话框
4. 权限预设通过 `/permission <preset>` 命令写入

### 3.3 改造步骤

**Phase 1: 权限事件化**
1. 将当前 `permissionLevel` 改为 `permissionPreset`（枚举：`read-only | standard | full-access`）
2. 新增 `permission` 投影（projection），从事件驱动

**Phase 2: 工具级权限**
3. 在 `tools/pre-execute` 已有位置（agents/index.ts 工具执行前）插入权限判断
4. 新增 `ask` 模式：高权限工具弹确认对话框

**Phase 3: UI**
5. 新增权限预设选择器（参考 DeepSeek Harness 的 `PermissionRow`）
6. Full access 切换前显示风险确认

### 3.4 触碰红线检查
- ✅ 权限设置是独立功能，不影响全局 UI
- ⚠️ 需要新增对话框组件，但属于"Agent 输出区域直接相关"

---

## 四、工具调用逻辑改造

### 4.1 目标
从「if/else 链 + 截断字符串」改为「ToolDefinition + 生命周期事件 + presentCall/presentResult」，对应 DeepSeek Harness 的 `tools/` 包。

### 4.2 关键参考

DeepSeek Harness 的 `packages/core/tools/src/index.ts`（1830+ 行）：
- `ToolDefinition`：包含 `execute(args, exec)`、`output schema`、`timeoutMs`、`isConcurrencySafe`、`presentCall`/`presentResult`
- 工具管线：`pre-execute`(waterfall, allow/deny/ask) → `execute`(around-dispatch) → `post-execute`(waterfall, accept/replace/enrich/block) → `result`(emit)
- `ToolExecutionMode`：`exclusive` / `parallel`（isConcurrencySafe opt-in）
- `presentCall(args)`：返回 pending 态卡片视图
- `presentResult(args, result)`：返回完成态卡片视图

### 4.3 改造步骤

**Phase 1: 工具注册表**
1. 将 `files.ts`、`command.ts`、`search-tools.ts`、`lsp-client.ts`、`test-runner.ts`、`code-review.ts`、`mcp-client.ts` 中的工具函数统一为 `ToolDefinition` 格式
2. 每个工具定义：`{ name, description, inputSchema, execute, isConcurrencySafe?, presentCall?, presentResult? }`

**Phase 2: 工具执行管线**
3. 将 `agents/index.ts` 和 `conversations/index.ts` 中的 if/else 链替换为统一调度器
4. 工具执行前发 `pre-execute` 事件 → 执行 → 发 `post-execute` 事件
5. 结果通过 `presentResult` 纯函数渲染

**Phase 3: 并发控制**
6. 实现 `exclusive` / `parallel` 模式
7. 并行工具上限 `maxParallelToolCalls`

### 4.4 触碰红线检查
- ✅ 工具调度是后端逻辑，不涉及 UI 改动
- ✅ 现有工具函数不删除，只统一包装

---

## 五、错误处理改造

### 5.1 目标
从「fetchWithRetry + 一次性错误」改为「结构化错误 + 可重试事件 + durable retry」，对应 DeepSeek Harness 的 `llm-retry` 与 `agent/request-error`。

### 5.2 关键参考

DeepSeek Harness 的 `packages/llm/llm-retry/src/index.ts`：
- 监听 `agent/request-error` waterfall
- 指数退避 + 抖动：`initialDelayMs * 2^exponent` 截断 `maxDelayMs`
- `Each scheduled retry is durable before its cancellable wait` — 每次重试决策先落日志再等待
- `retryPolicy` 归 provider 配置所有

工具错误：`ToolExecutionResult { isError, error:{message, ...} }` — 标准化为结构化错误，模型可读可自纠

### 5.3 改造步骤

**Phase 1: 统一错误格式**
1. 所有工具执行结果标准化为 `ToolExecutionResult { isError, error?: { message, code, details? }, data?: T }`
2. 错误事件 `tool.error` 携带结构化错误信息（已实现，但 content 字段未标准化）

**Phase 2: 重试事件持久化**
3. `agent/request-error` 事件在重试前先落库（参考 DeepSeek Harness 的 durable before cancellable wait）
4. `fetchWithRetry` 的重试决策改为先写 event log 再等待

**Phase 3: Provider 级重试配置**
5. `retryPolicy` 归 provider 配置所有（当前 conversations 模块的 `fetchWithRetry` 硬编码退避表）

### 5.4 触碰红线检查
- ✅ 错误处理是后端逻辑，不涉及 UI
- ✅ 改动集中在后端 `lib/` 和 `modules/` 目录

---

## 六、实施优先级

| 优先级 | 工作项 | 工作量 | 依赖 |
|---|---|---|---|
| P0 | 工具注册表统一（ToolDefinition） | 3-4天 | 无 |
| P0 | 工具执行管线替换 if/else 链 | 2-3天 | 工具注册表 |
| P1 | 错误格式标准化 + 持久化重试 | 1-2天 | 无 |
| P1 | 权限事件化 + 工具级 waterfall | 2-3天 | 工具注册表 |
| P2 | UI 对话界面纯文字化 | 3-5天 | 数据层改造 |
| P2 | 权限预设 UI | 1-2天 | 权限事件化 |
| P3 | 前端三层红线重构 | 5-7天 | 所有 P0-P2 |
| P3 | SSE → WebSocket 下行 | 3-4天 | 无 |

---

## 七、红线对照

| 动作 | 红线判断 | 说明 |
|---|---|---|
| 移除 MessageBubble 玻璃卡片 | 不触 | 你明确要求纯文字 |
| 修改工具调度逻辑 | 不触 | 后端内部逻辑 |
| 修改权限系统 | 不触 | 独立功能模块 |
| 重建前端状态管理 | 不触 | Agent 输出区域直接相关 |
| 修改 Sidebar/Header/主题 | 触 | 不做 |
| 删除现有功能（MCP/Browser等） | 触 | 不做 |
| 改变整体品牌视觉 | 触 | 不做 |

---

## 八、下一步

如果你确认以上计划，我开始按 P0 优先级实施。先从 **工具注册表统一** 开始——把现有 7 个工具模块（files/command/search-tools/lsp-client/test-runner/code-review/mcp-client）统一为 `ToolDefinition` 格式。

请确认：**是否按 P0→P1→P2→P3 顺序全面实施？**