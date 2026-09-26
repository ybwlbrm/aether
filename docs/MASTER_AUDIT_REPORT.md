# AETHER MASTER AUDIT REPORT

> 阶段：PHASE 1-7（仓库盘点 → 依赖映射 → 文件级审计 → 运行时审计 → UI/UX 审计 → 测试审计 → 本报告）
> 日期：2026-09-26 ｜ 仓库：D:\PersonalAICommandCenter ｜ 版本：2.3.0 ｜ git HEAD：d5fe152
> 方法：6 个并行 explore 代理取证 + 人工核验全部文件:行号证据 + 基线命令实测
> 原则：**当前源码为权威**，不信任历史审计文档中的 FIXED/DONE 标记

---

## 一、仓库基线

| 项 | 值 |
|---|---|
| Workspaces | shared / backend / frontend / mobile (+ electron / android / build) |
| 测试文件 | backend 114 / frontend 7 / mobile 5 / shared 2 = 128 个 `*.test.ts` |
| 测试基线 | backend 1257 / frontend 87 / mobile 39 / shared 33 = 1416 pass（RE-AUDIT 实测） |
| typecheck | ✅ 通过（shared + backend + frontend + mobile 全绿） |
| 未提交修改 | execution-loop.ts(+209)、execution-checkpoint.ts(+31)、Chat.tsx(+97)、CodingHome.tsx(重写1384)、新增 conversation/ 组件目录、CodingHome.test.tsx |

**关键工作树状态**：execution-loop.ts 的 CompletionEvaluator 接线（judgeLoopCompletion）是**工作区未提交改动**，HEAD 版本仍是裸二元判定。此工作必须保留并在其上继续。

---

## 二、架构图（真实调用链）

```
User → Conversation (chat-handler / orchestration / command-processor)
        ↓
      Run (RunLifecycleManager createAndStart → transition / CAS + stale recovery)
        ↓
      Task (taskId=runId)
        ↓
      Execution Loop (execution-loop.ts ← 唯一执行器；3 个 wrapper 委托)
        ↓
      Model Runtime (provider-adapter → retry-policy / circuit-breaker)
        ↓
      Tool Runtime (ProductionToolExecutor / ToolRecoveryController)
        ↓
      Event Runtime (EventStore(events 表) + legacy EventBus(activity_events 表) ← 双写)
        ↓
      SSE → Frontend Chat / CodingHome / Mobile
```

---

## 三、P0 问题验证结果（18 项）

### AEX-P0-001 — Completion 仍默认 `content !== ''` — **未修复**

| 位置 | 状态 |
|---|---|
| `modules/conversations/tool-loop.ts:322` | ❌ 仍注入 `isTaskComplete: (resp) => resp.content.trim() !== ''` |
| `modules/agents/tool-loop.ts:313` | ❌ 同上 |
| `modules/sync/command-processor.ts:783` | ❌ 同上 |
| `core/runtime/execution-loop.ts:370-393` | ⚠️ judgeLoopCompletion 已接线（未提交），但 L374 `if (deps.isTaskComplete)` **最高优先级短路**，L383 evaluateTaskCompletion 是死代码 |
| `core/runtime/execution-completion.ts` | ✅ 169 行完整 evaluator（已提交），五级瀑布判定，`execution-completion.test.ts` 7 用例 |

**机制**：evaluator 认为"有文本只是进度 → continue"，wrapper 钩子认为"有文本即 complete"。运行时执行的是后者。规范承诺与实际行为相反。
**类型命名**：`CompletionDecision/CompletionReason/ContinueReason` 全库不存在，实际为 `CompletionStatus/CompletionVerdict/TaskCompletionEvaluator/CompletionState`。
**注意**：execution-loop.test.ts:958-964 有测试断言"显式注入的 isTaskComplete 优先于缺省 evaluator"，移除旁路需同步改写。

### AEX-P0-002 — Canonical Run status 未全局共享 — **未修复（5 处重复定义）**

| # | 位置 | 态数 | 缺失 |
|---|---|---|---|
| 1 | `core/runtime/run.ts:12-26` RUN_STATUSES | 11 | 权威源 |
| 2 | `modules/runs/routes.ts:26` 私有 RUN_STATUSES | 7 | retry_waiting/retrying/verifying/budget_exceeded |
| 3 | `core/runtime/checkpoint.ts:105-113` validStatuses | 7 | 同上 |
| 4 | `frontend/components/ui/status-pill.tsx:5-14` | 8 | created/waiting/retry_waiting |
| 5 | `db/schema/index.ts:221-235` | 11 | 与 run.ts 一致 |
| 6 | `core/runtime/run.test.ts:21-33` | 11 | 测试硬编码副本 |

**shared 层完全缺失** Run 状态类型。mobile 无 Run 状态定义（走 remote_commands 语义）。
**类型断裂**：routes.ts:23 `type RunStatus = RunRow['status']` 绕开 run.ts 的 RunStatus，让 7 态数组编译期合法。

### AEX-P0-003 — 预算耗尽触发隐藏模型调用 — **未修复**

`chat-handler.ts:456`：
```ts
if (!endedNormally && executionEndReason !== 'cancelled' && !aiContent && !aiError) {
  const forceSummary = await executeForceSummary(...)  // ← 未排除 budget_exceeded
```
预算耗尽 + 无文本时仍会发起额外模型调用（executeForceSummary）。规范要求 budget_exceeded/cancelled/interrupted/failed 均不得触发隐藏模型调用。

### AEX-P0-004 — Run 取消白名单滞后 — **未修复（双层闸门）**

`routes.ts:227`：`registerTransition('/api/runs/:runId/cancel', 'cancel', ['running', 'waiting'], ...)`
状态机 `run-lifecycle-manager.ts:93` 已支持 `cancel: ['running','waiting','retry_waiting','retrying','verifying']`。
**单点修复**：routes.ts:227 补齐 3 态。附带：routes.ts:263 查询参数校验同用 7 态数组 → `GET /api/runs?status=retry_waiting` 返回 400。

### AEX-P0-005 — 未知错误默认 retryable — **未修复（三处矛盾）**

| 函数 | 位置 | 未知错误默认 |
|---|---|---|
| `isTaskRetryable` | `execution-retry.ts:178` | **true（重试）** |
| `isToolRetryable` | `execution-retry.ts:225` | TypeError 才重试 → 否则 false |
| `isRetryable`（共享层） | `errors/retry-error.ts:199` | false |

同一未知错误在 task 层重试 8 次、tool 层 0 次、共享层判定不可重试。附带：`execution-retry.ts:170` RetryExhaustedError → true，与其余两层相反。

### AEX-P0-006 — Tool retry 幂等 — **部分实现**

- ✅ `RetryCheckpoint`（execution-retry.ts:72-119）markToolCompleted/isToolCompleted（toolId+args 幂等缓存）
- ✅ `ToolResult` 结构化判别联合（tool-result.ts，success/error/timeout/cancelled/pending-approval）
- ❌ 缺 `idempotencyKey`/`toolCallId`/`attempt`/`sideEffectClass` 字段（规范 P1-033 契约）

### AEX-P0-007 — CircuitBreaker 请求级生命周期 — **未修复（死代码）**

- `circuit-breaker.ts:40-43` 状态在闭包变量，factory 每次调用新建
- 实例化链：`buildModelRuntime(model-runtime-factory.ts:35)` → `new OpenAICompatibleAdapter(:36)` → `createFetchTransport(:342-350)` → `createCircuitBreaker(:166)` — **每请求一个全新熔断器**
- `recordFailure` 仅在重试耗尽分支调用（:206/232/251）→ 单请求最多累计 1 次失败，阈值 5 → `state` 恒为 closed，CIRCUIT_OPEN 不可达
- 对照：被收编的 `fetch-retry.ts:8` 模块级 endpoint Map **才是正确的 provider 级共享**
- `orchestration.ts:209` `buildAllRuntimes(...)` 返回值被丢弃 → 预热无效
- ProviderRuntimeRegistry **不存在**

### AEX-P0-008 — CircuitBreaker 成功在流完成前记录 — **未修复**

`provider-adapter.ts:255` `recordSuccess()` 在 :256 `getReader()` **之前**执行。HTTP 200 头到手即清零失败计数。后续流截断/连接重置 recordFailure 永不调用。

### AEX-P0-009 — 流截断不参与重试 — **未修复（机制已定位）**

- 截断在 `model-runtime.ts:247` 落地为 `interrupted: true` 标志
- `execution-loop.ts:560` `return { kind: 'interrupted', ... }` **用 return 而非 throw** → runRetryLoop 视作成功直接返回，shouldRetry 永不调用
- `retry-policy.ts:74` 与 `execution-retry.ts:205` 的 STREAM_CLOSED 可重试判定是**死分支**（无生产者）
- 注意 :669-672 max-tokens/content_filter 也走 interrupted，须区分可重试断流与正常截断

### AEX-P0-010 — EventStore 未成唯一事实源 — **未修复（双写）**

- `lib/event-bus/bus-core.ts:39-77` 写 activity_events（conversation-scoped seq）
- `lib/event-store-runtime.ts:138` 写 events（run-scoped seq）
- orchestration.ts 同分支双写（如 :942 legacy + :948 v2）；21 处 eventBus.emit + 8 处 emitV2Event
- `event-projector.ts` 生产零引用 → 无投影关系，两表可各自漂移

### AEX-P0-011 — 关键事件 fire-and-forget — **未修复（8/8 全 void）**

- orchestration.ts:258/479/480（critical:true）+ :909/931/948/980 + workflows/index.ts:164 — **全部 `void emitV2Event`，零 await**
- **自相矛盾**：orchestration.ts:257 注释"P0-11: run.created 为关键事件，失败必须显式暴露" + :267-272 try/catch 补偿 → 但 void 使 catch **类型层面不可能捕获** rejection → 补偿是死代码
- 附带：`event-store-runtime.ts:84` mapEventTypeToV2 **零调用点（死代码）**；`mapWorkflowEventType:97` 缺 agent.stopped

### AEX-P0-012 — Activity 必须 Run 作用域 — **未修复（采用替代方案）**

- Chat.tsx:528 / CodingHome.tsx:1074 仍传 `conversationId` 给 `ConversationActivityStream`
- `conversation/activity-stream.tsx:7-9` props 只有 conversationId，无 runId 入口；Chat.tsx 全文 runId 出现 0 次
- 替代方案：Chat.tsx:527 注释"活动流按会话聚合，只渲染一份"——消除了重复投影**症状**，但作用域仍是 conversation
- **store 层 run 粒度能力已完备**：eventsByRun 按 runId 索引 + 7 组 *ByRun 变体全实现 → 改 runId 作用域 store 零改动，成本在 activity-stream.tsx props + 2 调用点 + currentRunId 来源

### AEX-P0-013 — CodingHome clearConv 破坏历史 — **部分修复**

- ✅ clearConv/clearRun 调用已清零（useStreamSend.ts:364 注释"P1-13：不再 clearConv"），CodingHome.test.tsx:138-166 回归锁
- ❌ CodingHome.tsx:427-435 仍创建 `role: 'assistant'` 的"⚠️ 等待桌面端响应超时"假消息
- ❌ CodingHome.tsx:413-418 远程命令失败同样伪造 assistant 消息
- 失败态统一到 StreamFailureState 只覆盖 useStreamSend 流式路径，window 'remote-command' 事件路径被遗漏

### AEX-P0-014 — Mobile 从 assistant 消息推断完成 — **已修复**

- `mobile/lib/message-store.ts:132-147` resolveChatCompletion：assistant_message 硬编码 busy，只有 remote_command_status 的 completed/failed/cancelled 结算终态
- hasAssistantAfter 注释显式禁止作为完成依据；message-completion.test.ts 6 用例覆盖
- 残留观察：判定粒度是 remote command 级而非 run 终态事件级

### AEX-P0-015 — Workflow 节点持久化 — **未修复**

- `db/schema/index.ts:177-186` workflow_runs 只有 currentNodeId + results JSON；**workflow_node_runs 全库零命中**
- 节点态写回两处皆瞬时：engine:156-159 写单列 currentNodeId（并行节点互相覆盖）、engine:434-441 终态一次性覆盖 results JSON

### AEX-P0-016 — Workflow 取消传播 — **引擎层已实现，路由未接线**

- ✅ engine:244-250 AbortController + runCancellationRegistry 注册；:283-286/:320-323/:347-349/:355 检查点；signal 下传节点（node-executors.ts:109/146-148/187/264）
- ✅ runs/routes.ts:227 `runCancellationRegistry.cancel(runId)` 可中止 workflow run
- ❌ workflows/index.ts:141-178 调用 executeWorkflow **未传 signal** → HTTP 断开只靠 engine:329-332 socket.destroyed 兜底（failed 而非 cancelled，且在整波 await 之后）

### AEX-P0-017 — Workflow 节点失败字符串化 — **部分修复（活跃漏洞）**

- ✅ node-executors.ts:17-19 nodeFailure 统一填 error；engine:128-131 非空 error 判 failed
- ❌ **tool 节点** node-executors.ts:84-85 `return { output }` 不带 error；lib/files.ts 失败以字符串返回（:118/119/131/140/160/168/173/175 `错误: xxx`）→ engine 判定 **completed**
- ❌ **system 节点** :264-265 同形状
- `StructuredError` 类型不存在；NodeExecutionResult（types.ts:1-5）无 status/attempt/code

### AEX-P0-018 — Workflow 节点重试/恢复 — **未修复（基建已存在）**

- workflows 模块 retry 命中仅 fetchWithRetry（media 节点 HTTP 层）+ engine:431 `retryable: false` 字面量
- 无 attempt 计数、backoff、checkpoint 恢复；engine:299-308 Promise.allSettled 跑完整波，失败即 break
- **可复用基建**：core/runtime/execution-retry.ts 487 行（ExecutionRetryController maxRetries 8 / ToolRecoveryController 3 / RetryCheckpoint / isToolRetryable）+ retry-policy.ts + cancellation.ts

---

## 四、P0 总结

| 编号 | 状态 | 核心文件 |
|---|---|---|
| AEX-P0-001 | ❌ 未修复 | 3 wrapper + execution-loop.ts:374 |
| AEX-P0-002 | ❌ 未修复（5 处重复） | run.ts / routes.ts / checkpoint.ts / status-pill.tsx |
| AEX-P0-003 | ❌ 未修复 | chat-handler.ts:456 |
| AEX-P0-004 | ❌ 未修复（一行） | routes.ts:227 |
| AEX-P0-005 | ❌ 未修复 | execution-retry.ts:178 |
| AEX-P0-006 | ⚠️ 部分 | RetryCheckpoint 有，缺契约字段 |
| AEX-P0-007 | ❌ 未修复（死代码） | model-runtime-factory.ts / provider-adapter.ts:166 |
| AEX-P0-008 | ❌ 未修复 | provider-adapter.ts:255 |
| AEX-P0-009 | ❌ 未修复 | execution-loop.ts:560 |
| AEX-P0-010 | ❌ 未修复（双写） | bus-core.ts / event-store-runtime.ts |
| AEX-P0-011 | ❌ 未修复（8/8 void） | orchestration.ts |
| AEX-P0-012 | ⚠️ 替代方案 | Chat.tsx / activity-stream.tsx |
| AEX-P0-013 | ⚠️ 部分 | CodingHome.tsx:427-435/413-418 |
| AEX-P0-014 | ✅ 已修复 | message-store.ts |
| AEX-P0-015 | ❌ 未修复 | schema / engine |
| AEX-P0-016 | ⚠️ 引擎已实现，路由未接线 | workflows/index.ts |
| AEX-P0-017 | ⚠️ 部分（tool/system 漏网） | node-executors.ts:84/264 |
| AEX-P0-018 | ❌ 未修复（基建有） | execution-engine.ts |

**P0 汇总：8 未修复 / 6 部分 / 1 已修复 / 3 混合**（007 含 010 双写、008 含 011 void 等关联）

---

## 五、P1/P2 关键发现（RE-AUDIT 追踪 + 本次复核）

| 类 | 发现 | 证据 |
|---|---|---|
| Chat/CodingHome 合并 | ❌ ConversationRuntime 0 调用；CodingHome.tsx 1110 行、Chat.tsx 689 行 | IS-04/CH-10 |
| UI 迁移 | Sidebar/Activity/Composer 未修；PageShell 2/21；glass-card 38 文件/109 处 | UI-01~08 |
| 双通知 | lib/notifications.ts + notification-center.ts | DU-03/CO-06 |
| 双上下文 | core/runtime/run-context.ts + runtime-context.ts | CO-07 |
| 超大组件 | Settings.tsx 1286 行、execution-loop.ts 882 行 | CO-02/03 |
| ai-elements | 1890 行 0 引用（死代码） | CO-09/DU-02 |
| 测试缺口 | 14 项（mobile 组件 0 测试、Chat UI 0 测试、视觉 QA 0 执行） | TG-01~14 |
| E2E | playwright.config.ts 引用 tests/e2e 但**目录不存在** | TG-14 |
| `any` | 全仓 365 处（backend 147 / frontend 218） | 1.8 |
| 构建 | EXE/APK 产物存在但未安装冒烟；NSIS 失败仅告警；CI 无 Android/EXE job | RL-01/02/BD-04 |

---

## 六、修复顺序（按规范 §128 Phase A→J）

| Phase | 内容 | 波次 |
|---|---|---|
| A | Canonical 类型（RunStatus/Attempt/Error/ToolResult 契约） | W-A |
| B | CompletionEvaluator 接线（移除 3 wrapper 旁路） | W-B |
| C | Retry/Cancellation/Checkpoint/Recovery（retryable 默认、CB 生命周期、截断重试、cancel 白名单、事件 await） | W-C |
| D | EventStore/Replay/Projection（双写收敛、unknown 映射） | W-D |
| E | Conversation/Chat/CodingHome（run 作用域、超时消息、共享 runtime） | W-E |
| F | Workflow/Super Agent（node_runs 表、结构化错误、取消接线、节点重试） | W-F |
| G | Mobile（Run 投影） | W-G |
| H | UI/Design System/Accessibility/Responsive | W-H |
| I | Performance | W-I |
| J | Build/CI/Release/Docs | W-J |

---

## 七、已有良好基础（不推倒重来）

- ✅ execution-completion.ts evaluator 完整（169 行 + 7 测试）
- ✅ execution-checkpoint.ts + 进程内仓库（未提交，需保留）
- ✅ run.ts 11 态状态机 + CAS + stale recovery（30 分钟 lease）
- ✅ SqliteEventStore + DbSequenceAllocator（__seq_claim 仲裁 + UNIQUE 索引）
- ✅ 44 事件判别联合 + RetryLayer/RetryType 类型
- ✅ ToolResult 判别联合 + RetryCheckpoint 幂等缓存
- ✅ workflow AbortSignal 引擎层传播 + 取消测试
- ✅ mobile resolveChatCompletion 终态结算
- ✅ Electron health/EADDRINUSE/recovery/CSP 单实例锁
- ✅ 1416 测试基线全绿

*本报告为 PHASE 7 交付物。后续修复执行按上表波次推进，每波完成后立即验证（typecheck + 测试 + build）。*
