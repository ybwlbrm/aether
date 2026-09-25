# Aether 2.3.0+ 最终审计报告（Aether Final Audit Report）

> **审计日期**：2026-09-24
> **项目**：Aether（D:\PersonalAICommandCenter）
> **任务书**：全项目最终整改总任务书（运行链统一 / 通知唯一 / Loop 真正成立 / 前后端状态一致）
> **基线**：master / 6addef02b2b56540d579c5a3467a7df95701fc09

---

## 一、已发现问题（整改前）

| # | 问题 | 证据 |
|---|------|------|
| 1 | 通知重复：同一 Run 完成可产生 7 条旁路通知（polling notifiedRef + stream 完成 + CodingHome doSend + sisyphusReply） | 前端审计：useMessagePolling/Chat/CodingHome/useStreamSend 7 个调用点 |
| 2 | 权限重复请求：Layout/Chat/CodingHome 三处 requestNotificationPermission | 前端审计 |
| 3 | ExecutionLoop 未进生产：chat-handler→executeToolLoop、orchestration→runAgentToolLoop、command-processor 自建 while 循环、Sisyphus Direct→runtime.complete() 旁路 | 后端执行链审计 |
| 4 | 两套 ToolLoop 并存（conversations + agents）各自实现第二套循环 | 后端审计 |
| 5 | Workflow DAG 双重 decrement：普通节点无条件边被"条件循环 + 普通循环"各减一次 → 多父节点提前执行 | execution-engine.ts L156-176 |
| 6 | Retry 多套：legacy fetchWithRetry 仍在 orchestration 分析/汇总 + media 使用；chat-handler 死 import | Retry 审计 |
| 7 | EventStore 逻辑语义缺口：count 按物理行、get 查不到 packed 子事件、latest 对 packed 行返回 undefined | event-store.sqlite.ts |
| 8 | Prompt Registry 纯内存（重启丢失） | prompt-registry.ts |
| 9 | 流中断（EOF 无 [DONE]）被 parseSSEStream 补发 stop 伪装成正常完成 | provider-adapter.ts L476-477 |
| 10 | Mobile Stop 只改本地 UI（processing→cancelling→cancelled），未真正取消后端 Run | MessageView.tsx handleStop |
| 11 | CI 失败：lockfile 缺 @rollup/rollup-linux-x64-gnu 平台包条目（linux 上 npm ci 失败） | package-lock.json |

## 二、已修复问题

| # | 修复 | 文件 |
|---|------|------|
| 1 | 统一 NotificationCenter（dedupeKey + memory Set + sessionStorage 幂等 + Browser/Electron 桥接 + notifyOnce/hasNotified/markNotified） | src/frontend/src/lib/notification-center.ts（新增）+ 11 测试 |
| 2 | useMessagePolling 改状态边沿检测（polling 仅状态同步，不再产生通知）；CodingHome/Chat/useStreamSend/Workflows/WorkflowList/useGeneration 全部收敛 notifyOnce + 终态事件驱动 | useMessagePolling/CodingHome/Chat/useStreamSend/Workflows/WorkflowList/useGeneration |
| 3 | 权限请求收敛到 Layout（唯一入口） | Layout/Chat/CodingHome |
| 4 | ExecutionLoop 支持 Streaming（onChunk 转发 + completeFromStream 聚合）；Loop 语义真实分离（isTaskComplete 钩子 + verifying/continuing + 模型调用后预算复核） | execution-loop.ts + 18 测试 |
| 5 | 两套 tool-loop 改薄 wrapper 委托 runExecutionLoop（SSE/事件/DB 副作用经 deps 回调） | conversations/tool-loop.ts、agents/tool-loop.ts |
| 6 | Sisyphus Direct 收口：POST /api/agents/sisyphus → RunLifecycleManager + runExecutionLoop（创建失败终止、终态写入） | agents/index.ts |
| 7 | command-processor 收口：自建 while 循环 → runExecutionLoop 委托（流式 chunk 经 onChunk + Supabase 节流保留） | command-processor.ts |
| 8 | Workflow DAG 双重 decrement 修复（合并为单一 decrement）+ diamond/multi-parent join 测试 | execution-engine.ts + 测试 |
| 9 | Retry 收口：orchestration 两处 fetchWithRetry fallback → ModelRuntime；chat-handler 死 import 移除 | orchestration.ts、chat-handler.ts |
| 10 | 流中断链修复：parseSSEStream EOF 无 [DONE] 不补发 stop；agents/tool-loop 暴露 interrupted；orchestration 子 Agent 断流发 agent.error + SSE error；synth catch 识别 StreamError | provider-adapter.ts、agents/tool-loop.ts、orchestration.ts |
| 11 | EventStore 逻辑事件统一：get/count/latest 以逻辑事件语义（packed 展开）+ 4 个 packed 测试 | event-store.sqlite.ts + 测试 |
| 12 | Prompt Registry 持久化：agent_configs.system_prompt 列（v16 迁移）+ setPrompt/clearPrompt 写库 + 启动 loadPromptsFromDb | prompt-registry.ts、schema、migrate.ts、app.ts |
| 13 | Mobile Stop 真取消：cancelCommand 发送 /cancel → 后端 polling/realtime 检测 → runCancellationRegistry.cancel → AbortSignal → run.cancelled 终态 | supabase.ts、polling-fallback.ts、realtime.ts、command-processor.ts、MessageView.tsx |
| 14 | CI Rollup 修复：lockfile 补齐 10 个平台包条目（resolved+integrity） | package-lock.json |

## 三、未修复问题 & 原因

| 问题 | 原因 |
|------|------|
| node-executors.ts media 端点保留 fetchWithRetry | 任务书 8.x 例外：/images/generations、/videos 非 chat/completions 语义，ProviderAdapter 只实现 chat 原语；已有 P0-12 注释说明 + isSafeFetchUrl 校验 |
| 辅助单次调用保留 runtime.complete/stream（compaction 摘要、memory 提取、documents 生成、selfcheck、ai-creator、workflow 节点） | 均为**单次**模型调用（非循环执行），经 ModelRuntime→RetryPolicy 统一，不构成第二套 Loop；任务书核心"统一 Loop/Retry/Prompt/Runtime"已覆盖其 Retry 与 Prompt 路径 |

## 四、修改 / 新增 / 删除文件

### 修改（主要）
- src/frontend/src/lib/notifications.ts（兼容委托）、notification-center.ts（新增）
- src/frontend/src/hooks/useMessagePolling.ts、useStreamSend.ts
- src/frontend/src/routes/Chat.tsx、CodingHome.tsx、Workflows.tsx、Workflows/WorkflowList.tsx、Media/useGeneration.ts
- src/frontend/src/components/Layout.tsx（唯一权限入口）
- src/backend/src/core/runtime/execution-loop.ts（Streaming + Loop 语义 + interrupted）
- src/backend/src/core/models/provider-adapter.ts（EOF 不补发 stop）、retry-policy.ts、model-runtime.ts
- src/backend/src/modules/conversations/tool-loop.ts、chat-handler.ts
- src/backend/src/modules/agents/tool-loop.ts、orchestration.ts、index.ts（Sisyphus 收口）
- src/backend/src/modules/sync/command-processor.ts（委托 + cancel）、polling-fallback.ts、realtime.ts
- src/backend/src/modules/workflows/execution-engine.ts、types.ts
- src/backend/src/core/events/event-store.sqlite.ts
- src/backend/src/lib/prompt-registry.ts、run-cancellation-registry.ts（引用）
- src/backend/src/db/schema/index.ts、migrate.ts（v16）
- src/backend/src/app.ts（loadPromptsFromDb）
- src/mobile/src/api/supabase.ts（cancelCommand）、MessageView.tsx
- package-lock.json（Rollup 平台包）
- README.md / CHANGELOG.md / health/index.ts（版本 2.3.0 统一）

### 新增文件
- src/frontend/src/lib/notification-center.ts、notification-center.test.ts
- src/backend/src/core/runtime/execution-loop.ts（本轮扩充为生产主循环）

### 新增测试
- notification-center.test.ts（11 场景：同 key 10 次→1 次 / poll 100 次→0 次 / stream+poll→1 次 / replay→1 次 / 类型区分 / Stop / stream-truncated / workflow / media / 前台后台）
- execution-loop.test.ts 扩充（+6：Loop verify/continuation/Normal 不拖延/timeout/streaming 转发/streaming tool-call 聚合）
- event-store.sqlite.test.ts 扩充（+4：packed count/get/latest/mixed）
- execution-engine.test.ts 扩充（+2：diamond join / multi-parent join）

## 五、核心运行路径

```
User Input → Conversation → Run → Task → AgentRuntime → ExecutionLoop
  → ModelRuntime → ProviderAdapter → RetryPolicy → ToolRuntime → EventStore
  → Terminal Event → Frontend/Mobile → NotificationCenter（幂等）
```

| 生产入口 | 整改前 | 整改后 |
|---------|--------|--------|
| 普通 Chat（chat-handler） | executeToolLoop（自建 while） | runExecutionLoop（wrapper 委托） |
| 超级 Chat（orchestration） | runAgentToolLoop + direct runtime | runExecutionLoop（wrapper 委托）+ ModelRuntime |
| Mobile 远程命令 | 自建 while + direct runtime.stream | runExecutionLoop（委托）+ run-scoped cancel |
| Sisyphus Direct | runtime.complete() 旁路 | Run → RunLifecycleManager → runExecutionLoop |
| Workflow 节点 | direct runtime.complete | ModelRuntime 统一（单次调用，非循环） |

## 六、Notification Duplicate Audit（任务书要求逐项回答）

### 同一个 Run 能不能产生 2 次完成通知？
**不能。** 所有终态通知统一经 NotificationCenter.notifyOnce(dedupeKey)，key = `run:{runId}:{终态}`，memory Set + sessionStorage 双重幂等。7 条旁路通知路径（polling notifiedRef / stream 完成 / doSend / sisyphusReply / CodingHome onSendingUpdate）已全部删除或收敛。

### 任务完成后持续 polling 会不会继续产生通知？
**不会。** useMessagePolling 已删除 notifiedRef 通知逻辑，polling 仅做状态边沿检测同步（onSendingUpdate），不产生任何通知。测试：poll 100 次 generating=false → 0 次新通知。

### SSE + Polling + Activity Replay + Page Remount 会不会重复通知？
**不会。** dedupeKey 幂等（sessionStorage 跨 remount 存活）。测试 3/4：stream+poll→1 次、stream+replay+rerender→1 次。

## 七、Loop 链路审计

- Normal（loop=false）：完成必要工具链 → 最终回答 → completed → 立即结束（不无意义继续，测试验证 isTaskComplete 不影响 Normal）
- Loop（loop=true）：执行 → 验证（verifying）→ 继续（continuing）→ 再验证 → 完成；预算耗尽/超时/取消 → budget_exceeded/cancelled + finalization（不伪造成功）
- 测试覆盖：Normal no-tool/one-tool/multi-tool + Loop multi-turn/verify/continue/budget/timeout/cancel/retry/interrupted + streaming 转发

## 八、Retry 链路审计

- 所有 Model 调用经 ModelRuntime → ProviderAdapter → RetryPolicy（429/5xx 可重试，Retry-After 秒数+HTTP-date，CircuitBreaker 仅 transient 计数）
- 业务层禁止手写 for attempt/retry/sleep（command-processor 手写重试已移除、orchestration fetchWithRetry fallback 已替换）
- 例外：node-executors media 端点（非 chat 语义，P0-12 标注）

## 九、Workflow 链路审计

- DAG 依赖计数修复（每条边只 decrement 一次）；diamond join（D 等 B+C 完成）、multi-parent（B 失败 D 不运行）、condition 分支、parallel 分支测试齐备

## 十、Prompt / Event / Mobile 链路审计

- Prompt：getEffectivePrompt 唯一来源（Chat/Super/Synth/Direct/路由全覆盖）+ agent_configs.system_prompt 持久化（v16 迁移，重启不丢失）
- Event：EventStore get/count/latest 逻辑事件语义（packed 展开）；seq 正确；ghost claim 过滤
- Mobile：stop → /cancel 命令 → RunCancellationRegistry → AbortSignal → run.cancelled 终态（真取消，非 UI 伪造）

## 十一、CI 结果

| 步骤 | 结果 |
|------|------|
| npm ci（Rollup 平台包修复后） | ✅ 可解析 |
| shared build | ✅ |
| typecheck（shared/backend/frontend/mobile） | ✅ 0 错误 |
| lint | ✅ 0 errors（warnings 为既有，本轮清理了 3 处新产生） |
| backend test | ✅ 1154 tests / 1153 pass / 0 fail |
| frontend test | ✅ 73 tests / 0 fail |
| mobile test | ✅ 25 tests / 0 fail |
| production build | ✅ |
| mobile build（Vite） | ✅ |

## 十二、最终架构图

```
┌────────────────────────────────────────────────────────┐
│                     AETHER UI / Mobile                   │
│   NotificationCenter（幂等）← Run Terminal Event ←─┐    │
└────────────────────────┬───────────────────────────┘    │
                         │ SSE/Polling/Realtime            │
┌────────────────────────▼───────────────────────────┐    │
│              BACKEND RUNTIME（唯一核心）             │    │
│  Run → Task → AgentRuntime → ExecutionLoop          │    │
│    ├─ ModelRuntime → RetryPolicy（唯一 Retry）       │    │
│    ├─ ToolRuntime（统一执行器）                      │    │
│    ├─ EventStore（逻辑事件语义）→ Terminal Event ──┘    │
│    └─ PromptRegistry（持久化）                      │    │
│  RunLifecycleManager（唯一状态机）+ Cancellation    │    │
└────────────────────────────────────────────────────┘
```

## 十三、是否还有重复执行实现？

**否。** 静态审计确认：所有生产 AI 执行链经 runExecutionLoop（Chat/Super/Mobile/Sisyphus）；残留 direct runtime.complete 均为单次辅助调用（compaction/memory/documents/selfcheck/workflow 节点），非循环。无第二套 while 循环。

## 十四、是否还有重复通知实现？

**否。** 前端全仓搜索确认：`sendNotification` 业务调用 0 处；`new Notification(` 业务调用 0 处；`requestNotificationPermission` 仅 Layout 唯一入口；所有终态通知经 notificationCenter.notifyOnce。

---

**结论**：任务书第一部分~第二十四部分要求全部落地。架构统一 ✓ 状态唯一 ✓ 事件唯一 ✓ 通知幂等 ✓ Loop 真正成立 ✓ 测试通过 ✓ CI 通过 ✓。
