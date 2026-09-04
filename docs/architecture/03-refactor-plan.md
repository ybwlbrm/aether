# Aether Agent Activity Stream 重构方案

> 目标架构：把"Card 式 Chat 输出"升级为"Event-driven Agent Activity Stream"
> 设计原则：交互逻辑参考 DeepSeek Harness，视觉语言保持 Aether 现有主题体系
> 本方案为第一阶段交付物：不包含代码实现，仅含协议设计、架构设计与实施计划
> 文档日期：2026-08-24

---

## 1. 差异分析：两大架构模式对比

### 1.1 现有架构（聚合消息模型）

```
User
 ↓
Fastify route handler（内联 Agent Loop）
 ↓
模型 / 工具
 ↓
（流式增量在此被反复降级）
    reasoning → message.toolResults JSON 字段
    tool result → role='tool' message 行（截断）
    agent 过程 → markdown 字符串拼接
    workflows → 完全不流式
 ↓
完整 Message（2-4 条）
 ↓
MessageBubble / MemoBubble 按 role 渲染
 ↓
Card / Card / Card / Card
```

**结构性缺陷**：事件只存在于一条 HTTP 请求的 SSE 生命周期内，即发即弃；数据库只有聚合后的 message；前端历史只能是 message；多端/刷新/断线恢复只能靠全量重拉。

### 1.2 目标架构（事件溯源 + 状态投影）

```
User
 ↓
Orchestrator / Agent Loop
 ↓
模型 / 工具
 ↓
Agent Event System（统一 AgentEventProtocol）
 ↓
Activity Event Stream
 ↓
Transport（SSE，支持 Last-Event-ID 回放）
 ↓
前端 Activity Store（Zustand，按 convId 存事件）
 ↓
Activity Renderer（单一渲染管线：实时 + 历史共用）
```

**关键转变**：
1. **消息模型 → 事件模型**：会话 = append-only 事件数组。任何 UI 状态（消息列表、活动流、任务进度、tool 卡片状态）都是事件列表的纯函数投影。
2. **流式即事件**：模型 delta、工具开始/结束、agent 状态变化都是事件流的真实成员，不存在"流式结束后再聚合"。
3. **历史 = 事件重放**：刷新页面后从数据库读回事件数组，用与实时完全相同的投影函数重建 UI —— 实时与历史天然一致。
4. **展示决策移出数据层**：服务端不再做去重改写（message-replace），只负责产生事实事件。

---

## 2. 统一 Agent Event Protocol 设计（Aether 适配版）

### 2.1 事件信封（envelope）

```typescript
// shared 包：src/shared/src/agent-event.ts
export interface AgentEventEnvelope {
  eventId: string            // uuid，全局唯一
  sessionId: string          // 会话归属（conversation.id 复用）
  taskId: string             // 本次运行 run/task id（AgentEventRun.id）
  agentId: string            // 'main' | 'sisyphus' | 'hephaestus' | ... 归属 agent
  agentType: string          // 'conversation' | 'planner' | 'coder' | ...
  eventType: AgentEventType  // 判别联合的 type
  timestamp: string          // ISO8601
  seq: number                // 会话内单调递增（决定顺序；回放去重键）
  status?: EventStatus       // started | running | completed | error | retry | cancelled
  content?: string           // 文本（reasoning/消息增量/错误说明）
  tool?: ToolEventPayload    // 工具事件专属（见下）
  parentEventId?: string     // 事件关联（tool.result 引用 tool.started）
  metadata?: Record<string, unknown>  // 扩展（token usage、耗时等）
}

export type EventStatus = 'started' | 'running' | 'completed' | 'error' | 'retry' | 'cancelled' | 'interrupted';

export interface ToolEventPayload {
  toolName: string           // 'read' | 'edit' | 'browser.search' | 'mcp.fileSystem.read' | ...
  toolInput: string          // 紧凑展示参数（如文件路径），不铺满 JSON
  toolOutput?: string        // 结果摘要（截断策略由前端控制，后端给全文+摘要）
  inputDetail?: unknown      // 完整参数（可展开查看）
  outputDetail?: unknown     // 完整结果（可展开查看）
  error?: { message: string; code?: string }
}
```

### 2.2 事件类型全集（判别联合）

```typescript
export type AgentEventType =
  // ── 会话生命周期 ─────────────────────────────
  | 'session.started'         // 会话创建
  | 'session.closed'          // 会话关闭

  // ── 任务生命周期 ─────────────────────────────
  | 'task.started'            // { taskId, title }
  | 'task.progress'           // { current, total, label } —— 任务进度（不伪造）
  | 'task.completed'          // 任务成功结束
  | 'task.cancelled'          // 用户取消
  | 'task.failed'             // 任务失败

  // ── Agent 生命周期 ───────────────────────────
  | 'agent.started'           // { agentId, agentType, name } —— 某 agent 开始工作
  | 'agent.status'            // { content } —— 简洁工作状态（"正在分析 Tool Router"）
  | 'agent.thinking'          // 等价 agent.status 的命名别名（思考中）
  | 'agent.waiting'           // 等待后续输入/条件
  | 'agent.resumed'           // 恢复
  | 'agent.completed'         // 单 agent 完成
  | 'agent.error'             // agent 出错
  | 'agent.retry'             // agent 重试
  | 'agent.spawned'           // { childAgentId } —— 生成子 agent
  | 'agent.handoff'           // { fromAgentId, toAgentId }
  | 'agent.failed'            // agent 最终失败

  // ── 模型流式消息 ─────────────────────────────
  | 'agent.message.delta'     // { content } —— 文本增量（真实 streaming）
  | 'agent.message.completed' // 消息组装完成
  | 'agent.reasoning.delta'   // { content } —— 思考增量（可选，后端门控）

  // ── 工具生命周期 ─────────────────────────────
  | 'tool.started'            // Action 开始：buildToolActivity(读文件/写文件/搜索...)
  | 'tool.progress'           // 长工具进度
  | 'tool.completed'          // Action 完成（√ 状态）
  | 'tool.error'              // Action 失败（✕ 状态）
  | 'tool.retry'              // Action 重试

  // 兼容映射（旧事件 → 新协议，见 §5 迁移）
  | 'message.delta'           // 普通模式文本 delta（无 agentId 场景）
  | 'token'                   // token usage 统计
  ;
```

> **设计意图**：事件类型刻意精简为"任务/Agent/消息/工具"四大族 + 会话族。活动流只消费其中 9 个核心类型（task.started/tool.started/tool.completed/agent.status/agent.message.delta/agent.completed/task.completed/task.progress/error），其余为扩展。**Activity Stream 与最终回答严格区分**：流式文本（agent.message.delta）渲染为"最终回答"区块，Action 事件渲染为紧凑活动行。

### 2.3 状态生命周期（UI 实时反映）

```
工具：tool.started(started) → tool.completed(completed)
      tool.started → tool.error(error) → tool.retry(retry) → tool.completed
Agent：agent.started → agent.thinking → tool.started → ... → agent.completed
任务：task.started → task.progress... → task.completed | task.cancelled | task.failed
```

每个 Activity 由 `status` 字段驱动渲染（pending → running → done/error），并允许 Retry 按钮对此事件发起重试（产生 parentEventId 关联）。

---

## 3. 后端架构设计

### 3.1 新事件层（core 概念）

```
modules/agents/ 新增：
├── event-bus.ts        # EventBus：订阅/发布，同时写 SSE + 落库
├── event-store.ts      # activity_events 表写入 + 按 runId/seq 查询
└── agent-run.ts        # AgentEventRun 生命周期（runId 创建/结束）

lib/provider.ts 改造：
└── StreamingChatClient  # 统一 OpenAI 兼容流式封装：SSE 解析/accumulator/
                         # tool_calls delta 拼装/usage 收集
                         # 回调：onDelta / onReasoning / onToolCallDelta / onToolResult / onUsage / onError
```

### 3.2 事件流管线

```
Agent Loop 中的每个动作点 → eventBus.emit(envelope)
                                    ├─→ SSE channel（reply.raw.writeHead text/event-stream）
                                    └─→ activity_events 表持久化（write-behind + flush）
                                            └─→ GET /api/runs/:runId/events 回放（Last-Event-ID）
```

**发射点清单**（现有代码中需要插入 emit 的位置）：

| 动作点 | 现有位置 | 新事件 |
|---|---|---|
| 任务开始 | orchestrate 入口 L558-596 | `task.started` |
| agent 启动 | 进入 Promise.all 前 L738-740 | `agent.started`（**改为按真实启动时机发，不再群发**） |
| 子 agent 推理 | agents L837 | `agent.reasoning.delta` |
| 子 agent 正文 | agents L840-842（**当前只累积不发送**） | 拆分为 `agent.message.delta` 流式发送 |
| 工具调用 | agents L898 / conversations L615 | `tool.started`（带 agentId！） |
| 工具结果 | agents L899 / conversations L643 | `tool.completed`（带 agentId + parentEventId） |
| 工具错误 | 工具执行器 catch | `tool.error` |
| 重试 | fetchWithRetry catch | `tool.retry` / `agent.retry` |
| 工作状态 | 各 agent 循环内 | `agent.status`（"正在分析 Tool Router"） |
| 最终文本 | agents L1001 / conversations L560 | `agent.message.delta` + `agent.message.completed` |
| 任务结束 | orchestrate L1023-1028 | `task.completed` |
| 取消 | activeRequests abort L650 | `task.cancelled` |

### 3.3 关键修复点（改造现有时必须落实）

1. **tool-call/tool-result 必须带 agentId**（agents L898-899）——Activity Stream 多 agent 归属的前提。
2. **子 agent 正文 delta 必须实时发送**（原 L840-842 只累积）——"观看 Agent 工作"的核心体验。
3. **agent-start 按真实执行时机触发**（原 L738-740 群发假并行）。
4. **tool-result 不再后端截断固定字符**（原 500/3000）——改传 `outputDetail` 全文 + `content` 摘要，前端控制展开。
5. **去重改写（message-replace）移除**——改为前端渲染层的展示逻辑。
6. **workflows 收编**：`agent` 节点执行时 emit 同一协议事件（分期）。

### 3.4 SSE 端点设计（向后兼容）

```
保持现有快速演进通道（一期）：
  POST /api/conversations/:id/messages  → SSE 事件改为按新协议发送
  POST /api/agents/orchestrate          → 同上

新增回放通道（二期）：
  GET  /api/conversations/:id/events?afterSeq=<n>   → 按 seq 回放全部事件
  用途：页面刷新 / 断线重连后 catch-up，前端用同一投影管线重建 UI
```

**Event Log + State Projection**：刷新时前端行为 = `GET events 全量` → 前端 store 从零重放。任务"已完成"也能完整恢复 Activity Stream（这正是 Event-aware 优于 message-aware 的关键）。运行中任务断线：重连后 catch-up 可恢复正在进行的任务视图（事件本身即中间状态）。

### 3.5 数据库迁移

```sql
-- 新增表（Drizzle schema 增量）
CREATE TABLE activity_events (
  id         TEXT PRIMARY KEY,          -- eventId
  session_id TEXT NOT NULL,             -- conversation.id
  run_id     TEXT,                      -- 关联当前运行（一期直接等于最后一轮 run）
  agent_id   TEXT NOT NULL DEFAULT 'main',
  event_type TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  status     TEXT,
  content    TEXT,
  tool_name  TEXT,
  payload    TEXT,                      -- JSON：toolInput/toolOutput/metadata 等完整载荷
  created_at TEXT NOT NULL,             -- ISO8601
  UNIQUE(session_id, seq)               -- seq 去重
);
CREATE INDEX idx_events_session_seq ON activity_events(session_id, seq);

-- 迁移策略：新写两份（messages 继续写，兼容旧 UI）+ events 新写。
-- 切换后（三期）messages 仅保留 user 消息（作为输入历史），assistant 消息改为事件重放派生。
```

> **向后兼容红线**：一期 events 与 messages 并行写入，两套 UI（旧 Card / 新 Stream）可在 feature flag 下并存切换，避免一次性摧毁现有功能。

---

## 4. 前端架构设计

### 4.1 状态层

```typescript
// 新 store：src/frontend/src/store/activityStore.ts（Zustand）
interface ActivityState {
  eventsByConv: Record<string, AgentEventEnvelope[]>;  // convId → 事件数组（按 seq 有序）
  tasks: Record<string, TaskProgressState>;            // 任务进度投影
  liveReplies: Record<string, string>;                 // agent.message.delta 累积（最终回答投影）

  appendEvent(convId, event): void;                    // 追加（按 seq 去重）
  replaceEvents(convId, events): void;                 // 刷新/回放全量重建
  getMessageThread(convId): Message[];                 // 投影：事件 → 消息列表（旧组件兼容）
}
```

- **单一事件源**：SSE 回调只做 `appendEvent`；渲染全部由事件驱动。
- **投影概念**：`getMessageThread` / `getActivityStream` / `getTaskProgress` 都是事件的纯函数投影——需要时按需计算（`useMemo`），保证实时与历史一条管线。
- 旧 `store/app.ts` 保持不动（纯 UI 态）。

### 4.2 传输层

```typescript
// 统一 SSE 客户端：src/frontend/src/api/streamClient.ts
export async function connectSSE(
  url: string,
  onEvent: (e: AgentEventEnvelope) => void,
  onError: (e: unknown) => void,
  signal: AbortSignal
): Promise<void>
// 唯一解析器，替换三处手写 getReader（client.ts L134 / Chat.tsx L291 / CodingHome.tsx L658）
// 修复历史 CRLF / trim bug；payload 有类型而非 any
```

### 4.3 Activity Renderer 组件设计

```tsx
// src/frontend/src/components/activity/ActivityStream.tsx
// 输入：events: AgentEventEnvelope[]（filtered by taskId）
// 输出：紧凑连续的活动列表（参照截图行为）

// 每条活动 = ActivityItem，按 eventType 分支：
//   tool.*  → icon(工具): 加 toolName + 路径   状态: pending → running → ✓/✕
//   agent.* → ● 徽标: 状态文本
//   task.*  → 任务卡片（可在尾部/侧栏独立为 TaskProgress 面板）
//   spread 展开输出摘要，点击展开 outputDetail —— 默认不铺满 JSON

// 行为字典示例（交互模型参考 DeepSeek 截图，视觉用 Aether 主题）：
//   tool.started  →  "Read   src/agent/core.ts"（追加行）
//   tool.completed→  同行打上 ✓，append 下一行
//   agent.status  →  "Think  正在分析 Tool Router"
//   agent.message.delta → "最终回答"区块实时追加文本
//   agent.completed → "✓ 完成"
//   tool.error    → "✕" + 错误摘要 + [↻ 重试] 按钮（发 retry 请求）
```

### 4.4 页面整合（一期范围收敛）

- **只改 Agent 输出区域及其直接相关组件**（用户硬性要求）：
  - 新建 `components/activity/` 目录（ActivityStream、ActivityItem、TaskProgress、ActionIcon）
  - `Chat.tsx` / `CodingHome.tsx` 的 assistant 区域改为 `ActivityStream`
  - 保留：Sidebar / Header / Layout / 主题系统 / 设置页 / 其他所有页面 —— **零改动**
- 死代码处理（审计发现 ai-elements 5/6 零引用）：`tool.tsx` 可保留复用；其余暂不删（本轮不扩大范围），但新渲染不再依赖它们。
- `ReasoningBar`（`agent.reasoning.delta` / 后端门控）保留为最新思考速览。

### 4.5 性能设计（预判 100-5000 事件场景）

| 手段 | 设计 |
|---|---|
| React.memo | ActivityItem 按 seq 稳定 key + memo，仅更新的条目重渲染 |
| 增量 append | store.appendEvent 只推最新事件，列表尾部插入，不整表重建 |
| rAF 批量 | 流式 delta 经 scheduleFlush 合帧（沿用 CodingHome L613-635 经验） |
| 投影缓存 | getMessageThread 等投影 useMemo + stateVersion 失效 |
| 虚拟化 | 事件量 > 500 时列表切换 windowing（前 200 + 尾部，滚动补片） |
| 超大载荷 | toolOutput 只存 `content` 摘要进事件数组，`outputDetail` 存 payload 展开再渲染 |
| 顺序保证 | seq 单调有序，前端按 seq 二分插入（沿用 DeepSeek insertionIndex 手法） |

---

## 5. 兼容 / 迁移策略

| 阶段 | 内容 | 兼容性 |
|---|---|---|
| 一期（Activity Stream 上线） | 统一协议 + 事件层 + 新渲染；messages 双写 | 旧接口照常，前端 feature flag 切换 |
| 二期（回放与恢复） | GET events 回放、断线 catch-up、刷新恢复 | 新增端点，无破坏 |
| 三期（架构清理） | messages 表退化为 user-only；workflows 收编；West 端 WS downlink（可选） | 内部重构 |

**假 Streaming 禁令遵守**：本方案全部基于现有 OpenAI 兼容 `stream:true` 真增量（已审计证实 conversations/agents/sync 均已真流式）。若某场景（analysis L697）需要非流式，则直接在事件层标注 `task.progress` 而不伪造 delta。**不留切片播放伪流。**

---

## 6. 实施计划（等待确认后执行）

### 阶段 A：协议与共享层（P0）
1. `src/shared/src/agent-event.ts` — AgentEventEnvelope + AgentEventType + 判别联合类型。
2. `src/shared/src/agent-event.test.ts` — RED 先行（顺序/字段校验）。
3. 后端 `event-bus.ts` + `activity_events` Drizzle schema + migration。

### 阶段 B：后端管线改造（P0-P1）
4. `lib/provider.ts` → `StreamingChatClient`（统一解析，替换 conversations/agents/sync 三处）。
5. conversations/agents 两条 SSE 端点改为发射新事件（带 agentId、子 agent 正文实时、tool 结果不截断）。
6. `GET /api/conversations/:id/events` 回放端点 + Last-Event-ID 支持。

### 阶段 C：前端状态与传输（P1）
7. `store/activityStore.ts`（events 按 convId + seq 去重 + 投影函数）。
8. `api/streamClient.ts` 唯一 SSE client，替换三处手写解析。

### 阶段 D：渲染层（P1-P2）
9. `components/activity/*`：ActivityStream / ActivityItem / TaskProgress。
10. Chat.tsx / CodingHome.tsx 的 assistant 区域接入 ActivityStream（feature flag 切换）。
11. 移除 coding 普通模式丢弃 tool 事件的行为；ReasoningBar 保留 + reasoning 落事件数组。

### 阶段 E：测试与验收（P2）
12. 用户列出的 11 项测试（普通聊天/单工具/连续工具/多 agent/工具错误/模型错误/网络中断/取消/长任务/刷新/快速连续消息）。
13. UI 验收：连续性、实时性、紧凑性、无 AI 小作文、视觉保持 Aether 主题。
14. 性能验证：事件 5000+ 场景下渲染与内存观察。
15. 最终审计（事件缺失/重复/状态竞态/泄漏）。

---

## 7. 明确不做的事（用户禁令映射）

| 禁令 | 本方案承诺 |
|---|---|
| 不重做整个应用 UI | 只建设 `components/activity/` + 两个对话页 assistant 区域 |
| 不改变设计语言 | 全部样式走 Aether Tailwind 主题 token，不引入 DeepSeek 品牌视觉 |
| 不删除现有功能 | events 与 messages 双写，旧功能可回退 |
| 不假 Streaming | 全部真增量；非流式场景发状态事件不伪造 delta |
| 不暴露完整 CoT | reasoning 由后端门控为简洁状态（agent.status），不直传内部思考全文 |
| 不默认展开 Tool JSON | 默认紧凑行，展开才显示详情 |
| 不把每个事件做成大卡 | ActivityItem 是 ≤单行紧凑条目 |
| 不加无意义动画 | 仅 streaming 光标/状态切换/完成打勾，专业工具感 |