# Aether 修复计划 — Wave 分波次（并发 ≤2，失败自动重试）

> 依据：docs/audit/AUDIT-FINDINGS.md（40+ 项 CONFIRMED）
> 原则：先修正确性/安全/数据一致性（P0）→ P1 前端 → UI/文档。最小改动。
> 执行：一次并发 ≤2 个修复任务，失败用 continuation session 重试，成功换下一批。

## Wave 1 — 数据层与事件核心（串行基础）
| # | 修复项 | 文件 | 验证 |
|---|--------|------|------|
| W1-A | P0-05 packed replay：listAfter 展开后按逻辑 seq 过滤；runs/events.ts + runs/stream.ts readEvents 展开 packed 再过滤 | core/events/event-store.sqlite.ts、core/events/chunk-packer.ts、modules/runs/events.ts、modules/runs/stream.ts | RED 测试：event-replay-stream.test.ts / events.test.ts 新增 packed afterSeq 用例 |
| W1-B | P0-06 幽灵 claim：listAfter/list 过滤 __seq_claim 行（不泄漏伪事件给前端）；allocate 崩溃残留防御 | core/events/event-store.sqlite.ts、core/events/sequence-allocator.db.ts | RED 测试：sequence-allocator.db.test.ts 新增 claim 泄漏用例 |

## Wave 2 — FK 与删除一致性
| # | 修复项 | 文件 | 验证 |
|---|--------|------|------|
| W2-A | P0-21 FK onDelete：schema 全部 references 加 onDelete（CASCADE / SET NULL 按关系语义） | db/schema/index.ts | RED：migrate.test.ts 新增删除 cascade 用例 |
| W2-B | P0-21 删除路由：conversations/routes.ts 删除时按序删全表（activity_events/tasks/runs/events/workflow_runs/artifacts/messages） | modules/conversations/routes.ts | curl DELETE /api/conversations/:id → 200 且无 FK 错误 |

## Wave 3 — Model Runtime 收敛（安全）
| # | 修复项 | 文件 | 验证 |
|---|--------|------|------|
| W3-A | P0-13 bridge 解密：model-runtime-bridge.ts 的 rowToLegacyProvider 解密 apiKey（复用 lib/provider.ts 的 decrypt） | lib/model-runtime-bridge.ts | RED：model-runtime-bridge.test.ts 新增解密断言 |
| W3-B | P0-12/22 Workflow 接入 ModelRuntime：node-executors.ts 的 3 个节点改经 ProviderAdapter/ModelRuntime 调用 | modules/workflows/node-executors.ts | 单测 + typecheck |

## Wave 4 — 前端 SSE 与 Activity（正确性）
| # | 修复项 | 文件 | 验证 |
|---|--------|------|------|
| W4-A | P0-14/15 SSE Promise：parseSSEStream 返回 Promise，错误 reject；streamConversation/streamOrchestrate await 完整流 | frontend/src/api/streamClient.ts | RED：streamClient.test.ts 新增 error reject 用例 |
| W4-B | P0-08/P1-02/P0-18 activityStore：去重键 runId+seq；reasoningByAgent；agent.completed 不投影 task 完成；clearConv 只清当前 Run | frontend/src/store/activityStore.ts、useStreamSend.ts | RED：activityStore.test.ts 新增跨 Run 去重/隔离用例 |

## Wave 5 — Android/Supabase 安全
| # | 修复项 | 文件 | 验证 |
|---|--------|------|------|
| W5-A | P0-A01/A03/A05：认证重构（去除手填 service_role 主认证，引入 Supabase Auth 登录 + anon key + RLS；device ID 改进） | mobile/src/api/supabase.ts、App.tsx | typecheck + 构建 mobile |
| W5-B | P0-A06/A07/A08/A17/A22：DELETE 处理、channel 生命周期、polling 降级、幂等键、uploadFile 改私有+signed、remote_commands 补 runId | mobile/src/api/supabase.ts、MessageView.tsx、NewCommand.tsx | typecheck + 构建 mobile |

## Wave 6 — Electron 与杂项
| # | 修复项 | 文件 | 验证 |
|---|--------|------|------|
| W6-A | P1-17/18/19 Electron：health poll 判 Ready、EADDRINUSE 验证 Aether、重启后 recovery scan | electron/main.js | 手工启动验证 |
| W6-B | P0-01~04 收尾：前端 Event API 迁移到 /api/runs/:runId/events（fetchEvents 改 runId）、版本统一 2.0.0、README 修正 | frontend/src/api/streamClient.ts、package.json、README.md | typecheck + test |

## Wave 7 — 全量验证与发布
1. npm run typecheck && lint && test && build（自用版）
2. 手工 QA（curl SSE、删除 conversation、Electron 启动）
3. 同步到开源版（Diff Review + SYNC_MANIFEST.md）
4. 开源版重新验证
5. 敏感信息检查（git grep service_role/apiKey/secret）
6. Git commit（分主题）+ push GitHub + 远端验证
7. 生成四份 FINAL 审计报告

## 依赖关系
- W1-A 依赖 chunk-packer 的 unpack 函数（已有）→ 独立可做
- W2-A 必须先于 W2-B（schema 改完才能安全删除）
- W5-A 必须先于 W5-B（认证是基础）
- W4-A 与 W4-B 相互独立
- Wave 间串行（每波验证门通过再进下一波）

## 风险提示
- W5-A/B 是大改（认证架构），风险高 → 单任务串行，验证 mobile build
- W2-A 改 schema 会影响全部现有测试 → 全量 test 验证
- 每次 wave 完成后跑对应验证门，回归失败立即修
