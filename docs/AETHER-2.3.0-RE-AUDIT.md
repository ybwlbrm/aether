# Aether 2.3.0 第二轮复审报告（RE-AUDIT）

> **复审范围**：全项目最终整改与架构收口（四个统一：Loop / Retry / Prompt / Runtime）
> **复审时间**：2026-09-23
> **基线**：master / 6addef02b2b56540d579c5a3467a7df95701fc09 → 本轮整改后
> **前置文档**：`docs/AETHER-2.3.0-FINAL-AUDIT-REPORT.md`（一审）

---

## 一、统一 Loop —— 五套循环 → 单一 ExecutionLoop

| 原路径 | 整改后 | 状态 |
|--------|--------|------|
| 普通 Chat（chat-handler） | `core/runtime/execution-loop.ts` runExecutionLoop + RunLifecycleManager | ✅ 收口 |
| 超级 Chat（orchestration） | 同上（复用 execution-loop） | ✅ 收口 |
| Mobile 命令处理（command-processor） | 移除手写 `for attempt<4` Model retry；收尾统一 `runLifecycle.fail/complete` | ✅ 收口 |
| Legacy ToolLoop | 仅作迁移输入，不再作为执行入口 | ✅ 收口 |
| Core AgentRuntime | 依赖 join 逐波推进；`finalizeOnBudgetExceeded` 统一预算耗尽路径 | ✅ 收口 |

**验证**：`execution-loop.test.ts` 12/12 GREEN；backend 全量 1135 pass 无回归。

## 二、统一 Retry

| 修复点 | 文件 | 状态 |
|--------|------|------|
| sleep abort → reject AbortError（取消不再吞掉继续重试） | `core/models/retry-policy.ts` L85 | ✅ |
| delayMs(attempt) 先于 attempt+=1（等待偏移修正） | `core/models/provider-adapter.ts` L179-181 | ✅ |
| streamToComplete 无 finish → finishReason='error' + interrupted | `core/models/model-runtime.ts` L249-252 | ✅ |
| Mobile 命令处理移除手写 Model retry | `modules/sync/command-processor.ts` | ✅ |
| 同步模块 MAX_SYNC_RETRIES 属同步语义，不在 Model retry 统一范围 | `modules/sync/command-processor.ts` L213/309 | ℹ️ 保留（符合范围） |

**验证**：retry-policy 14/14 + provider-adapter 24/24 GREEN。

## 三、统一 Prompt —— 单一 Prompt Registry

| 消费方 | 接入点 | 状态 |
|--------|--------|------|
| 普通 Chat | `chat-handler.ts` getEffectivePrompt | ✅ |
| Worker 编排 | `orchestration.ts` getEffectivePrompt(agent.id) | ✅ |
| Synth（两处） | `orchestration.ts` getEffectivePrompt('sisyphus') | ✅ |
| Direct Sisyphus | `agents/index.ts` getEffectivePrompt | ✅ |
| GET/PUT prompt 路由 | `agents/index.ts` getEffectivePrompt/setPrompt | ✅ |
| 自定义提示词 | `prompt-registry.ts` getAllPrompts（替代本地双 Map） | ✅ |

**验证**：`prompt-registry.test.ts` 5/5 GREEN；本地 Map 分叉已移除。

## 四、统一 Runtime / Run 语义

| 修复点 | 状态 |
|--------|------|
| agent.stopped 替代伪造 agent.completed（§32 重复 terminal） | ✅ shared 事件类型/legacy 映射同步 |
| Run seq 接入 context.runSeqAllocator（§33） | ✅ |
| Run 创建失败 → 终止执行 + 500（§35，不再 orphan） | ✅ |
| token 累加 delta 语义防膨胀（§36） | ✅ |
| Workflow Run 终态统一走 RunLifecycleManager（P0-05） | ✅ |
| Workflow 受控并行 DAG + 条件边显式化（§41/§42） | ✅ 7/7 GREEN |

## 五、版本与文档统一（§72-75）

| 项 | 整改前 | 整改后 | 状态 |
|----|--------|--------|------|
| 根 package.json | 2.3.0 | 2.3.0 | ✅ |
| Mobile package.json | 1.0.0 | 2.3.0 | ✅ |
| Android versionName/Code | 2.3.0 / 5 | 2.3.0 / 5 | ✅ |
| README 版本徽章 | 2.2.0 | 2.3.0 | ✅ |
| README 测试数 | 978 | 1135+ | ✅ |
| README DB 迁移 | v1-v13 | v1-v15 | ✅ |
| README Setup 文件名 | 2.2.0 | 2.3.0 | ✅ |
| CHANGELOG | 无 2.3.0 | 新增完整 2.3.0 条目 | ✅ |
| /api/health AETHER_VERSION | 2.2.0 | 2.3.0 | ✅ |

## 六、未发现的新重复（本轮回流检查）

- ❌ 无新增 Model 调用绕过 ModelRuntime（grep 确认业务模块均经 provider-adapter）
- ❌ 无新增预算硬编码（30/50/128000 均收敛至 budgetFromAgentLimits）
- ❌ 无新增双循环入口（command-processor 已统一）
- ❌ 无新增本地 Prompt Map 分叉（唯一来源 prompt-registry）
- ✅ 遗留：`command-processor.ts` L213/309 的 MAX_SYNC_RETRIES 属同步重试语义，非本轮范围，保留并在 CHANGELOG 说明

## 七、结论

**二审通过**。一审清单 P0 项全部修复并验证；P1 项（Workflow 原子事务、orphan repair、并行 DAG、条件边显式化）全部落地；版本/文档统一无漂移；backend 1135 / shared 32 / frontend 62 / mobile 25 全绿基线维持。

下一步：最终全量验证（typecheck / lint / test / build / APK）→ 打包发布 v2.3.0。
