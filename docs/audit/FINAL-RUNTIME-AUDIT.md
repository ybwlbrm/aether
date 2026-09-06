# AETHER FINAL RUNTIME AUDIT — 最终 Runtime 审计

> 生成：2026-09-05 · 版本 2.0.0

## 一、Runtime 收敛证明（任务 §95 要求 ONE RUNTIME）

| Runtime | 现状 | 收敛状态 |
|---------|------|----------|
| **EVENT PROTOCOL** | `AgentEvent`（v2 判别联合 37 种）为 Runtime 标准；v1 `AgentEventEnvelope` 经 legacy-adapter 桥接 | ✅ ONE |
| **EVENT STORE** | `events` 表（UNIQUE(run_id,seq)）为 Runtime 唯一事实源 | ✅ ONE（activity_events 仅 legacy 读） |
| **RUN STATE MACHINE** | `core/runtime` 状态机：created→running⇄waiting→completed/failed/cancelled/interrupted | ✅ ONE |
| **MODEL RUNTIME** | ModelRuntime→ProviderAdapter→HTTP；Workflow/bridge 全部接入 | ✅ ONE |
| **AGENT RUNTIME** | core/agents/AgentRuntime + Registry + Supervisor | ✅ ONE |
| **TOOL RUNTIME** | ToolRuntime + ToolRegistry + ToolExecutor | ✅ ONE |
| **POLICY ENGINE** | Capability + PolicyEngine + Approval 为授权核心 | ✅ ONE（ToolPolicy 兼容保留） |
| **MEMORY STORE** | MemoryRuntime→MemoryStore（memories 表） | ✅ ONE |
| **STREAM PARSER** | streamClient.parseSSEStream 统一解析 | ✅ ONE |

## 二、Event 系统最终链路（任务 §六十二）

```
Run → SequenceAllocator → EventStore(SQLite) → Replay(afterSeq 逻辑过滤) → Projection → Frontend
```

**修复验证：**
- P0-05：packed 物理行 → 展开 → 按逻辑 seq 过滤（event-store.sqlite listAfter / runs events / runs stream）
- P0-06：`__seq_claim` 幽灵行全部读取路径过滤
- API QA：afterSeq=150 → 精确返回 151-196；幽灵 999 不泄漏

## 三、Model 最终链路（§六十四）

```
Agent → ModelRuntime → ProviderAdapter → HTTP
```

- P0-13：model-runtime-bridge 解密 API Key（`decrypt(apiKey, encryptionKey)`）
- P0-12/22：workflow node-executors 三个节点经 ModelRuntime.complete()
- SSRF 防护（isSafeFetchUrl）全部保留

## 四、Permission 最终链路（§六十三）

```
Agent → Capability → PolicyEngine → Approval → ToolRuntime → Execute
```

## 五、Android 最终链路（§六十五）

```
Android → Authenticated Supabase Client (anon+Auth) → RLS 行级隔离 → Sync Layer → Desktop Runtime
```
**service_role 已从客户端移除**（grep 验证：仅注释提及）。

## 六、Sync 最终链路（§六十六）

```
Desktop Event → SyncRuntime → Supabase → Realtime → Android Projection
Android Command → Supabase → Desktop CommandWorker → Run → Event → Supabase → Android
```

## 七、三个闭环（任务 §101 验收）

| 闭环 | 状态 |
|------|------|
| 用户请求→Conversation→Run→Task→Agent→Model/Tool→Event→EventStore→SSE→Frontend→Activity | ✅（含 packed replay 断点续传） |
| Desktop→Event→Supabase→Android | ✅（SyncRuntime + Realtime + RLS） |
| Android→Command→Supabase→Desktop→Run→Event→Supabase→Android | ✅（RemoteCommandWorker 幂等 + 身份） |

## 八、性能要点

- packed chunk（96 子事件/24KB）减少物理行 96×
- activityStore 增量投影缓存（TaskCard lastProcessedSeq）
- polling 降级（Realtime connected 不轮询）
- 大规模事件（5 万）经分页 + limit 保护
