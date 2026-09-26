# Aether TEST_MATRIX — 测试所有权矩阵

> 日期：2026-09-26 ｜ 版本：2.3.0
> 映射：feature → unit / integration / E2E / visual QA。每个特性必须至少有一层自动化覆盖。

---

## 1. 测试基线（2026-09-26 实测）

| 层 | 框架 | 数量 | 运行方式 |
|---|---|---|---|
| backend | node --test | 1257 pass / 0 fail / 1 skip | `npm run build -w src/backend && npm run test -w src/backend` |
| frontend | vitest | 87 pass | `npm run test -w src/frontend` |
| mobile | node --test | 39 pass | `npm run test -w src/mobile` |
| shared | node --test | 33 pass | `npm run test -w src/shared` |
| E2E | playwright | **0（缺口：tests/e2e 目录不存在）** | 见 §5 |

---

## 2. 特性 → 测试映射

### Runtime 核心

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| Run 状态机（11 态转换） | ✅ run.test.ts | ✅ run-lifecycle-manager.test.ts | `core/runtime/` |
| Run 生命周期（createAndStart/transition） | ✅ | ✅ | `run-lifecycle-manager.test.ts` |
| Task 生命周期 | ✅ task.test.ts | — | `core/runtime/` |
| Attempt/Retry 生命周期 | ✅ execution-retry.test.ts | — | `core/runtime/` |
| CompletionEvaluator | ✅ execution-completion.test.ts | — | `core/runtime/` |
| Checkpoint | ✅ execution-checkpoint.test.ts / checkpoint.test.ts | — | `core/runtime/` |
| Cancellation | ✅ cancellation.test.ts | ✅ cancel-integration.test.ts | `core/runtime/`, `modules/runs/` |
| 完成语义回归（content!==''） | ⬜ 需补 | — | AEX-P0-001 |

### Retry

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| Provider retry（429/500/503/504/timeout/reset） | ✅ retry-policy.test.ts | ✅ provider-adapter.test.ts | `core/models/` |
| 流截断（STREAM_CLOSED） | ⬜ 需补（mock-provider.sse.ts truncated 场景可用） | ⬜ | AEX-P0-009 |
| Tool retry（临时失败/超时/transport） | ✅ execution-retry.test.ts | — | `core/runtime/` |
| Task retry（verification failed/provider exhausted） | ✅ execution-retry.test.ts | ✅ execution-loop.test.ts | `core/runtime/` |
| Retry 取消（retry_waiting → cancel） | ⬜ 需补 | ⬜ | AEX-P0-004/114 |
| 未知错误默认不可重试 | ⬜ 需补 | — | AEX-P0-005 |

### Event Store / Replay

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| EventStore SQLite | ✅ event-store.sqlite.test.ts | — | `core/events/` |
| seq 单调（10 并发） | ✅ event-sequence.test.ts | — | `core/events/` |
| 幽灵 claim 过滤 | ✅ ghost-claim.test.ts | — | `core/events/` |
| Packed replay（afterSeq 过滤） | ✅ packed-replay.test.ts | ✅ integration.test.ts | `core/events/` |
| Event replay 100 事件 from seq=50 | ✅ event-replay.test.ts | — | `core/events/` |
| SSE transport | ✅ sse-transport.test.ts | — | `core/events/` |
| legacy 映射（unknown → reject） | ✅ legacy-adapter.test.ts | — | `core/events/`, `shared/` |

### Streaming

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| parseSSEStream | ✅ streamClient.test.ts | — | `frontend/api/` |
| SSE heartbeat 无泄漏 | ⬜ 需补 | — | AEX-P1-019 |
| 流终态权威（terminal event only） | ⬜ 需补 | — | AEX-P1-042 |

### Tool / MCP

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| ToolExecutor | ✅ tool-executor.test.ts | — | `core/tools/` |
| ToolResult 契约 | ✅ tool-result.test.ts | — | `core/tools/` |
| Tool timeout | ✅ tool-timeout.test.ts | — | `core/tools/` |
| Tool idempotency（同 key 不重复执行） | ✅ execution-retry.test.ts | — | AEX-P0-006 |
| MCP 连接生命周期 | ⬜ 需补 | ⬜ | AEX-P1-035 |
| MCP 断线不挂起 running | ⬜ 需补 | — | AEX-P1-035 |

### Workflow

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| DAG 执行 | ✅ execution-engine.test.ts | ✅ execution-engine.db.test.ts | `modules/workflows/` |
| 节点失败结构化 | ✅ execution-engine.test.ts:245-251 | — | AEX-P0-017 |
| 节点重试 | ⬜ 需补 | — | AEX-P0-018 |
| 节点状态持久化（node_runs） | ⬜ 需补 | — | AEX-P0-015 |
| 取消传播 | ✅ execution-engine.test.ts:254-283 | ✅ db.test.ts:144-175 | AEX-P0-016 |
| 并行节点失败 | ⬜ 需补 | — | AEX-P1-083 |

### Conversation / Frontend

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| ActivityStore 双粒度 | ✅ activityStore.test.ts（29） | — | `frontend/store/` |
| Run 作用域投影 | ⬜ 需补 | — | AEX-P0-012 |
| CodingHome 不 clearConv | ✅ CodingHome.test.tsx:138-166 | — | AEX-P0-013 |
| CodingHome 超时非 assistant 消息 | ⬜ 需补 | — | AEX-P0-013 收尾 |
| Chat UI（load/send/streaming/stop/retry） | ⬜ 缺口 | — | AEX-P1-024 |
| 消息合并 mergeMessages | ⬜ 需补 | — | AEX-P1-040 |
| Notification dedupe | ✅ notification-center.test.ts（11） | — | AEX-P1-121 |

### Mobile / Sync

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| 完成判定（assistant≠completed） | ✅ message-completion.test.ts（6） | — | AEX-P0-014 ✅ |
| 消息 store | ✅ message-store.test.ts（8） | — | `mobile/lib/` |
| 离线队列 | ✅ offline-queue.test.ts（8） | — | `mobile/lib/` |
| 远程命令 | ✅ remote-command.test.ts（8） | — | `mobile/lib/` |
| Reconnect 重建 Run | ⬜ 缺口 | — | AEX-P1-119 |
| 组件测试（App/MessageView） | ⬜ 缺口（0 个 tsx 测试） | — | AEX-P1-027 |

### 数据导入/导出

| 特性 | Unit | Integration | 文件 |
|---|---|---|---|
| 导入原子性（rollback） | ⬜ 需补 | — | AEX-P1-123 |
| 导出完整性 | ⬜ 需补 | — | AEX-P1-070 |

---

## 3. 必需失败场景（规范 §83）覆盖状态

| 场景 | 状态 |
|---|---|
| provider 429/500/503 | ✅ retry-policy.test.ts |
| provider timeout / connection reset | ⬜ 需补 |
| stream truncation | ⬜ 需补（mock 可用） |
| empty response / malformed stream | ✅ provider-adapter.test.ts 部分 |
| tool timeout / tool error | ✅ tool-timeout.test.ts / tool-executor.test.ts |
| tool result lost / duplicate tool event | ⬜ 需补 |
| cancel during model / tool / retry delay / verifying | ⬜ 需补（cancel-integration 部分） |
| budget exceeded / max turns | ⬜ 需补 |
| process crash / restart during running/retry/verifying | ⬜ 需补 |
| SSE reconnect / mobile reconnect | ⬜ 需补 |
| workflow node failure / retry / cancellation | ✅ 部分 / ⬜ retry |
| parallel workflow failure | ⬜ 需补 |

---

## 4. 补测优先级（按 P0 → P1）

1. AEX-P0-001 完成语义回归（Text only → not completed；verification failed → continue；all complete → completed）
2. AEX-P0-005 未知错误默认不可重试
3. AEX-P0-009 流截断 → STREAM_CLOSED → retry if policy permits
4. AEX-P0-015/018 node_runs 持久化 + 节点重试
5. AEX-P0-013 CodingHome 超时非 assistant 消息
6. AEX-P1-019 SSE heartbeat 无泄漏
7. AEX-P1-119 mobile reconnect 重建 Run
8. AEX-P1-121 notification dedupe（SSE/polling/replay/reconnect 四路径单通知）
9. AEX-P1-123 导入 rollback

---

## 5. E2E / Visual QA 现状与计划

| 项 | 状态 | 计划 |
|---|---|---|
| playwright.config.ts | ✅ 存在（testDir ./tests/e2e, desktop+mobile projects） | — |
| tests/e2e/ 目录 | ❌ **不存在（0 E2E）** | 创建核心链路：新建对话→流式→停止→重试 |
| 视口矩阵（1440/1280/1024/768/600/390） | ❌ 无执行证据 | visual-qa skill 覆盖 |
| snapshot 测试 | ❌ 0 个 | 待定（按需） |
| 前端组件测试 | ⬜ 缺口（Chat UI 0 覆盖） | CodingHome.test 模式推广 |

---

## 6. 验收标准

每个 P0/P1 修复必须满足：
- **RED→GREEN**：先写失败测试（断言消息明确），再实现转绿
- **回归**：修复所在模块全部现有测试保持绿
- **Surface**：CLI/curl/浏览器手工验证关键路径（预算耗尽、取消、重试、流截断）
