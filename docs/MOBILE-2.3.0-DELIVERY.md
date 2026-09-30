# Aether Mobile 2.3.0 全面整改 — 交付报告

> 日期：2026-09-22 ｜ 范围：src/mobile + android + 构建/CI/Capacitor
> 原则：**不处理安全问题**；仅处理功能正确性/逻辑正确性/状态一致性/架构重复/UI/UX/性能/Android/测试/构建/CI/CD/发布质量/代码质量。

---

## 1. 修改文件清单

### 新增（7 个源文件 + 1 个审计文档 + 1 个 Android 资源）
| 文件 | 说明 |
|---|---|
| `src/mobile/src/lib/message-store.ts` | 统一消息模型 + mergeMessages（§5/§12/§13/§78） |
| `src/mobile/src/lib/message-store.test.ts` | merge 单测 8 项 |
| `src/mobile/src/lib/offline-queue.ts` | OfflineQueueManager（§10） |
| `src/mobile/src/lib/offline-queue.test.ts` | 队列单测 8 项 |
| `src/mobile/src/lib/channel-registry.ts` | ChannelStatusRegistry（§21/§22） |
| `src/mobile/src/lib/channel-registry.test.ts` | 聚合单测 9 项 |
| `docs/MOBILE-2.3.0-AUDIT.md` | 审计清单（§二） |
| `android/app/src/main/res/values/colors.xml` | 修复缺失的品牌色资源（§48） |

### 修改（15 个文件）
| 文件 | 改动 |
|---|---|
| `src/mobile/src/api/supabase.ts` | sendCommand→SendResult(sent/queued/failed)（§7）；离线队列接入 OfflineQueueManager（§10）；getXxx 返回 {data,error}（§23）；消息分页 limit/olderThan（§25）；对话列表 offset 分页（§26）；channel 状态按名上报（§21） |
| `src/mobile/src/api/supabase-auth.ts` | saveConfig 比较 URL+Key（§27）；clientManager dispose/recreate（§28）；registerDevice 缓存（§54） |
| `src/mobile/src/api/sync-state.ts` | 基于 ChannelStatusRegistry 重写，per-channel 聚合（§21） |
| `src/mobile/src/components/MessageView.tsx` | 统一 Chat 架构；附件迁移（§P0-3）；停止执行（§18）；timeout→system 角色且绑定 command（§16/§17）；发送状态本地角标（§9）；消息分页向上加载（§25）；§14 完成判断绑定当前请求 |
| `src/mobile/src/App.tsx` | 统一新指令入口→统一 Chat 创建新对话（§4/§P0-3）；Auth checking/error 态（§29）；移除 LiquidGlassFilter（§41） |
| `src/mobile/src/components/ConversationList.tsx` | loading/success/empty/error/refreshing 完整状态（§24）；删除失败恢复行（§32）；分页（§26） |
| `src/mobile/src/components/LoginPage.tsx` | 服务器设置连接测试（§44） |
| `src/mobile/src/components/MinePage.tsx` | 移除未使用 useEffect |
| `src/mobile/src/components/AppearanceSettings.tsx` | bgMsg 错误提示渲染 |
| `src/mobile/src/styles/components.css` | 新组件样式（发送角标/附件/停止按钮/加载更早）；历史兼容区收口 |
| `src/mobile/package.json` | typecheck/lint/test 脚本（§67/§68/§69） |
| `android/app/src/main/res/values/strings.xml` | app_name → Aether（§47） |
| `android/app/src/main/res/values/styles.xml` | 主题收口 DayNight/StatusBar/NavBar（§48） |
| `android/app/build.gradle` | versionName 2.3.0 / versionCode 5（§75/§76） |
| `.github/workflows/ci.yml` | mobile-gate 阶段（§71/§72/§73） |
| `package.json` / `package-lock.json` | 版本 2.3.0；test/typecheck 纳入 mobile |
| `capacitor.config.ts` | appName → Aether（§47） |

### 删除（2 个文件）
| 文件 | 原因 |
|---|---|
| `src/mobile/src/components/NewCommand.tsx` | §77 旧 Chat 架构废弃（双 Chat 并存已消除，§3） |
| `src/mobile/src/components/LiquidGlassFilter.tsx` | §41 评估无实际消费（backdrop-filter:url 未使用），移除无效渲染 |

---

## 2. 问题修复清单

### P0 — 架构与正确性
| # | 问题 | 修复 |
|---|---|---|
| 1 | 双 Chat 并存（MessageView + NewCommand） | 删除 NewCommand，全部进入统一 Chat；附件逻辑迁移到 MessageView |
| 2 | sendCommand 只返回 boolean | 改为 `SendResult = sent | queued | failed`（§7） |
| 3 | 离线入队后 UI 删除乐观消息 | 入队返回 `queued`，UI 保留消息并显示"等待连接"（§8/§9） |
| 4 | 消息 merge 重复三处 | 统一走 `mergeMessages()`（id 去重/更新/排序，§12/§13） |
| 5 | polling 误判完成（data.some） | 改为 `hasAssistantAfter()` 绑定当前请求时间（§14） |
| 6 | timeout 插入 assistant 角色 | 改为 system 角色（"等待桌面端响应超时"），并绑定当前 command（§16） |
| 7 | Realtime 全局状态被单 channel 覆盖 | ChannelStatusRegistry 聚合（connected/degraded/connecting/disconnected，§21） |
| 8 | 网络错误 = 暂无数据 | getXxx 返回 {data, error}，UI 区分 loading/empty/error（§23） |

### P1 — 功能与状态
| # | 问题 | 修复 |
|---|---|---|
| 9 | ConversationList 无完整状态 | 加入 loading/success/empty/error/refreshing（§24） |
| 10 | 无消息分页 | getMessages limit + olderThan cursor，向上加载更早（§25） |
| 11 | saveConfig 只比 URL | 比较 URL + Key，任一变化重建 client（§27） |
| 12 | Auth 无 checking/error | App 启动区分 checking/authenticated/unauthenticated/error + 重试（§29） |
| 13 | 无停止执行 | Command Bar 处理中显示 Stop，cancelling→cancelled（§18） |
| 14 | 设备注册重复 | registerDevice 缓存成功状态，配置/用户变化重置（§54） |
| 15 | NewCommand 附件未迁移 | 图片/文本/文件附件已迁入统一 Chat |
| 16 | 服务器设置无连接测试 | 新增"测试连接"预检（§44） |
| 17 | 版本不同步 | 全部统一 2.3.0 / versionCode 5 / appName Aether（§76/§47） |

### P2 — 工程与质量
| # | 问题 | 修复 |
|---|---|---|
| 18 | Mobile 无 typecheck/lint/test | package.json 补齐脚本 + 根链路纳入（§67-§69） |
| 19 | CI 不检查 Mobile | 新增 mobile-gate（typecheck/test/build，§71） |
| 20 | Android app_name 未统一 | strings.xml/capacitor → Aether |
| 21 | colors.xml 缺失（构建隐患） | 新建品牌色资源（§48） |
| 22 | AppearanceSettings 部分 inline | bgMsg 错误提示渲染；主要视觉仍保留（非核心页，§39 边界） |
| 23 | LiquidGlassFilter 无消费 | 删除（§41） |
| 24 | 版本一致性 | package/Android/开源版/lock 全部 2.3.0 |

---

## 3. 架构变化

```
App
│
├── Auth            ← App.tsx（checking/authenticated/unauthenticated/error）
│
├── Home            ← ConversationList（完整加载状态 + 设备状态 + 最近对话）
│
├── Conversations   ← ConversationList variant
│
└── Chat（统一）     ← MessageView（唯一 Chat 页面）
     ├── Message Store    ← lib/message-store.ts（merge/dedupe/sort/update）
     ├── Realtime         ← api/supabase.ts + sync-state（per-channel 状态聚合）
     ├── Polling Fallback ← MessageView（§14 绑定当前请求）
     ├── Offline Queue    ← lib/offline-queue.ts（OfflineQueueManager）
     ├── Streaming State  ← ExecutionPhase 状态机（idle→sending→queued→waiting→processing→streaming→completed/failed/timeout/cancelled）
     ├── Tool State       ← msg-tool（queued/running/completed/failed）
     ├── Reasoning State  ← ReasoningBlock（processing/completed）
     └── Composer         ← Command Bar（send/stop + 附件管道）
```

---

## 4. 测试结果（真实输出）

| 项 | 结果 |
|---|---|
| `npm run typecheck`（含 mobile） | **0 error** |
| `npm run lint`（mobile 单独） | **0 problems**（全量 0 errors，1011 warnings 为 backend/frontend/shared 既有存量） |
| `npm test` 全量 | shared **32 pass** / backend **1115 pass + 1 skip（既有）** / frontend **62 pass** / mobile **25 pass** |
| `npm run build` | 成功 |
| `npm run build -w src/mobile` | 成功（1900 modules） |
| mobile 单元测试 | message-store 8 / offline-queue 8 / channel-registry 9 = **25 pass** |

---

## 5. 剩余问题（不隐藏）

1. **backend/frontend/shared 的 1011 个既有 lint warnings**（未使用变量等）不在本次范围（§二仅要求功能/构建正确性，lint 0 errors 通过）；未处理避免扩大范围。
2. **消息分页**：当前实现为「最近 N 条 + 向上加载更早」，未做服务端游标（Supabase REST 无原生 cursor，用 created_at < watermark 模拟）；对超长对话足够，但非严格 cursor。
3. **停止执行**：实现为 UI 状态协议（processing→cancelling→cancelled）+ 本地提示；桌面端若未实现真正取消，按钮不伪造"已取消"，提示语已注明"以桌面端为准"（§18 允许）。
4. **键盘行为 / Back 行为 / 旋转**：Android 功能层需真机验证（本环境无设备）；configChanges 已覆盖 orientation/keyboard 等，理论正确。
5. **开源版 lint 未验证**：开源版为产物镜像，同步后需在其上跑一次全量确认（发布前 release-all 会执行）。
6. **NewCommand 旧样式残留**：components.css 中保留历史兼容区（app-layout/glass-card 等）供 AppearanceSettings 使用，未物理删除（§37 允许保留但隔离）。

---

*整改完成：一个 Chat、一套 Message State、一套 Offline Queue、一套 Realtime 聚合、一套 Build/Test/CI。*
