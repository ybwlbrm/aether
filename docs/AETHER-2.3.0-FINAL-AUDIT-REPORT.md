# Aether 2.3.0 最终架构收口 — 审计报告（第一阶段）

> 日期：2026-09-22 ｜ 基线：master commit `6addef02` ｜ 版本：2.3.0
> 审计范围：backend core + modules + frontend + mobile + build + CI + docs
> 方法：3 个并行 explore 代理深度取证 + 人工核验全部文件:行号证据

---

## 一、执行链总览（真实调用链）

```
User → Conversation(chat-handler / orchestration / command-processor)
        ↓
      Run (RunLifecycleManager createAndStart → transition)
        ↓
      Task (taskId=runId)
        ↓
      Execution Loop (chat-handler→conversations/tool-loop ｜ orchestration→agents/tool-loop ｜ command-processor 自实现)
        ↓
      Model Runtime (provider-adapter → retry-policy / fetch-retry / circuit-breaker)
        ↓
      Tool Runtime (ProductionToolExecutor)
        ↓
      Event Runtime (EventBus / EventStore / sequence-allocator)
        ↓
      SSE → Frontend Chat / CodingHome / Mobile
```

**核心结论：存在 3 套执行 Loop、2 套 Model Retry、3 套 Sisyphus Prompt、2 套 ToolLoop、2 套前端 Chat 实现。**

---

## 二、P0 问题清单

### P0-01/02/03 — Loop 开关假功能（证据确凿）

| 文件:行号 | 代码 | 问题 |
|---|---|---|
| `chat-handler.ts:388-390` | `const LOOP_MAX_TURNS_DEFAULT = 30; let maxTurns = body.loop ? 30 : 30;` | loop=true/false 预算相同 |
| `agents/tool-loop.ts:64-67` | `let fcTurns = ctx.body.loop ? 30 : 30;` | 同上 |
| `command-processor.ts:438` | `let maxTurns = remoteLoop ? 30 : 30;` | 同上（恒为 30） |
| 全部 | 无 Completion State | 仅靠"模型有无输出文字"判断完成，无 RUNNING/WAITING_TOOL/VERIFYING/CONTINUING/COMPLETED 状态机 |

### P0-04 — 预算来源不统一

| 位置 | 值 | 归属 |
|---|---|---|
| `agent-definition.ts:92-98` DEFAULT_AGENT_LIMITS | 50 turns / 200 tools / 30min / 128k | Core，**运行时未执行** |
| `chat-handler.ts:388` | 30 turns | 硬编码 |
| `conversations/tool-loop.ts:119` | MAX_TOOL_CALLS_PER_REQUEST=50 | 硬编码 |
| `agents/tool-loop.ts:56` | MAX_TOOL_CALLS_PER_REQUEST=50 | 硬编码（重复） |

### P0-05/06 — 时间/Token/费用预算未真正生效

`conversations/tool-loop.ts:69-77` `defaultLoopBudget` 中 `maxDurationMs:0, maxTokens:0, maxCostCny:0` → 实际仅 turns + tool_calls 生效；无 BUDGET_EXCEEDED finalization 总结协议。

### P0-07/08 — 两套 Model Retry + Mobile Retry 包错范围

| 文件:行号 | 语义 |
|---|---|
| `retry-policy.ts:83-98` | sleep abort→**resolve**（错误） |
| `fetch-retry.ts:36-44` | sleep abort→**reject AbortError**（正确） |
| `provider-adapter.ts:178/208` | `attempt += 1` 后再 `delayMs(attempt)` → **首次重试跳过 2^0 档** |
| `command-processor.ts:476-505` | `for attempt<4` 仅包 `runtime.stream()`，**不包 for-await 读取** |
| `command-processor.ts:213-315` | 同步 Supabase 的手写 retry（3 次） |

### P0-09 — Core AgentRuntime 未接管生产

`agent-runtime-bridge.ts` 仅注册 legacy AGENTS[] 到 Core Registry；生产编排仍用 `modules/agents/tool-loop.ts` + `orchestration.ts` 直接消费 AGENTS[]。

### P0-10 — Prompt 部分生效

| 路径 | 是否读 customPrompts |
|---|---|
| `/api/agents/sisyphus`（index.ts:235） | ✅ `customPrompts.get(id) ?? systemPrompt` |
| 超级模式分派（orchestration.ts:427） | ✅ |
| 超级模式汇总（orchestration.ts:551） | ❌ 硬编码 SISYPHUS_SYNTH_SYSTEM_PROMPT |
| **普通 Chat**（chat-handler.ts:269） | ❌ 硬编码 SISYPHUS_SYSTEM_PROMPT |
| Mobile Remote | ❌ 独立 Aether 远程助手 prompt |

customPrompts 为**进程内 Map**（orchestration.ts:45 + index.ts:18 两份），重启丢失。

---

## 三、P0 Agent/Run/Event 问题

### AgentRuntime 重复 terminal（agent-runtime.ts）
- L74 `onStop()` emit `agent.completed`
- L100 `runTask()` 成功也 emit `agent.completed` → **双重发射**；异常时 L100 emit `agent.failed` + L74 仍 emit `agent.completed` → 状态冲突。

### Run 级 seq（agent-runtime.ts:31）
- `#seq` 每实例独立 0..n，多 Agent 并行时 Run 内 seq 冲突。`sequence-allocator.db.ts` 已存在但 AgentRuntime 未接入。

### Run 创建失败后继续（chat-handler.ts:160-170）
- `runLifecycle.createAndStart` 在 try 内，失败仅 `console.error` → **继续 AI 执行**。

### Run token 膨胀（run-lifecycle-manager.ts:193-195）
- `totalTokens = oldTotal + (opts.totalTokens ?? input+output)` → 多次 transition 重复累加膨胀。

### EventStore logical/physical 不一致（event-store.sqlite.ts）
- `count()` 返回物理行数（packed 算 1）≠ logical event 数
- `get()` 无法取 packed sub-event
- `listAfter()` 正确（先按物理 seq 取行再按 logical 过滤）——基础已部分正确

---

## 四、P1 问题

| # | 问题 | 证据 |
|---|---|---|
| P1-01 | 双 ToolLoop | `conversations/tool-loop.ts`（445 行，多维预算）+ `agents/tool-loop.ts`（385 行，仅 turns+tools），MAX_TOOL_CALLS=50 重复定义 |
| P1-02 | 前端 Chat/CodingHome 重复 | Chat.tsx 696 行 + CodingHome.tsx 1263 行；共享 useStreamSend/useMessagePolling/useConversations hooks 但主逻辑分离 |
| P1-03 | Workflow 串行执行 | `execution-engine.ts:106` `while(queue)+await executeNode` 串行；条件边隐式约定（第一条=true/第二条=false，L133-146） |
| P1-04 | Token 混合统计 | `conversations/tool-loop.ts:256-262` `completion 累加 + prompt 取最后一轮` 混合 |
| P1-05 | Agent limits 未接入生产 | DEFAULT_AGENT_LIMITS(50/200/30min/128k) 仅 Core 定义 |
| P1-06 | orchestration legacy fetchWithRetry fallback | orchestration.ts:6 import + 模型调用仍走 legacy fetch 兜底 |
| P1-07 | Prompt UI 简陋 | AgentSettings.tsx:200 仅 promptDialog |

---

## 五、P2 工程化问题

| # | 问题 | 证据 |
|---|---|---|
| P2-01 | 版本漂移 | Root 2.3.0 / Mobile 1.0.0 / README 2.2.0+978+DB v13 / CHANGELOG 2.2.0 |
| P2-02 | README 过期 | README.md:5(2.2.0)、:64(978+)、:198(Setup 2.2.0)、:321(978)、:374(v1-v13) |
| P2-03 | lint 存量 warnings | backend/frontend/shared 1011 个既有 warning |
| P2-04 | CI 无 mobile 门槛 | 上一轮已加 mobile-gate，但 frontend rollup optional 依赖问题（§67）待修复 |
| P2-05 | release 硬编码路径 | release-all.js 依赖 D:\Aether-OpenSource + JDK 固定路径（§70/§71） |

---

## 六、已有良好基础（不推倒重来）

- ✅ `sequence-allocator.db.ts` Run 级序列分配器完整（claim row + UNIQUE(run_id,seq)）
- ✅ `event-store.sqlite.ts` listAfter 已按 logical seq 过滤
- ✅ `model-runtime.ts` ModelRuntime 已是 Chat 主入口（provider-adapter 内部 retry）
- ✅ `tool-runtime.ts` / `ProductionToolExecutor` 已统一工具执行
- ✅ `RunCancellationRegistry` 已存在
- ✅ Mobile 单测 25 pass / backend 1116 / frontend 62

---

*本报告为第一阶段审计交付物。修复执行顺序见任务书 §78-§84（P0 Chat Runtime → P0 Agent/Run/Event → P1 → P2），每阶段完成后立即验证。*
