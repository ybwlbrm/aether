# Aether SOURCE_OF_TRUTH — 事实源归属矩阵

> 日期：2026-09-26 ｜ 版本：2.3.0 ｜ 仓库：D:\PersonalAICommandCenter
> 目的：消除重复所有权。每个关注点只有一个权威来源，其余为投影/适配。

---

## 1. 事实源矩阵

| 关注点 | 唯一事实源 | 投影/适配 | 备注 |
|---|---|---|---|
| Run 状态 | `src/backend/src/core/runtime/run.ts` RUN_STATUSES（11 态）→ 收敛至 `src/shared/src/types/index.ts` | 前端 status-pill / routes 校验 / checkpoint 校验 | 5 处重复定义收敛中（AEX-P0-002） |
| Run 生命周期转换 | `src/backend/src/core/runtime/run-lifecycle-manager.ts`（ACTION_FROM/ACTION_TO + CAS） | runs/routes.ts registerTransition | 路由层不得窄化状态白名单 |
| 任务完成判定 | `src/backend/src/core/runtime/execution-completion.ts` evaluateTaskCompletion | wrapper 层不再注入 `content !== ''` 钩子 | AEX-P0-001 收敛中 |
| 执行历史 | `events` 表（EventStore，run-scoped seq） | `activity_events` 表 = legacy 兼容投影（过渡期） | AEX-P0-010 收敛中 |
| 事件 seq | `src/backend/src/core/events/sequence-allocator.db.ts`（UNIQUE(run_id,seq)） | — | 幽灵 claim 行在读取路径过滤 |
| 消息 | `messages` 表（MessageStore） | 前端 mergeMessages | 单一写路径：ConversationMessageService（P1-49） |
| 工具执行结果 | `src/backend/src/core/tools/tool-result.ts` ToolResult 判别联合 | LLM adapter / UI 投影 | Runtime 必须保留结构，UI 才可渲染文本 |
| 工具幂等 | `src/backend/src/core/runtime/execution-retry.ts` RetryCheckpoint | — | toolId+args 键；sideEffectClass 分类扩展中 |
| Retry 策略（任务级） | `src/backend/src/core/runtime/execution-retry.ts` ExecutionRetryController | — | 未知错误默认不可重试（AEX-P0-005 收敛中） |
| Retry 策略（模型级） | `src/backend/src/core/models/retry-policy.ts` | — | STREAM_CLOSED 判定等待生产者（AEX-P0-009） |
| Retry 策略（通用 HTTP） | `src/backend/src/lib/fetch-retry.ts`（非 chat 媒体端点专用） | — | 与 Model RetryPolicy 明确分离（AEX-P0-014） |
| Provider 健康 | `src/backend/src/core/models/circuit-breaker.ts`（provider 级实例，经 model-runtime-bridge 缓存） | — | AEX-P0-007 收敛中 |
| UI 执行状态 | Run 投影（前端 activityStore `*ByRun` API） | 前端不能自造执行状态机 | AEX-P0-012 收敛中 |
| Mobile 状态 | CanonicalRunStatus → MobilePresentationStatus 投影 | mobile 不持有独立执行状态机 | AEX-P0-014 已修 |
| 通知 | `src/frontend/src/lib/notification-center.ts` | 旧 `lib/notifications.ts` 待删（P2-011） | 仅由终端 Run 事件触发 |
| Workflow 节点状态 | `workflow_node_runs` 表（新增中） | engine 内存态 / 前端内联投影 | AEX-P0-015 |
| 错误分类 | `src/backend/src/core/errors/`（RuntimeError 层次） | 前端展示文本 | 错误码供程序，文本供人（P1-85） |

---

## 2. 双写收敛状态（2026-09-26）

```
events 表（canonical）              activity_events 表（legacy 投影）
┌─────────────────────┐            ┌──────────────────────────┐
│ run-scoped seq       │   收敛方向  │ conversation-scoped seq  │
│ DbSequenceAllocator  │ ─────────► │ 由 Projector 从 events 表│
│ 44 事件判别联合       │            │ 投影生成（不再直接双写）   │
└─────────────────────┘            └──────────────────────────┘
```

- **当前**：`lib/event-bus/bus-core.ts` emit() 仍直接写 activity_events（双写）。
- **目标**：`events` 表为唯一事实源；`activity_events` 由 `core/events/event-projector.ts` 从 events 投影（read/write compatibility projection）。
- **过渡策略**：关键状态迁移（run.created/started/completed/failed/cancelled）await 确认写入 events 表（AEX-P0-011）；legacy 写入仅保留在非关键投影路径。
- **禁止**：未知 legacy 事件映射到 `run.created`（AEX-P0-016）——未知 → reject 或 `legacy.unknown`。

---

## 3. 状态机归属

| 状态机 | 位置 | 消费方 |
|---|---|---|
| Run 11 态 | `core/runtime/run.ts` RunStateMachine | backend 全层、前端投影、routes |
| Task 状态 | `core/runtime/task.ts` | execution-loop |
| Loop CompletionState | `core/runtime/execution-loop.ts` | wrapper 层（不自行判定） |
| Workflow 节点状态 | `workflow_node_runs.status`（新增） | engine / 前端 RunHistory |
| Remote command 状态 | mobile `remote_commands.status` | mobile UI（Run 终态的 command 级投影） |

---

## 4. 规则（强制）

1. **不新增重复状态清单**：任何模块需要 Run 状态时 `import { RUN_STATUSES } from '@pacc/shared'`。
2. **不新增完成判定**：任务完成只能经 `evaluateTaskCompletion`；wrapper 层禁止 `content !== ''` 语义。
3. **不新增事件写入路径**：Runtime 事件一律经 `EventStore`（events 表）。
4. **不新增重试实现**：模型 → RetryPolicy；任务 → ExecutionRetryController；工具 → ToolRecoveryController；通用 HTTP → fetch-retry（仅非 chat）。
5. **不新增工具结果定义**：一律用 `ToolResult` 判别联合。
6. **不新增消息合并实现**：一律用共享 `mergeMessages()`。
7. **错误控制流用 code，不用 message**（`error.code === 'MODEL_TIMEOUT'`，禁止 `message.includes('timeout')`）。
