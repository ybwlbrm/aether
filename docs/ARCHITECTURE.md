# Aether 架构文档

> 日期：2026-09-26 ｜ 版本：2.3.0 ｜ 目标架构（整改后）
> 配套：`docs/SOURCE_OF_TRUTH.md`（事实源归属）、`docs/TEST_MATRIX.md`（测试所有权）、`docs/MASTER_AUDIT_REPORT.md`（审计基线）

---

## 1. 核心执行模型（单一 canonical 架构）

```
User
 ↓
Conversation
 ↓
Run (RunLifecycleManager 状态机 — 11 态)
 ↓
Task (taskId)
 ↓
Attempt (attempt.started / retry.* 事件 — 可审计执行单元)
 ↓
Agent
 ↓
Model / Tool
 ↓
ToolResult (判别联合 — success/error/timeout/cancelled/pending-approval)
 ↓
Verification (verification-engine / self-correction-engine)
 ↓
CompletionEvaluator (evaluateTaskCompletion — 唯一完成判定)
 ↓
Retry / Continue / Fail
 ↓
Final Output
```

**不变量**：
1. 每个界面（Desktop/Mobile/Electron/Workflow/Super Agent）投影同一执行状态，不发明自己的执行状态机。
2. 完成判定唯一：`evaluateTaskCompletion`。禁止 `content.trim() !== ''` 作为通用完成规则。
3. 重试分四层：Provider（RetryPolicy）/ Tool（ToolRecoveryController）/ Task（ExecutionRetryController）/ 通用 HTTP（fetch-retry，非 chat 专用）。
4. 事件唯一事实源：`events` 表（EventStore）。`activity_events` 为过渡期兼容投影。
5. 取消：单一 AbortSignal 链（Run → Task → 节点 → Model/Tool/网络），任一阶段可中断。

---

## 2. 运行时分层

| 层 | 模块 | 职责 |
|---|---|---|
| Event Runtime | `core/events/`（EventStore/EventBus/Replay/Projector/Sequence/ChunkPacker/SSE） | 事件持久化、seq 单调、回放、投影 |
| Run Runtime | `core/runtime/`（RunStateMachine/RunLifecycleManager/ExecutionLoop/ExecutionRetry/Checkpoint/Cancellation） | Run/Task 状态机、执行循环、重试、检查点、取消 |
| Agent Runtime | `core/agents/`（AgentRuntime/AgentRegistry/Handoff/Supervisor） | Agent 编排、交接、黑板 |
| Model Runtime | `core/models/`（ModelRuntime/ProviderAdapter/ModelRegistry/CircuitBreaker/RetryPolicy/Usage） | Provider 适配、流式、熔断、用量 |
| Tool Runtime | `core/tools/`（ToolRegistry/ToolExecutor/ToolResult/ToolTimeout/ToolPolicy） | 工具执行、结果契约、超时 |
| Memory Runtime | `core/memory/` | 4 层记忆、检索 |
| Verification | `core/verification/`（VerificationEngine/SelfCorrectionEngine） | 结果验证、自我修正 |
| Permissions | `core/permissions/`（Capability/PolicyEngine/ApprovalManager） | 能力、审批 |
| Errors | `core/errors/`（RuntimeError 层次） | 统一错误分类（code/retryable/category/metadata） |

---

## 3. 事件模型

- **44 个判别联合事件**（`src/shared/src/events/events.ts`），dot-notation 命名：`run.*` / `task.*` / `agent.*` / `tool.*` / `token.usage` / `attempt.*` / `retry.*`
- BaseEvent：`eventId / sessionId / runId / taskId? / agentId? / timestamp / seq / type / version / metadata?`
- seq：run-scoped 单调递增（DbSequenceAllocator + `__seq_claim` 仲裁 + UNIQUE(run_id, seq)），读取路径过滤幽灵行
- 投影：`event-projector.ts` 从 events 投影到 UI 状态（过渡期：activity_events 兼容层）

---

## 4. Run 状态机（11 态）

```
created ──► running ──► waiting ──► retry_waiting ──► retrying ──► verifying
  │           │            │             │              │            │
  │           ▼            ▼             ▼              ▼            ▼
  └──────► completed / failed / cancelled / interrupted / budget_exceeded（终态 5）
```

- 权威定义：`src/shared/src/types/index.ts` `RUN_STATUSES`（后端/前端/mobile 共用）
- 转换：`RunLifecycleManager` ACTION_FROM/ACTION_TO 双表 + CAS（id + from-status 条件更新）
- 取消合法源状态：running/waiting/retry_waiting/retrying/verifying（路由与状态机一致）
- 恢复：`recoverStale()` 30 分钟 lease + 心跳

---

## 5. 工具执行契约

```ts
type ToolExecutionResult = {
  toolCallId: string
  toolName: string
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'pending_approval'
  output?: unknown
  error?: StructuredError   // code/retryable/category/message/metadata
  startedAt: string
  completedAt?: string
  durationMs?: number
  attempt: number
}
```

- 幂等：RetryCheckpoint（toolId+args 键）+ sideEffectClass（read_only/idempotent/non_idempotent/unknown）
- MCP 工具走同一 ToolRegistry → ToolExecutor → ToolResult → ToolEvent 生命周期

---

## 6. Workflow 执行

```
workflow_runs（run 级）
  └── workflow_node_runs（节点级：id/run_id/node_id/status/attempt/started_at/completed_at/error/output/retry_count）
```

- DAG：多根并行、maxParallelTasks 并发上限、依赖 join 逐波推进
- 条件边：`edge.condition: 'passed' | 'failed'` 显式求值
- 取消：AbortSignal 从 HTTP 请求 → engine → 每个节点
- 节点重试：ExecutionRetryController + RetryCheckpoint（不重跑无关成功节点）
- 错误：结构化 NodeExecutionResult（status/output/error/code/retryable），禁止字符串推断成败

---

## 7. 客户端投影

| 客户端 | 消费方式 |
|---|---|
| Desktop（React） | SSE + afterSeq 增量回放；ActivityStore `*ByRun` 投影；runId 作用域 timeline |
| Electron | 后端进程健康检查 + 恢复扫描 + 崩溃重启（starting/healthy/failed/stopped/restarting 状态） |
| Mobile | Supabase 中继 + remote_command 终态结算（assistant 消息 ≠ 完成）；离线队列 pending/sending/retrying/failed/dead_letter |
| Workflow UI | workflow_node_runs 节点级进度（A ✓ B ✓ C ↻ 2/3 D running） |

---

## 8. 关键收敛目标（进行中）

| 项 | 状态 |
|---|---|
| 单一完成判定（CompletionEvaluator） | 收集中（AEX-P0-001） |
| CanonicalRunStatus 共享 | 收集中（AEX-P0-002） |
| 事件唯一事实源（events 表） | 收集中（AEX-P0-010/011） |
| Provider 级熔断器 | 收集中（AEX-P0-007/008） |
| 四层重试边界 | 已明确（AEX-P0-014） |
| Activity Run 作用域 | 收集中（AEX-P0-012） |
| Workflow 节点持久化/重试 | 收集中（AEX-P0-015/018） |
| 前端共享 ConversationRuntime | 收集中（AEX-P1-006） |
| 通知单一来源（NotificationCenter） | 收集中（AEX-P2-011） |
| 双上下文（run-context/runtime-context）合并 | 待办（AEX-P2-CO-07） |

---

## 9. 部署形态

| 形态 | 说明 |
|---|---|
| Localhost Web | 浏览器访问 127.0.0.1:3000，数据在 ./data/ |
| Windows EXE | Electron + backend-bundle.js，数据在 %USERPROFILE%\Documents\AICommandCenter\ |
| Android APK | Capacitor + Supabase（可选同步中继），远程控制/监控 |

构建与打包细节见 `build/README.md`。
