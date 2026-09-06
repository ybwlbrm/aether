# Aether 整改 — 审计问题登记（进行中）

> 状态：**修复阶段** · 持续追加
> 标注：CONFIRMED（有代码证据）/ LIKELY / POSSIBLE / NOT VERIFIED
> 修复进度：✅ = 已修复并验证；🔄 = 修复中；⬜ = 未开始

## 修复进度总览

| ID | 问题 | 状态 | 验证 |
|----|------|------|------|
| P0-05 | packed replay 不过滤 | ✅ | backend 812 tests（含 packed-replay 用例） |
| P0-06 | 幽灵 seq claim | ✅ | backend 812 tests（含 ghost-claim 用例） |
| P0-08 | activityStore seq-only 去重 | ✅ | frontend test 12/12 + tsc PASS |
| P0-13 | bridge 不解密 API Key | ✅ | backend 812 tests（含 2 新用例） |
| P0-14/15 | SSE fire-and-forget 不 reject | ✅ | streamClient.test 10/10 + frontend 43/43 |
| P0-17 | activeRequests 按 conversation | ⬜ | — |
| P0-18 | agent.completed 误判 task 完成 | ✅ | activityStore.test（P0-18 用例 PASS） |
| P0-21 | FK 删除崩溃 | ✅ schema onDelete + migrate v13 | backend 812 tests；删除路由补删 🔄 |
| P0-22 | Workflow 未接入 Runtime | 🔄 子任务运行中 | — |
| P1-02 | reasoning 未按 agent 隔离 | ✅ | activityStore.test PASS |
| P1-13 | clearConv 清空历史 | ✅ | useStreamSend 已移除 clearConv |
| P1-16 | backend crash Run 恢复 | ✅ | 新增 POST /api/runs/recover |
| P1-17/18 | Electron stdout/EADDRINUSE | ✅ | main.js 改为健康轮询 |
| P1-19 | 重启无 recovery | ✅ | main.js + /api/runs/recover |
| P0-A01~22 | Mobile/Supabase 系列 | ⬜ | — |
| P0-01~04 | v1/v2 双协议收尾 | ⬜ | — |


## P0 — 严重

### P0-01 v1/v2 Event 双协议并存 — CONFIRMED
- `eventType` 字段风格：51 文件 188 处（activityStore 22、bus-core 8、event-store.sqlite 7、chunk-packer 6、legacy-adapter 6、event-replay 6、streamClient 4、useStreamSend 4、ActivityStream 2、CodingHome 4）
- `AgentEventEnvelope`：21 文件 79 处（shared/legacy-adapter 11、activityStore 9、event-bus/types 9、streamClient 6）
- `AgentEvent`（v2 type 判别联合）：shared/src/agent-event.ts 定义
- 前端 streamClient.ts 同时消费「envelope（eventType）」与「旧事件名（token/reasoning/tool-call）」双轨

### P0-02 前端仍主要消费 v1 — CONFIRMED
- activityStore.ts 22 处 eventType 判断；streamClient.ts 保留全套旧事件名兼容分支（L103-133）
- 前端 API 仍走 `/api/conversations/:id/messages`（streamClient L175）与 `/api/conversations/:id/events`（L229），未走 `/api/runs/:runId/events`

### P0-03 前端 Event API 未迁移到 Run — CONFIRMED
- streamClient.fetchEvents → GET `/api/conversations/:id/events`（L229）
- 后端既有 `/api/runs/:runId/events`（runs/events.ts）又有 conversation 级路径
- 真正 Runtime 事件事实源应在 run 上

### P0-04 双 Event Store — CONFIRMED
- `activity_events` 表：db/schema/index.ts L185 定义；仍被写入：chat-handler.ts、agents/sse-handler.ts、event-store-runtime.ts、lib/todo-tools.ts
- `events` 表：db/schema/index.ts L256 定义（UNIQUE(run_id,seq)）
- 迁移：db/migrate.ts 处理 activity_events（仍在保留）
- 前端 CodingHome.tsx 仍读 activity_events 相关路径

### P0-05 packed event replay 不过滤 — CONFIRMED（严重）
- `event-store.sqlite.ts` L176-187 `listAfter`：SQL 层 `gt(events.seq, seq)` 按**物理行**过滤；packed 行物理 seq = 最后一个子事件 seq；L227-251 `#rowsToEvents` 展开 packed 后**不再按逻辑 seq 过滤** → `afterSeq=150` 时含 seq 101-196 的 packed 块整块返回
- `modules/runs/events.ts` L56-71：路由直接 SQL `gt(seq, afterSeq)` + 只 `JSON.parse(row.payload)` → **packed 行不展开**，中间子事件丢失（payload 只含最后子事件）
- `modules/runs/stream.ts` L43-51 `readEvents`：同样 SQL 过滤 + 不展开 packed

### P0-06 幽灵 sequence claim — CONFIRMED
- `sequence-allocator.db.ts` L74-84：allocate() 先 INSERT `__seq_claim` 行（payload='{}'）再返回 seq；崩溃/异常时 claim 行永久残留
- `event-store.sqlite.ts` L34 保留 `__seq_claim` 类型；upsertEvent L58 用真实事件替换 claim 行
- **风险**：claim 后崩溃 → events 表中永久存在无 payload 伪事件；且 `#rowsToEvents` 读到 claim 行会 JSON.parse('{}') 返回残缺事件泄漏到前端
- 结论：claim 未与真实 append 绑定在同一事务（sql.js 无事务 helper，appendBatch 逐条 upsert）

### P0-07 Run-level seq 统一 — LIKELY
- `DbSequenceAllocator` 按 runId 分配（allocate(runId)），UNIQUE(run_id,seq)
- 但 legacy event-bus（lib/event-bus/persistence.ts、memory-bus.ts）仍有独立 seq 机制；v1/v2 双总线并存
- 待确认：legacy 路径是否仍写独立 seq

### P0-08 Activity Store 去重只用 seq — CONFIRMED
- activityStore.ts L88 `list.some(e => e.seq === event.seq)` 去重 —— **仅 seq**，跨 Run 会误判（Run A seq=1 vs Run B seq=1）
- appendEvents L101 `new Set(list.map(e => e.seq))` 同样问题
- eventsByConv 结构（按 conversation 混合所有 run 的事件，非 eventsByRun）加剧冲突

### P0-09 Run State Machine 唯一性 — 待定（后台审计中）
- runs 表状态机：created → running ⇄ waiting → completed | failed | cancelled | interrupted（schema L212-214）
- core/runtime/runtime.ts 与 modules/runs/routes 是否双处修改状态 → 待确认

### P0-10 Run State 与 Event 闭环 — 待定（后台审计中）

### P0-11 关键 Event 写失败静默吞掉 — LIKELY
- event-store.sqlite.ts L77-79 duplicate 只 warn（幂等合理）
- L258 corrupt JSON 只 warn 跳过（读路径）
- 写路径：`upsertEvent` 无 try/catch 包裹 → 异常会抛出？待确认 runtime 层是否 catch+warn+continue

### P0-12 Model Runtime 未真正接管 — CONFIRMED（严重）
- `fetchWithRetry` 16 文件 33 处：documents/index.ts 6、node-executors.ts 4、tool-loop.ts(conversations) 3、tool-loop.ts(agents) 3、orchestration.ts 3、memory/index.ts 2、compaction.ts 2、ai-creator.ts 2、chat-handler.ts 1
- `chat/completions` 19 文件 33 处：provider-adapter.ts 5（合法）、node-executors.ts 3（**Workflow 直接调**）、tool-loop.ts 2+2、orchestration.ts 2、model-runtime-factory.ts 2、documents 2、command-processor.ts 2、memory/index.ts 1、compaction.ts 1
- workflows/node-executors.ts L54-64：Agent 节点直接 `fetchWithRetry(baseUrl/chat/completions, {Authorization: Bearer ...})`，完全绕过 ModelRuntime/ProviderAdapter

### P0-13 Model Runtime Bridge 不解密 API Key — CONFIRMED（严重）
- `lib/model-runtime-bridge.ts` L47 `apiKey: row.apiKey` — **DB 密文直接传给 ModelRuntime**，未调用 decrypt
- 对比：lib/provider.ts L125 `apiKey: decrypt(row.apiKey, encryptionKey)` 正确解密（chat-handler 路径 OK）
- 后果：走 bridge 的路径（buildRuntimeForProvider/buildAllRuntimes）会用密文当 Bearer → 模型调用 401 失败

### P0-14 Streaming Promise 未等待 SSE 完成 — CONFIRMED
- streamClient.ts L163 `void process().catch(...)` — **fire-and-forget**！
- L196 `parseSSEStream(res.body.getReader(), callbacks)` 后立即返回 → `streamConversation` Promise 在流开始时即 resolve
- useStreamSend.ts await streamConversation() 实际不等待流结束；错误仅经 onStreamError 回调

### P0-15 SSE 错误未 reject — CONFIRMED
- parseSSEStream 内部错误只走 `callbacks.onStreamError?.(e)`（L163），外部 Promise 已 resolve
- useStreamSend 无法经 try/catch 感知流内错误；只能在 onEvent error 分支手动拼接

### P0-16 [DONE] 与业务终态分离 — LIKELY
- streamClient L88 `dataLine === '[DONE]'` 直接 return（未标记 terminal）→ 传输层 DONE 与业务终态分离 ✓（部分正确）
- sawTerminal 由 task.completed/task.failed/agent.output.completed 驱动（L95-97）✓
- 但后端 stream.ts 不发送 [DONE]，也不发业务终态判定 → 前端只靠事件判断
- 断流检测 L158-160：EOF && !sawTerminal → stream-truncated ✓（已实现）

### P0-17 activeRequests 按 conversation 管理 — CONFIRMED
- chat-handler.ts L127 `activeRequests.set(id, clientAbort)`（id = conversationId）；L128 close 时删除
- 按 conversationId 管理 → 同会话多 Run 互相覆盖/取消错杀

### P0-18 agent.completed ≠ task.completed — CONFIRMED
- activityStore.ts L160 `if (ev.eventType === 'task.completed' || ev.eventType === 'agent.completed')` 把 agent.completed 当任务完成 → status=completed
- projectTaskCard L264 只认 task.completed/task.failed（正确），但 projectTaskProgress L160 混入 agent.completed（错误）

### P0-19/20 双权限体系 — CONFIRMED
- ToolPolicy：core/tools/tool-policy.ts 10 处 + tool-executor.ts 6 处接入
- PolicyEngine：core/permissions/policy.ts + permissions/index.ts 2 处
- 两套并存 26 文件 111 处；ToolExecutor 具体接哪套 → 后台审计确认中

### P0-21 FK 删除 — CONFIRMED（严重）
- db/schema/index.ts：所有 FK 均**无 onDelete**（providers L21→conversations、conversations→messages L33、conversations→activityEvents L187、conversations→runs L211、runs→tasks L234、runs→events L258）
- conversations/routes.ts L178-187：删除只删 messages + conversations！**未删 activity_events/runs/tasks/events/workflow_runs/artifacts** → FOREIGN KEY constraint failed 必然发生
- Supabase 删除 L194-195 只删 messages_sync + conversations_sync

### P0-22 Workflow 未接入 Runtime — CONFIRMED
- workflows/node-executors.ts：Agent/Media/Doc 节点全部直接 fetchWithRetry → chat/completions（L62、L98、L130）
- 未走 RunRuntime → TaskRuntime → AgentRuntime → ModelRuntime 链

### P0-23 Workflow 条件分支 — 待定（后台审计中）

### P0-24 AgentRuntime 真实度 — 待定（后台审计中）

### P0-25 unsafe cast — CONFIRMED
- `as unknown as`/`as never`：32 文件 68 处（含 node_modules 干扰；核心位置：chat-handler 2、orchestration 2、legacy-adapter 2、agent-runtime 1、stream.ts 1、event-store-runtime 1、tool-runtime-bridge 1、node-executors 1、documents 1、stream-translate.test 5、migrate.test 3）
- agent-event.ts 定义处 L1（as AgentEvent 类型断言模式遍布）

### P0-26 Memory 事实源 — LIKELY
- memory.json 11 文件 18 处：memory-runtime-bridge.ts 4、dal.ts 1、dal/memory.ts 1、dal/active-memories.ts 1、db/schema/index.ts 1（memories 表存在）
- JSON 文件与 memories 表并存 → 需确认写入点

### P0-27 output/message 语义 — 待定（后台审计中）

## P0-A — Android/Supabase

### P0-A01 Service Role Key — CONFIRMED（设计缺陷）
- mobile/src/api/supabase.ts L80 `createClient(cfg.supabaseUrl, cfg.supabaseKey)` — 客户端直接以用户手填 key 连接
- key 仅存内存（L28 memoryKey、L50 saveConfig 注释）——缓解但不解决：无 Auth 认证、无 RLS 边界、手填 key（anon 或 service_role 均可被填入）
- 无 Supabase Auth 登录/登出/session/refresh

### P0-A02 安全架构 — CONFIRMED 需重构
- 客户端直连 Supabase（无 Edge Function / Secure Backend 中转设计）

### P0-A03 登录机制缺失 — CONFIRMED
- 无 Supabase Auth；无 device registration（仅 upsert devices 表 L94-99，无身份绑定）

### P0-A04 RLS — NOT VERIFIED（需找 supabase SQL；已被 .gitignore 排除）
- supabase-fix-rls.sql / supabase-schema.sql 在开源版 .gitignore 排除列表 → 自用版可能存在但被忽略，需检查

### P0-A05 Device ID — CONFIRMED
- supabase.ts L41 `'mobile-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)` — 任务描述的「mobile-Date.now-random」

### P0-A06 Realtime DELETE 未处理 — CONFIRMED
- subscribeConversations L250-252 `callback(payload.new)` — event '*' 且 DELETE 时 payload.new 为 null → 前端无法正确删除
- 未检查 payload.eventType / payload.old

### P0-A07 Realtime channel 生命周期 — CONFIRMED
- 全局变量 messagesChannel/conversationsChannel（L25-26）
- subscribeMessages L194-196：每次订阅先 removeChannel 旧 channel → 多 conversation 页面互相杀 channel
- subscribeConversations L239-241 同理

### P0-A08 Realtime + polling 双跑 — 待确认（NewCommand/MessageView，后台审计中）

### P0-A09 流式依赖 messages_sync UPDATE — CONFIRMED（注释自证）
- supabase.ts L218-220 注释：「流式更新：后端逐块 upsert 同一消息，内容逐渐增长」
- 违背 Event 协议同步方向

### P0-A10 数据模型统一 — CONFIRMED（部分）
- mobile 只有 conversations_sync/messages_sync/remote_commands；无 Run/Task/Agent/Event 模型消费

### P0-A12 Run/Agent/Tool Activity — CONFIRMED（缺失）
- mobile 无 Run/Event 同步；只有 message 流

### P0-A13 Activity 语义统一 — CONFIRMED（缺失）

### P0-A16 远程命令与 Run 关联 — CONFIRMED（缺失）
- sendCommand L136-141：insert remote_commands 仅 device_id/conversation_id/content/status，无 runId/taskId 关联字段

### P0-A17 幂等 — CONFIRMED（缺失）
- sendCommand 无幂等键（client_command_id）；网络重试会重复 insert

### P0-A18 同步状态显示 — 待确认（后台审计中）

### P0-A19 数据一致性字段 — 待确认（后台审计中）

### P0-A22 上传公开 URL — CONFIRMED
- uploadFile L161-162 `getPublicUrl()` → 公开永久 URL；无 signed URL、无过期、无 size/MIME 限制

## P1 — 高风险

### P1-11 前端 abort race — 部分已修
- useStreamSend L162-167：每次发送新建 AbortController 并 abort 旧的 ✓
- L418 清理条件 `abortRef.current === sendController && currentConvRef.current === sendConvId` ✓
- 但 L453-463 stopGeneration：无条件 abort 当前 controller + 调 api.cancelConversation（按 conversation 取消，非 runId）
- clearConv 每次发送前调用（L185/289）→ 清掉历史 → 与新 Run 叠加问题

### P1-12 Activity Store 按 Run 隔离 — CONFIRMED（缺失）
- eventsByConv（L54）按 conversation；多 Run 事件混合

### P1-13 刷新丢历史 — CONFIRMED
- useStreamSend L185/289 `clearConv(sendConvId)` 每次发送前清空该会话全部事件 → 历史 Run 的 Activity 全丢

### P1-15 断线恢复 — LIKELY
- 前端 fetchEvents 支持 afterSeq（streamClient L224-237）但走 conversation 端点
- 后端 run stream 支持 Last-Event-ID（stream.ts L85-87）✓
- 但 packed 展开缺陷（P0-05）破坏恢复正确性

### P1-16 backend crash Run 恢复 — 待确认（后台审计中）

### P1-17 Electron stdout 判断 Ready — CONFIRMED
- electron/main.js L67 `m.includes('已启动') || m.includes('3000')` → tryResolve
- L96 `setTimeout(tryResolve, 15000)` 15 秒无条件 resolve

### P1-18 EADDRINUSE 直接当成功 — CONFIRMED
- main.js L71-74 端口占用 → tryResolve（未验证是不是 Aether）

### P1-19 重启无 recovery — CONFIRMED
- main.js L79-95 自动重启逻辑，无 recovery scan / interrupted 修复

### P1-20 关闭落盘 — 已实现（verify）
- will-quit L260-275：发 shutdown IPC + 2.5s kill 兜底 ✓
- backend index.ts L16-17 处理 shutdown → flushDbSync ✓
- db/client.ts 防抖 flush + flushDbSync ✓

### P1-21 titleBar/DPI — 待实机验证（NOT VERIFIED）
- frame:false + titleBarStyle:hidden + titleBarOverlay 透明（main.js L110-116）

## 待后台审计确认
- Event 深审任务（bg_8ca932f5）：P0-09/10/23/24/27 状态机与 Runtime 细节
- Mobile 深审任务（bg_8a046452）：P0-A08/18/19、RLS SQL、Android 构建、NewCommand/MessageView
