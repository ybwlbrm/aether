# Aether 当前项目审计报告（Agent 输出系统）

> 审计对象：D:\PersonalAICommandCenter（Aether）src/backend 与 src/frontend
> 审计范围：Agent Loop / Orchestrator / Provider / Tool / Session / Event / Streaming / 传输层 / 前端渲染 / Multi-Agent
> 审计日期：2026-08-24

---

## 0. 技术栈与总体结构

```
Frontend: React 19 + Vite 6 + TS + Tailwind 4 + Framer Motion + Zustand
Backend:  Fastify 5 + Drizzle ORM + sql.js (SQLite)
Monorepo: src/shared / src/backend / src/frontend（npm workspaces）
对话页：   /chat → Chat.tsx；/command-center + uiMode='coding' → CodingHome.tsx
```

【证据】`package.json`、`PLAN.md` 技术架构图。

---

## 1. 后端架构事实清单

### 1.1 路由与插件组织
- `app.ts:137-159`：23 个模块 `registerXxxRoutes(app, cfg)` 平铺注册，无前缀分组、无插件封装、无共享上下文。
- `app.ts:57-76` onSend 注入 CSP；`app.ts:101-118` onRequest Host + CSRF 校验；`app.ts:171-173` onResponse markDirty。
- **全仓库无 WebSocket 服务端实现**（CSP 中 `ws://` 仅为白名单预留，`app.ts:64`）。
- SSE 端点用 `reply.raw.writeHead` 绕过 Fastify 生命周期（`conversations/index.ts:330-336`）——**全局错误处理器对它们无效**。

### 1.2 Provider 层：不存在抽象
- `lib/provider.ts` 全文 131 行，**只有配置解析职责**（从 SQLite 读 provider + 解密 apiKey + 拼 baseUrl），无任何 fetch/stream。
- 真正的模型调用散落 8 处，各自手写：
  | 调用点 | stream | 说明 |
  |---|---|---|
  | conversations/index.ts:501-513 | ✅ L509 | 手写 SSE 行解析 L520-589 |
  | agents/index.ts:790-802（子 Agent） | ✅ L799 | 手写解析 L809-862 |
  | agents/index.ts:960-975（汇总） | ✅ L972 | 手写解析 L977-1008 |
  | agents/index.ts:1125-1151（sisyphus 普通） | ❌ L1148 | `res.json()` 一次性 |
  | agents/index.ts:690-700（编排分析） | ❌ L697 | `res.json()` 一次性 |
  | workflows/index.ts:104/136/164/623 | ❌ 全部 | 整图跑完才响应 |
  | sync/index.ts:445-459（手机端） | ✅ L456 | 第 3 套手写解析 L498-628 |
  | memory/index.ts:176 | ❌ | — |

**结论**：模型侧真流式可用，但"流式→事件"逻辑被复制 3 份，4 个场景直接放弃流式。

### 1.3 对话模块（普通模式）
- **传输是真 SSE**（`conversations/index.ts:330-336`），15s 心跳。
- 事件词汇（散落无 schema）：`retry` / `reasoning`(delta) / `message`(delta) / `reasoning-end` / `tool-call` / `tool-result`(截断3000) / `message-replace` / `token` / `error` / `[DONE]`。
- Loop：`maxTurns=10` while 循环（L489/499），function calling 循环。

### 1.4 Agent 编排模块（超级模式）
- **Loop 在 HTTP handler 内联**（`agents/index.ts:558-1057`），无独立 orchestrator/队列/worker。
- 三阶段：Sisyphus 分析（stream:false）→ `Promise.all` 并行子 Agent（stream:true，fcTurns=4）→ Sisyphus 汇总（stream:true）。
- 事件：`analysis` / `agent-start` / `reasoning`(带agentId) / `tool-call`(不带agentId) / `tool-result`(截断500) / `agent-result` / `message` / `token` / `[DONE]` / `error`。

### 1.5 MCP
- `lib/mcp-client.ts:150-190`：`callMcpTool` 返回截断 ≤4000 字符的 `Promise<string>`，**无进度/部分结果/事件点**。
- `mcp-client.ts:166` 注释自曝缺口："调用方应通过 SSE 事件回传确认请求给前端" —— **只有注释，没有实现**。

### 1.6 数据库：无事件层
- messages 表（`schema/index.ts:30-38`）：role(user/assistant/system/tool) + content(text) + toolCalls(JSON) + toolResults(JSON)。
- **没有 events 表 / activity 表 / run 表**。
- `toolResults` 字段语义过载 4 种用途：token usage / **reasoning 全文**（conversations L716）/ MCP 结果 / 空。
- `conversations.generationState`（schema:24，注释"stores orchestration state for session persistence"）：**声明了但全仓库无读写**（前人已留锚点未用）。

### 1.7 工作流模块：与 Agent 零集成
- workflows 的 agent 节点自己直接 `fetchWithRetry(baseUrl/chat/completions, {stream:false})`（L104-113），**不经过 agents 编排器、不产生任何事件**。
- `POST /api/workflows/:id/run`（L451-581）同步阻塞，整 DAG 跑完才返回 JSON。

### 1.8 错误处理与重试
- `plugins/error-handler.ts` 只覆盖 JSON 路由；SSE 路由靠 handler 内 try/catch + 手工 `sseSend('error')`。
- `fetchWithRetry`（conversations L57-107）：可重试 `[404,429,500,502,503,504]`，429 尊重 Retry-After + 退避表 `[3s,5s,10s,30s,45s]`，120s 总超时，**每次重试发 SSE `retry` 事件**（系统里唯一的"过程性事件"）。
- 反模式：agents/workflows/sync 从 conversations 模块 import `fetchWithRetry`（基础设施寄生业务模块）。

---

## 2. 前端架构事实清单

### 2.1 目录结构
```
src/frontend/src/
├── api/client.ts            # 唯一 API 层 + 内嵌 SSE 解析器
├── store/app.ts             # 唯一 Zustand store（32 行，仅 UI 态）
├── routes/Chat.tsx          # /chat 传统对话页（750 行）
├── routes/CodingHome.tsx    # coding 模式对话页（1120 行）
├── routes/CommandCenter.tsx # uiMode==='coding' 时转渲染 CodingHome
├── components/ReasoningBar.tsx   # 思考横条（活跃）
├── components/AIAgentInput.tsx   # 【死代码】零引用
└── components/ai-elements/       # assistant-ui 风格库（5/6 死代码）
    ├── tool.tsx             # 唯一被使用（仅 Chat.tsx）
    └── message/conversation/reasoning/chain-of-thought/shimmer.tsx  # 全部零引用
```

**没有 services 目录、没有 chat store、没有 AI 相关 hooks**。所有 AI 对话逻辑内联在两个页面组件里。

### 2.2 两页分工
| | Chat.tsx (/chat) | CodingHome.tsx |
|---|---|---|
| 流式 | 每 delta 直接 setMessages | rAF 批量合并（~16ms 一帧） |
| 工具事件 | 写入 toolCalls JSON + 渲染 Tool 卡 | **传 undefined 丢弃**（L738），靠轮询补 |
| 同步 | 流结束后重拉 | 流式 + **1 秒轮询 getConversation** 并行 |
| 超级模式 SSE 解析 | 内联（Chat L291-352） | 内联复制粘贴（L658-720） |

两页的 handleSend / SSE 解析**近乎复制粘贴双份实现**。

### 2.3 数据模型：几大降级点
- Message 接口（CodingHome L113-119）：`{ id, role(user/assistant/tool), content, reasoning?, createdAt }` —— **没有 parts/blocks/events 数组**。
- Tool 调用不是独立实体：`JSON.stringify` 挤进 assistant message 的 `toolCalls` 字符串（Chat L390-396），渲染时再 `JSON.parse`（L39/L53）。
- **最严重**：超级模式把 agent-start/agent-result **结构化事件拼成 markdown**，再 `string.replace` 回填结果（Chat L320-332 / CodingHome L682-703）——事件顺序、状态、并发关系全部丢失，只剩大字符串。
- 历史 thinking 丢失：loadMessages 从 toolResults 抠 reasoning（Chat L150-158），但 **MessageBubble/MemoBubble 无渲染 msg.reasoning 的分支**。

### 2.4 渲染：按 role 三分支强制 Card 化
| 用户看到的卡 | 组件 | 证据 |
|---|---|---|
| Answer 卡 | MessageBubble/MemoBubble assistant 分支 + Streamdown 渲染整个 content | Chat L74-78 |
| Tool 卡 | 气泡内 `JSON.parse(msg.toolCalls)` 循环渲染 `<Tool>` | Chat L51-69 |
| Result 卡 | MemoBubble tool-role 绿色折叠框"🔧 工具执行结果" | CodingHome L70-103 |
| Thinking | 不在消息流！流式期进 ReasoningBar（输入框上方横条） | Chat L96-98/L625-644 |

`Tool state="input-available/output-available"` 是**硬编码**的（Chat L42/L59），tool.tsx 虽支持 7 种状态机（approval-requested/input-streaming/output-error...），但数据层没存状态，渲染层只能猜。

---

## 3. Multi-Agent 现状

### 3.1 Agent 存量清单（11 个，硬编码 `agents/index.ts:58-378`）
| id | 角色 | 对应 README 术语 |
|---|---|---|
| sisyphus | 主编排 | Orchestrator |
| oracle | 高智商顾问/推理 | — |
| librarian | 知识检索 | Researcher |
| explore | 代码探索 | — |
| hephaestus | 构建执行 | Coder |
| metis | 预规划分析 | Planner |
| momus | 质量审查 | Reviewer |
| atlas | 架构设计 | — |
| prometheus | 规划制定 | Planner |
| multimodal-looker | 多模态分析 | Browser 近似 |
| sisyphus-junior | 子任务执行 | Subagent |

grep Planner/Coder/Researcher/Reviewer 前后端**零匹配** —— README 用通用术语，代码全是希腊神话命名。无 Browser Agent（浏览器能力仅通过 MCP 工具间接存在）。

### 3.2 编排机制：广播扇出，非协作编排
- 阶段 1：LLM 输出 JSON agent 数组（L688），失败回退关键词正则 `routeMessage()`（L382-447），最后无条件 `targetIds.push('sisyphus')`（L722-729）。
- 阶段 2：`Promise.all(targetAgents.map(...))`（L744）。每个 agent 独立 provider/model（`resolveAgentEndpoint` L617-626）、独立 /chat/completions 流式调用、fcTurns=4。
- 阶段 3：把所有结果拼进 synthPrompt 再调一次 LLM（L944-956）。
- Agent 间**无真实消息传递**：只有一段静态文本 `crossContext`（"其他 Agent 正在并行工作，请聚焦你的专业领域"，L743/755）注入各 agent prompt。Agent A 的输出不进 Agent B 上下文。**无 planner→worker 任务分解、无共享黑板。**
- **第二套平行宇宙**：workflows 模块的 DAG（`topoSort` + `executeNode`，node 含 'agent'），直接裸调 chat/completions，与 AGENTS 数组完全不互通。

### 3.3 事件缺陷（活动流重构靶点）
| 通道 | 事件 | 带 agentId? |
|---|---|---|
| /api/agents/orchestrate | analysis, agent-start, reasoning, tool-call, tool-result, agent-result, message, token, error, retry | 仅 reasoning/agent-start/agent-result 有 |
| /api/conversations/:id/messages | reasoning, message, reasoning-end, tool-call, tool-result, message-replace, token, error, retry | 全部没有 |

- `tool-call`/`tool-result` 缺 agentId（agents L898-899）→ 多 agent 并行时无法归属。
- **编排全过程零持久化**：agent 中间输出/工具调用/耗时/token 只在 SSE 瞬间存在，之后永久丢失（orchestrate 只写 user + assistant 汇总两条）。

---

## 4. 根源分析：为什么是"方块式 Card UI"

### 4.1 根因结论（双重，主因在数据层）

> **因为 SSE 的连续事件流（delta / tool-call / tool-result / reasoning / agent-start / agent-result）在页面组件的回调里被立刻熔铸成 1 条 assistant message 的 3 个字段（content 字符串 + toolCalls JSON 字符串 + liveReasoning 独立 state）。渲染层拿到的就是"user 一条 + assistant 一条 (+tool 几条)"的贫瘠数据，只能渲染成几个大 Card。渲染层的 ai-elements 活动流组件因数据不匹配而整体闲置（5/6 死代码）。**

### 4.2 逐一验证用户提出的 12 个疑点

| # | 疑点 | 验证结果 | 证据 |
|---|---|---|---|
| 1 | Agent 一次性返回完整消息 | ❌ 模型是真流式，但 4 个场景流式被放弃（analysis L697 / sisyphus L1148 / workflows 全部） | 见 §1.2 |
| 2 | Streaming 在后端被聚合 | ✅ **是**。tool-result 截断 3000/500；子 Agent 正文 delta 不发送只累积（agents L840-842 vs L920）；agent-start 进入 Promise.all 前一次性群发（L738-740） | 见 §1.4 |
| 3 | Event 被转换成 Message | ✅ **是**。reasoning→toolResults JSON 字段（conversations L713-717）；tool result→role='tool' message 行（L648）；编排只存 finalReply | 见 §1.3/1.6 |
| 4 | Message 被转换成 Card | ✅ **是**。MessageBubble/MemoBubble 按 role 三分支 + Streamdown 渲染整字符串 | 见 §2.4 |
| 5 | Tool Call 没有独立 Event | ❌（部分）。SSE 里有 tool-call 事件，但**不落库、无 agentId、前端塞进 JSON 字符串** | 见 §3.3 |
| 6 | Tool Result 没有独立 Event | ❌（部分）。SSE 有 tool-result，但截断 + 落库为 message 行 + 前端字符串替换 | 见 §1.3/2.3 |
| 7 | Thinking 被当成普通 Message | ✅ **是**。reasoning 全量塞进 messages.toolResults；前端转成横条临时态，历史丢失 | 见 §1.6/2.3 |
| 8 | Multi-Agent Event 被错误聚合 | ✅ **是**。agent-start/result 拼成 markdown 用 string.replace 回填 | Chat L320-332 |
| 9 | 前端只监听最终结果 | ✅ **是**。CodingHome 普通模式丢弃流式 tool 事件靠 1 秒轮询（L738/L451-522） | 见 §2.2 |
| 10 | 没有统一 Event Protocol | ✅ **是**。SSE 事件名是散落裸字符串，无 schema/版本/统一 envelope（无 seq/runId/timestamp），前端 payload 全 any | 见 §2.4 |
| 11 | Event 没有生命周期 | ✅ **是**。tool.tsx 支持 7 态但渲染时硬编码 state；无 started→running→completed 建模 | 见 §2.4 |
| 12 | UI Renderer 强制把每个事件变成 Card | ✅ **是**。渲染层只有 MessageBubble 一种容器；ai-elements 活动流组件死代码 | 见 §2.4 |

### 4.3 深层根因（按影响排序）

1. **无事件层**：数据库无 events/activity/run 表，事件即发即弃，`generationState` 空列是前人留的锚点未用。
2. **Provider 层缺失**：无统一 streaming client，SSE 解析复制 3 份（后端 conversations/agents/sync + 前端 3 处 getReader）。
3. **会话模型是 message-centric**：一轮 = 2-4 条 message 行，tool/reasoning/子 agent 全都挤在字段里，顺序/状态/对应关系结构上不可表达。
4. **两套平行输出范式**：普通（reasoning/message-replace 协议）+ 超级（agent-* 协议）+ workflows（完全无协议）三套互不相通。
5. **展示策略侵入数据生成**：服务端字符串去重改写 AI 输出 + message-replace（conversations L669-691）——渲染决策写死在数据层。

---

## 5. 与 DeepSeek Harness 的差距对照表

| 维度 | DeepSeek Harness | Aether 现状 |
|---|---|---|
| 事实源 | append-only 事件日志（Session） | 聚合后的 messages 表行 |
| 事件协议 | 类型化 discriminated union + seq + ignorable | SSE 裸字符串，无 schema |
| 事件持久化 | jsonl/sqlite write-behind + flush checkpoint | 无（sssion 即发即弃） |
| 会话恢复 | Projection 从日志重放，restoreFloor 防截断 | GET 全量 + 1 秒轮询 |
| 流式传输 | WS downlink 单向（Web）+ JSON-RPC (CLI) | 裸 SSE，解析复制 3 份 |
| Tool 生命周期 | pre-execute/execute/post-execute + presentCall/Result | if/else 链 + 截断字符串 |
| Tool 归属 | result 通过 sourceEventSeqs 引用 call | tool-call/result 无 agentId |
| 多 Agent | child session = 父日志 seed replay + delegationDepth | 广播扇出 + markdown 拼接，零持久化 |
| 取消 | interrupted:true 保留已流前缀，合成错误对保 replay | activeRequests Map + 无事件落库 |
| 重试 | retry 决策先落日志（durable before wait） | SSE 发 retry 事件但不落库 |
| 前端分层 | 数据层/渲染机器层/展示层 三层红线 | 页面组件内 useState 全内联 |
| Pub 策略 | 三档（手势/微任务/chunk 帧） | 每 delta setMessages / rAF / 1 秒轮询混用 |

**一句话差距**：DeepSeek Harness 是"事件日志驱动的状态投影"，Aether 是"聚合消息驱动的卡片渲染"。前者所有 UI 都是日志的纯函数，后者所有事件都被迫先变成 message 才能活下来。

---

## 6. 重构切入点排序（供方案设计）

| 优先级 | 工作项 | 消灭的问题 |
|---|---|---|
| P0 | 新增 `activity_events` 表（run_id, seq, type, actor, payload, created_at）+ run 概念 | A10 无事件层 |
| P0 | `lib/provider.ts` 升级为统一 StreamingChatClient | 3 份后端 SSE 解析复制 |
| P1 | SSE 端点改造：`/api/runs/:runId/events` 支持 Last-Event-ID 回放 | 断线恢复/回放/多端同步 |
| P1 | 工具执行器 registry（消灭 2 处 90 行 if/else 链），MCP/内置工具统一 emit started/progress/completed | Tool 生命周期缺失 |
| P1 | 统一 AgentEvent 前端类型 + 唯一 SSE client | 前端 3 处 getReader 重复、payload=any |
| P2 | 前端 chatStore（events 按 convId 存储按事件驱动） | 字符串拼接降级点 |
| P2 | ActivityStream 组件（复活/重写 ai-elements） | Card 化渲染 |
| P3 | 去重改写移出服务端、ConversationNodeDefinition、WS downlink | 架构对齐 DeepSeek Harness |

详细方案见 `03-refactor-plan.md`。