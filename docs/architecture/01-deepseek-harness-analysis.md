# DeepSeek Harness 架构分析报告

> 面向 Aether「Event-driven Agent Activity Stream」重构的设计参考
> 分析对象：`github.com/deepseek-ai/deepseek-harness` @ master `b150a551`（2026-08 快照，MIT，188k+ stars）
> 所有路径均相对仓库根目录。报告日期：2026-08-24

---

## 1. 仓库判定与选择理由

**结论**：记忆中的 `DeepSeek-Harness`（大写驼峰、"DeepResearch 场景专用"）不存在于官方 org。官方仓库实为 **`deepseek-ai/deepseek-harness`**（全小写），定位是**通用 Agent Harness 产品**（CLI + Web GUI + headless + ACP/JSON-RPC SDK），口号 “Everything is a Plugin”。

**判定依据**：
| 候选 | 判定 | 理由 |
|---|---|---|
| `deepseek-ai/deepseek-harness` | ✅ **选定** | DeepSeek 官方 org 下唯一 harness 形态仓库；TypeScript；2026-08-13 创建、持续活跃更新；基于 vendored Cordis（Koishi 系 IoC 容器）微内核 |
| `deepseek-ai/DeepSeek-R1` 等模型仓库 | ❌ | 模型权重 / 推理 infra，与 Agent 编排无关 |
| 第三方 fork | ❌ | 用户明确要求以官方为准 |

【证据】`README.md`: *"DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI. It uses an architecture where everything is a plugin, and is powered by Cordis"*；`AGENTS.md` 声明 `packages/core/` 是 *"product API spine: session, system-prompt, tools, agent, agent-loop"*。

**工程纪律**（为什么值得严格参考）：每文件 100% 测试覆盖门禁、双语文档门禁、文档代码块编译检查、每个非平凡 PR 必须附 Agent Note 决策记录。`.agents/notes/implemented/architecture/` 下有 50+ 篇带日期的架构决策记录，本质是一本公开的 "如何设计 Agent Harness" 教科书。

---

## 2. Agent Loop 完整链路

### 2.1 核心概念层级

```
Session（append-only 事件日志，唯一事实源）
  └─ Turn（回合：从 claim 输入到"无所欠"为止，0..N 个 Step）
       └─ Step（步：一次 model request + 它触发的全部 tool calls）
            ├─ assistant/chunk*（流式增量，逐条入日志）
            ├─ assistant/message（组装后的完整消息）
            └─ tool/call → tool/result（模型序提交）
```

【证据】`docs/architecture.md`：*"A step is one model request plus the tools it calls. A turn is zero or more steps"*。

### 2.2 ReactLoopAgent 驱动器

【证据】`packages/core/agent-loop/src/agent.ts` — `class ReactLoopAgent implements Agent`。

**Phase 状态机**：`idle | maintenance | running`（abort 控制器 + lastTurn + wakeRequested）。

**完整调用链**：

1. **入口注入** `send(message, target, wakeup)`：三种语义化入口 —— `followup()`（下一 turn 唤醒）、`steer()`（下一 step 唤醒，中途转向）、`inject()`（下一 step 不唤醒，合成上下文）。这是 Activity Stream 中"用户插话/系统注入"的原生建模。
2. **唤醒驱动** `wakeDriver()`：idle 时启动 driver；aborted 时把 wake 闩锁（latch）待收敛后重放。
3. **Driver 循环** `kick()`：`while (await this.turn()) {}`。
4. **Turn** `turn()`：先 `append('turn/start', {turn})` 再 claim 输入（先开边界后取料）；循环内 `preStep()` → `step()`；结束路径：reject→`blocked`、空输入→`completed`、正常完成；finally 中无条件 `append('turn/end', {turn, reason})`。
5. **Pre-step 门** `preStep()`：`inbox.claim()` → `systemPrompt.assemble()` → **waterfall `agent/pre-step`**（插件可改写 messages 或 reject）。
6. **Step** `step()`：

```
buildRequest()                    // waterfall 'agent/request' → llm.prepareCall()
  → append('request/header')      // 仅 initial/resume/change 记快照（去重）
  → ctx.llm.stream(request)
  → for await chunk: append('assistant/chunk') + assembler.push(chunk)
  → append('assistant/message', {...}, { surfaceOp:'append', sourceEventSeqs: chunkSeqs })
  → 无 tool-call → return {kind:'completed'}
  → executeToolCalls(...)
  → concluded ? completed : null  // null ⇒ 循环继续，用 deriveMessages() 再发一轮
```

7. **终止**：`turn/end.reason` 是 merge-extensible sum（completed/aborted/blocked/error/max-tokens/interrupted）。

### 2.3 Dispatch 模式：`(subject, event)` 融合派发

【证据】`packages/core/agent/src/dispatch.ts` — `AgentEventDispatch` 提供：`emit`（fire-and-forget，逐 listener 容错，不 veto 生命周期）、`serial`（顺序 await）、`waterfall`（around-middleware，必须 `next()`）。payload 的 `agent` 字段由 dispatcher 注入 —— **subject 与 scope key 结构上不可能分叉**。

---

## 3. Event System 全景

### 3.1 Durable 层：SessionEventMap（事件溯源日志）

【证据】`packages/core/session/src/types.ts` — `interface SessionEventMap`（**merge-extensible**，插件可 declaration merging 追加）：

| 事件族 | 事件 | 关键字段 |
|---|---|---|
| 回合边界 | `turn/start` / `turn/end` | `{turn}` / `{turn, reason: TurnEndReason}` |
| 步边界 | `step/start` / `step/end` | `{turn, step}` |
| 用户面 | `user/message` | `UserMessage`，`source: human/inject/goal` |
| 模型流 | `assistant/chunk` | `{turn, step, chunk: StreamChunk}` — **原始 chunk 入日志，token 级重放保真** |
| 模型消息 | `assistant/message` | `{message, usage?, interrupted?:true}` |
| 工具 | `tool/call` | `{callId, name, arguments(未解析原串)}` |
| 工具 | `tool/result` | `{message, error?, meta?}` |
| 聚合状态 | `todo/write` | 整表快照 last-write-wins（"Log-only UI state; never derived history"） |
| 元数据 | `request/header` / `request/context` | EpochHeader 快照 / 路由元数据 |
| 会话生命周期 | `session/end-seed` | 标记 seed 历史/活工作分界 |

**信封结构**：`{ type, seq(单调连续), time, data, ignorable? }`；surface 事件额外带 `surfaceOp` + `sourceEventSeqs`。

两个关键设计：
- **`ignorable?: true`**：读者遇到不认识的事件类型，无此标记**必须拒绝重建会话**而非静默丢弃 —— "被遗忘的标记宁可造成过度拒绝，也不静默吞掉重塑解释的事件"。
- **SurfaceOp `'append' | {op:'replace', start, end}`**：compaction 用 replace 把被压缩节点换成合成节点，`sourceEventSeqs` 记录被遮蔽的全部来源 seq。

**TurnEndReason**：`completed | aborted(user/parent/hook/disposed) | blocked | error | max-tokens | interrupted`（interrupted 是持久化后端 reload 时给 crash 孤儿 turn 补的闭合标记，loop 自身永不发出）。

### 3.2 Live 层：Cordis Events 三域分类

【证据】`docs/architecture.md` + `2026-06-11-microkernel-event-taxonomy.md` 笔记：

- **Session events**：durable facts，append 后经 `session/event` 同步广播。
- **Agent events**（`agent/*`）：live 观察/拦截点 — `agent/status`、`agent/inbox/inserted|claimed|discarded`、`agent/pre-step`(W)、`agent/request`(W)、`agent/request-error`(W)、`agent/turn-stopping`(S)、`agent/error`。
- **Capability events**：`tools/*`、`fs/*`、`telemetry/*`、`llm/stream`、`system-prompt/assemble`、`subagent/*`。

**四种 dispatch mode**：`waterfall`（around-middleware）/ `serial`（有序检查点）/ `parallel`（fan-out，如 `session/flush`）/ `emit`（同步通知）。事件词汇住在 contract 包（`dsh-agent`），loop 插件自身可替换——**nothing outside it may depend on it**。

### 3.3 生产者/消费者矩阵

| 产生点 | 事件 | 消费者 |
|---|---|---|
| ReactLoopAgent.turn/step | turn/* step/* user/message assistant/* request/* | 持久化插件、projection、UI bridge |
| tool-calls.ts 调度器 | tool/call tool/result | 同上 + `presentResult` 卡片渲染 |
| Session.append | `session/event` 广播 | SessionProjectionRegistry、persistence write-behind、SDK server |
| SubagentRuntime | subagent/start subagent/end | UI lineage、SDK 通知 |
| ToolRuntime | tools/result(frozen emit) tools/change | 观察者、prompt assembly |

---

## 4. Streaming 机制

### 4.1 StreamChunk 词汇

【证据】`packages/llm/llm/src/types.ts`：

```typescript
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; ... }
```

要点：**以 block index 为单位的分块流**；tool call 以 `tool-call-delta` 实时流出（`id` 早于 name/args 完整，`argumentsDelta` 是参数串增量）——前端可以在 args 未完时就用 `id+name` 渲染 pending 卡片。

### 4.2 Loop 侧消费

- `BlockAssembler` 逐 chunk push，组装 delta 流成 content blocks；
- **每个 chunk 都 `session.append('assistant/chunk', ...)` 并收集 seq 进 `chunkSeqs`**；
- 正常结束时 `assistant/message` 以 `{surfaceOp:'append', sourceEventSeqs: chunkSeqs}` 引用其全部来源 chunk；
- **abort 特殊路径**：signal 中止时若已有部分内容，把已交付前缀 finalize 成 `interrupted:true` 的 `assistant/message` —— "取消不留黑洞，已说的话留在日志里"。

### 4.3 Web 前端消费

`client/runtime/src/client/sessions/partial.ts`（110 行 streaming 部分累积）+ `conversation-assembler.ts`。chunk 类事件进入 partial 累积通道，`assistant/message` 到达时以完整节点替换 partial。红线：**"Nothing that is 'how to draw' enters the session log"** —— 绘制意图不入日志，replay 时重算、算不出就退化 generic 形式。

---

## 5. Tool Lifecycle

### 5.1 管线：三个 waterfall + 一个 emit

【证据】`packages/core/tools/src/index.ts`：

```
tools/pre-execute  (waterfall)  allow | deny | ask          ← 权限/审批门
tools/execute      (waterfall)  around-dispatch: timeout/retry/metrics 包裹层
tools/post-execute (waterfall)  accept | replace | enrich | block  结果；抛错的 tool 也走到这里
tools/result       (emit)       deep-frozen 最终结果快照
tools/change       (emit)       注册表变化（unfiltered，全局可见）
```

### 5.2 并发模型

- `ToolExecutionMode: exclusive | parallel`：通过可选的 `isConcurrencySafe?(args)` **显式 opt-in** 并行（"Only true opts in"）；
- `executeToolCalls`：按模型序扫描，exclusive 调用形成 barrier；parallel 组进 rolling pool（上限 `maxParallelToolCalls`）；
- **提交永远按模型序**（`commitReady` 只推进 contiguous slots）；后续调用的 mode 在启动前**重新分类**。

### 5.3 生命周期事件与持久化配对

- 启动即 `append('tool/call', ...)` 并保留事件 seq（`callSeqs`）；
- 结果 `append('tool/result', ..., {surfaceOp:'append', sourceEventSeqs:[callSeq]})` —— **result 通过 sourceEventSeqs 显式引用它的 call**，UI 据此把卡片从 pending 折叠为完成态；
- 取消时 `appendSkippedToolCall` 写入**合成错误结果**（`TOOL_ABORTED_BEFORE_DISPATCH`），保证 replay 永远合法；
- `cancellationResult` 按 `bodyInvoked` 区分 aborted vs aborted-before-dispatch。

### 5.4 UI render intent 是工具契约的一部分

`presentCall?(args): ToolCallView`（pending 态卡片）与 `presentResult?(args, result): ToolResultView`（完成态卡片）是 `ToolDefinition` 可选成员，**纯函数、只依赖 args/result** —— 因为 "UI 可能在 live streaming 与 log replay 两种时机调用它"。`tool/result.meta` 是工具私有的 JSON 展示载荷，随日志持久化，**replay 时重现同一张卡**。

### 5.5 错误处理与重试

- **工具错误**：规范化为 `ToolExecutionResult { isError, error:{message,...} }` 进入 `tool/result`，模型可读可自纠；unknown-tool denial 文案带可用路由提示。
- **LLM 请求重试**：【证据】`packages/llm/llm-retry/src/index.ts` — 监听 `agent/request-error` waterfall。策略：**指数退避 + 抖动**；**"Each scheduled retry is durable before its cancellable wait"** —— 每次重试决策先落日志再等待，崩溃恢复后重试历史完整。`retryPolicy` 归 provider 配置所有。
- **超时**：`ToolDefinition.timeoutMs` 由独立插件作为 `tools/execute` wrapper 强制执行，**错误永不发给模型**。

---

## 6. 持久化与恢复（State Projection）

### 6.1 Event-sourced Sessions（奠基决策）

【证据】`2026-06-11-event-sourced-sessions.md` 笔记：

> *"A Session is an append-only log of typed SessionEvents — the single source of truth. The LLM message history is derived from the log (deriveMessages()). Appends are synchronous; persistence plugins buffer write-behind and drain at session/flush checkpoint fired at every turn end."*

否决方案：*"A mutable message array with events fired as notifications — with event-sourcing the log IS the state, so divergence is structurally impossible."*

配套不变量：**"Model-visible ⟺ logged"** —— 任何到达模型的内容必须能从日志重建，运行时 invariant 断言之。`append()` 同步、lossless-JSON 校验、deep-freeze、seq=下标、防重入、contained 广播；`deriveMessages()` 缓存增量投影（O(new nodes)）；compaction replace 触发代际重建。

### 6.2 Projection 框架：框架驱动、领域只写纯函数

【证据】`packages/session/session-projection/src/index.ts`：

```typescript
export interface ProjectionDefinition<K, S> {
  key: K
  stateSchema: ZodType<S>
  init(): S
  apply(state: S, event: SessionEvent): S   // 纯同步 fold；不关心的事件返回同一引用
  wire?: { viewSchema: ZodType; view(state): Wire }
  stateVersion: number
}
```

`SessionProjectionRegistry` 构造时**只订阅一次** `session/event`，每个 committed 事件 eager 驱动所有 unit；变化检测用 `Object.is` 引用比较；checkpoint 行 `(sessionId, key, ver, seq, val)` 只是 fold 捷径绝非权威；`restoreFloor()` 取最低 watermark **减一**作锚点读尾部，检测"日志比缓存短"（crash 截断）；`restore()` 校验 `ver` + `seq ∈ [baseSeq-1, endSeq]`，不可用行弃用重 fold。

**三条 load-bearing 规则**：
1. **Whole-value event rule**：状态类事件 MUST 携带完整后置状态，绝不只是 delta；
2. **Watermark cache**：per-session per-unit `(state, observedSeq)`，缺 cell 惰性全量 fold；
3. **Checkpoint/restore 阶梯**：缓存永远是从日志重放的可放弃捷径。

### 6.3 断线恢复

存储后端：`session-persistence-jsonl` / `session-persistence-sqlite`（SQLite 用单调 `SCHEMA_VERSION`，会话格式用 `SESSION_FORMAT_VERSION=0`）。客户端 `SessionManager` 维护 event window：重连/resync 走 `replaceWindow()`（全量重建 + hasMore 标记），live tail 走 `append()`（按 seq 去重、O(1)）。

---

## 7. Multi-Agent / Subagent

### 7.1 Capability Seam 三角色

`SubagentRuntime` 服务 + `SubagentProvider` 接口 + Consumers（`tool-subagent`、`tool-subagent-control`、`tool-subagent-report` 三个模型可见工具）。内置 providers：`subagent-in-process-driver`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`subagent-acp`、`subagent-claude-code`、`subagent-codex`、`subagent-dsh-sdk` —— 同一接口后面既可以是进程内子 agent，也可以是委派给外部产品的一次 turn。

### 7.2 Parent/Child 全部持久化在 child 的 SessionHeader

```typescript
readonly parentSession?: SessionId      // seed 血缘
readonly seedLength?: number            // 从父继承的前缀事件数——区分父历史与子工作
readonly origin?: 'subagent'            // 粗粒度产品分类
readonly delegationDepth?: number       // 父深度+1；持久化使递归预算跨重启存活
```

fork 语义：child 用父日志做 seed replay，`session/end-seed` 事件标记继承前缀终点。

### 7.3 生命周期事件

`subagent/provider-added|removed`、`subagent/start`(Scoped emit)、`subagent/end`。SDK wire 通知：`subagent.started {parentSessionId, childSessionId}`、`subagent.finished {parentSessionId, provider, agentId, ...}` —— 前端据此画 lineage 树。另支持 Experiment 级 `ctx.agentTeams`（durable roster + task board + mailbox）。

---

## 8. 前端 Event→UI

### 8.1 三层红线（对 Aether 最直接的模板）

【证据】`packages/client/AGENTS.md` "Layering red lines"：

1. **数据对象层**（`client/runtime`，React-free，grep 可断言零 React import）：`ConnectionController → SessionManager → Session` 持有全部业务状态；zustand/immer 引擎也在这层。
2. **渲染机器层**（`ui-renderer`，动态插件）：唯一 ctx-to-React 集成点 —— slot renderer、`SessionProvider`、useSyncExternalStore adapter。
3. **展示组件层**（各 `ui-*` 包，纯 props，"expected to be rewritten wholesale"）：业务逻辑不得泄漏。

组合只有一条路：`ctx.slots.register({name, children?, store?, inject?}, Component)`，slot 名镜像组合路径 `<domain>.<entry>.<hole>`。

### 8.2 Conversation Assembler：事件→节点的增量引擎

`ConversationNodeAssembler`：特性注册 `ConversationNodeDefinition`（`match(event)` 只读当前事件；`update` fold 一个 Match into State；按 seq 确定性可重放）。双通道：`replaceWindow(entries, hasMore)`（打开/重连/gap repair 全量重建）与 `append(input)`（tail 增量，重复 seq 直接忽略）。发布节奏三级：`none < animation-frame < immediate`。

### 8.3 传输：WebSocket 下行 + HTTP 上行

> *"Host-side WebSocket carrier for the two server-to-browser event streams... Client messages are a protocol violation: upstream traffic remains on HTTP."*

两条 downlink（`mux` 多路复用流 + `host` 流），帧为 `RpcRequest<MuxFrame|HostFrame>` JSON；收到任何 client 消息立即 `close(1008, 'downlink only')`。上行（发 prompt、审批、steer）走普通 HTTP RPC。另一条自动化通道是 stdio newline-delimited JSON-RPC（`session.event` 通知携带完整 SessionEvent 信封逐条推送）。

### 8.4 Notifier 发布纪律

> *"notifyNow is only the direct echo of a user gesture; structural updates use microtask-batched markDirty; visible streaming chunks use cumulative markFrameDirty."*

三档发布策略防止高频 token 流打爆 React 渲染。

### 8.5 TUI 参考

TUI 与 Web 共享同一 session/event 面；`2026-07-23-unified-session-query-service.md`（统一会话查询服务，TUI/Web 共用一个 query face）；工具卡片同样由 `presentCall/presentResult` 纯函数驱动；step/timing trail 是 TUI 一等公民。

---

## 9. 对 Aether 重构最具借鉴价值的 5 个设计决策

1. **日志即状态，历史是投影**：append-only 事件日志是唯一事实源，`deriveMessages()`/UI 全部增量投影（O(new events) 缓存 fold），运行时不变量 "Model-visible ⟺ logged"。Aether 迁移到 Activity Stream 时，Fastify 只写日志、React 只 fold 日志。
2. **双轨事件：durable 事实 + live 拦截点分离**：`turn/* step/* tool/*` 持久事实走 `session/event` 广播；`agent/pre-step、agent/request-error、tools/pre-execute|execute|post-execute` 等 waterfall 是可编程扩展点（必须 `next()`）——Aether 的权限审批、prompt 改写、重试策略都应挂 waterfall。
3. **chunk 全量入日志 + `sourceEventSeqs` 血缘引用**：每个 StreamChunk（含 tool-call-delta 的 argumentsDelta）逐条 append，最终 `assistant/message`/`tool/result` 用 `sourceEventSeqs` 反向引用来源 seq —— 同时解决 token 级重放保真、断线续传去重、UI 卡片 pending→final 折叠。
4. **框架驱动的 State Projection + whole-value event rule**：领域只注册 `{key, init, apply(纯同步fold), view, stateVersion}`，框架统一订阅、维护 watermark cache、checkpoint/restore；状态类事件携带完整后置值。
5. **下行 WebSocket 单向流 + 上行 HTTP，前端三层红线**：server→browser 只有 downlink-only WS，上行走 HTTP RPC；数据对象层持有全部状态，发布纪律三档 —— 让高频 token 流下 UI 依然可控，展示层可整体重写而不动数据层。

**一句话总结**：Event-driven Agent Activity Stream 的正解不是"设计一套推送协议"，而是**把 append-only 事件日志当作唯一事实源，让 loop、tool、subagent、持久化、前端全部成为这个日志的生产者或纯函数投影者** —— 传输、审批、重试、多 agent 统统是这个不变量之上的可替换插件。