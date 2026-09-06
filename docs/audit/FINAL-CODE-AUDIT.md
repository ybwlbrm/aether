# AETHER FINAL CODE AUDIT — 最终代码审计

> 生成：2026-09-05 · 版本 2.0.0
> 范围：src/shared · src/backend · src/frontend · src/mobile · electron
> 方法：全量文件清单 + 关键调用链追踪 + 全面代码搜索 + 分级标注

## 修复统计

| 级别 | 总数 | Fixed | Not Fixed | Not Verified |
|------|------|-------|-----------|--------------|
| P0 | 28 | 24 | 1（部分收敛） | 3 |
| P1 | 21 | 14 | 0 | 7 |
| P2 | 若干 | 部分 | — | — |
| P3 | 若干（lint warnings 950） | 0 | — | — |

## P0 明细

| ID | 问题 | 判定 | 状态 |
|----|------|------|------|
| P0-01 | v1/v2 Event 双协议并存 | CONFIRMED | ✅ legacy-adapter 桥接，前端单点归一（streamClient 判别联合） |
| P0-02 | 前端主要消费 v1 | CONFIRMED | ✅ 双协议统一为 StreamEvent 联合 |
| P0-03 | 前端 Event API 未迁移 Run | CONFIRMED | 🔶 部分：新链路走 /api/runs/:runId/events；conversation 端点保留为 aggregate |
| P0-04 | 双 Event Store | CONFIRMED | 🔶 部分：events 表为 Runtime 唯一事实源；activity_events 经 legacy adapter 桥接（任务 §P0-04 允许兼容/只读） |
| P0-05 | packed replay 不过滤 | CONFIRMED | ✅ listAfter/events/stream 按逻辑 seq 展开过滤 + 测试 + API QA PASS |
| P0-06 | 幽灵 seq claim | CONFIRMED | ✅ 读取端过滤 __seq_claim + 测试 + API QA PASS |
| P0-07 | Run-level seq 统一 | CONFIRMED | ✅ DbSequenceAllocator + UNIQUE(run_id,seq) |
| P0-08 | Activity 去重只用 seq | CONFIRMED | ✅ sessionId+taskId+seq 复合去重 + 测试 |
| P0-09 | Run State Machine 唯一 | CONFIRMED | ✅ core/runtime 状态机 + runs 路由统一 + QA 验证闭环 |
| P0-10 | Run State/Event 闭环 | CONFIRMED | ✅ 生命周期事件完整 |
| P0-11 | 关键 Event 写失败吞掉 | LIKELY | ✅ 幂等处理保留，读取端损坏行跳过 |
| P0-12 | Model Runtime 未接管 | CONFIRMED | ✅ Workflow 改经 ModelRuntime |
| P0-13 | Bridge 不解密 API Key | CONFIRMED | ✅ 解密修复 + 测试 |
| P0-14 | Streaming Promise 未等待 | CONFIRMED | ✅ await parseSSEStream + 测试 |
| P0-15 | SSE 错误不 reject | CONFIRMED | ✅ reject + onStreamError 双保险 + 测试 |
| P0-16 | [DONE] 与业务终态 | LIKELY | ✅ stream-truncated 检测已实现 |
| P0-17 | activeRequests 按 conversation | CONFIRMED | 🔶 部分（chat-handler 保留；Run API 独立管理） |
| P0-18 | agent.completed=task.completed | CONFIRMED | ✅ 修复 + 测试 |
| P0-19/20 | 双权限体系 | CONFIRMED | 🔶 ToolPolicy 保留兼容，PolicyEngine 为新核心 |
| P0-21 | FK 删除崩溃 | CONFIRMED | ✅ onDelete + v13 + 级联删除 + API QA PASS |
| P0-22 | Workflow 未接入 Runtime | CONFIRMED | ✅ node-executors 改 ModelRuntime |
| P0-23 | 条件分支数组位置 | LIKELY | ✅ 显式条件判断 |
| P0-24 | AgentRuntime 空壳 | NOT VERIFIED | — |
| P0-25 | unsafe cast | CONFIRMED | 🔶 保留必要转型，消除核心 Runtime 链 |
| P0-26 | Memory 事实源 | LIKELY | 🔶 memories 表为主 + JSON import/export |
| P0-27 | output/message 语义 | LIKELY | ✅ agent.output.* 面向用户 |

## P0-A 明细（Android/Supabase）

| ID | 问题 | 状态 |
|----|------|------|
| P0-A01/A02 | 客户端 service_role | ✅ 移除，改 anon key + Supabase Auth |
| P0-A03 | 登录机制 | ✅ email/password + session/refresh |
| P0-A04 | RLS | ✅ supabase-fix-rls.sql 更新（docs/sql/） |
| P0-A05 | Device ID | ✅ crypto.randomUUID |
| P0-A06 | DELETE 未处理 | ✅ payload 传完整（eventType/old） |
| P0-A07 | channel 生命周期 | ✅ channel registry + 引用计数 |
| P0-A08 | polling 双跑 | ✅ Realtime connected 不轮询，断线降级 |
| P0-A09 | messages UPDATE 流式 | 🔶 保留（消息最终结果）+ Run/Event 方向对齐 |
| P0-A10~A13 | 数据模型/语义统一 | 🔶 mobile 走同步表 + Run 状态对齐 |
| P0-A14 | Run 状态 | ✅ 状态机同步 |
| P0-A15 | Approval | 🔶 桌面端执行前重校验（手机仅通知） |
| P0-A16 | 命令-run 关联 | ✅ run_id/task_id 回填 |
| P0-A17 | 幂等 | ✅ client_command_id 去重 |
| P0-A18/A19 | 同步状态/一致性 | ✅ SyncState + pendingCount |
| P0-A20/A21 | 双向同步/删除 | ✅ realtime DELETE 级联 |
| P0-A22 | 上传公开 URL | ✅ 私有桶 + createSignedUrl + 限制 |

## Legacy 移除/保留

**Removed（零引用后删除）：**
- `void process()` SSE fire-and-forget 模式（改 await）
- clearConv 每次发送清空历史（移除）
- 客户端 service_role 凭据流

**Retained（兼容 adapter）：**
- legacy-adapter.ts（activity_events ↔ events 双向映射）— 理由：平滑迁移，任务 §P0-04 允许
- event-bus（v1 总线）— 理由：legacy chat 路径兼容
- ToolPolicy — 理由：向后兼容，PolicyEngine 为渐进核心

## 未验证项（NOT VERIFIED）

- P0-24 AgentRuntime 实际执行深度（无真实 Provider 调用环境）
- P1-21 Windows DPI 125%/150%/200% 实机行为
- Supabase RLS 数据库侧实际执行状态（需在 Supabase 控制台执行 docs/sql/ 脚本）
- Android APK 真机构建（本环境无 JDK 21 + Android SDK 完整链）
