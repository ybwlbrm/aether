# Aether Mobile 2.3.0 全面整改 — 审计清单

> 日期：2026-09-22 ｜ 范围：src/mobile + android + 构建/CI/Capacitor 配置
> 原则：**不处理安全问题**；只处理功能正确性 / 逻辑正确性 / 状态一致性 / 架构重复 / UI/UX / 性能 / Android / 测试 / 构建 / CI/CD / 发布质量 / 代码质量。

---

## 一、审计范围（已通读）

| 层 | 文件 | 结论 |
|---|---|---|
| 页面 | `App.tsx`（271） | 7 页路由；启动流无 checking/error；背景恢复操纵多个 DOM |
| 页面 | `LoginPage.tsx`（198） | 品牌 Mark + Grouped Input 已达标；服务器设置无"连接测试" |
| 页面 | `ConversationList.tsx`（243） | 无 error/loading 区分；删除无失败恢复；分页固定 50 |
| 页面 | `MessageView.tsx`（665） | 新 Chat 架构；merge 重复；polling 误判；timeout 角色错误；无停止执行 |
| 页面 | `NewCommand.tsx`（479） | **旧 Chat 架构**：独立 renderMarkdown/renderInline、独立 timeout/sending/订阅；附件逻辑有价值 |
| 页面 | `AppearanceSettings.tsx`（284） | 大量 inline style；多套 DOM 背景操作；glass-card 旧样式 |
| 页面 | `MinePage.tsx`（69） | 达标（去玻璃） |
| API | `supabase.ts`（706） | sendCommand 返回 boolean；离线队列内嵌业务函数；getXxx catch 吞错返回 []；无分页参数 |
| API | `supabase-auth.ts`（275） | saveConfig 仅比 URL 不比 Key；getClient 无 dispose；registerDevice 无缓存 |
| API | `supabase-errors.ts`（64） | 错误分类完善（达标） |
| API | `sync-state.ts`（117） | 单一全局 syncStatusValue 被多 channel 直接覆盖；无 per-channel 聚合 |
| UI 基础 | `tokens.css`/`glass.css`/`components.css` | tokens/glass 达标；components.css 新样式 + 历史兼容区并存 |
| Android | `strings.xml`/`styles.xml`/`AndroidManifest.xml`/`build.gradle` | app_name=Personal AI Command Center；version 2.2.0/versionCode 4；theme 基础 |
| CI | `.github/workflows/ci.yml` | 仅 shared/backend/frontend；**无 mobile**；frontend test 有 rollup optional 依赖隐患 |
| 构建 | `package.json`/`vite.config.ts`/`tsconfig.json` | mobile 脚本仅 dev/build/preview；release-all.js 版本绑定 |

---

## 二、问题清单（按优先级）

### P0 — 架构与正确性

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 1 | 双 Chat 并存（MessageView + NewCommand） | `App.tsx`/两个组件 | 两套消息/超时/订阅/Markdown，逻辑漂移 |
| 2 | `sendCommand()` 只返回 boolean | `supabase.ts:263` | 无法区分 sent/queued/failed |
| 3 | 离线入队后 UI 删除乐观消息 | `MessageView.tsx:345-350` | 用户消息凭空消失 |
| 4 | 消息 merge 算法重复三处 | `MessageView.tsx:196-276` | Realtime+polling 竞态丢消息/重复 |
| 5 | polling 完成判断 `data.some(assistant)` | `MessageView.tsx:268` | 历史 assistant 导致误判完成 |
| 6 | timeout 插入 `role:'assistant'` | `MessageView.tsx:357-362` | 超时伪装成 AI 回复 |
| 7 | Realtime 全局状态被单 channel 覆盖 | `sync-state.ts:88-105` | 一个 channel 断开→全局 disconnected |
| 8 | 网络错误 = 暂无数据（catch 返回 []） | `supabase.ts:228/250` | 无法区分 loading/empty/error |

### P1 — 功能与状态

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 9 | ConversationList 无 loading/error 态 | `ConversationList.tsx` | 网络失败显示"暂无对话" |
| 10 | 无消息分页（select * 全量） | `supabase.ts:236-244` | 长对话卡顿/内存高 |
| 11 | `saveConfig` 只比 URL 不比 Key | `supabase-auth.ts:82` | Key 变更后旧 client 残留 |
| 12 | Auth 启动无 checking/error | `App.tsx:79-99` | 网络异常伪装未登录 |
| 13 | 无"停止执行"能力 | `MessageView.tsx` | 无法取消长任务 |
| 14 | 设备注册无缓存（每次命令重复） | `supabase.ts:263` | 重复网络请求 |
| 15 | NewCommand 附件逻辑（图片/文本/文件）未迁移 | `NewCommand.tsx:307-334` | 统一 Chat 后丢失附件能力 |
| 16 | 服务器设置无"连接测试" | `LoginPage.tsx` | 无法预检连通性 |
| 17 | 版本不同步（package/Android/mobile） | 多文件 | Release 混乱 |

### P2 — 工程与质量

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 18 | Mobile 无 typecheck/lint/test 脚本 | `src/mobile/package.json` | 无法独立验证 |
| 19 | CI 不检查 Mobile | `ci.yml` | Mobile 类型错误不可见 |
| 20 | Android app_name 未统一为 Aether | `strings.xml` | 品牌不一致 |
| 21 | components.css 新旧样式并存 | `components.css` | 旧规则可能覆盖新 UI |
| 22 | AppearanceSettings 大量 inline style | `AppearanceSettings.tsx` | 样式不一致 |
| 23 | LiquidGlassFilter 无实际消费 | `App.tsx`/`LiquidGlassFilter.tsx` | 无效渲染开销 |
| 24 | gradlew.bat 偏 Windows | `build/release-all.js` | 跨平台缺失 |
| 25 | 背景状态多 DOM 操纵 | `App.tsx:40-59`/`AppearanceSettings` | 状态分散 |

---

## 三、整改波次

```
Wave A  API 层：SendResult 语义 / OfflineQueueManager / mergeMessages / ChannelStatusRegistry / clientManager / 分页 API / 错误状态
Wave B  Chat 统一：MessageView 改造 / 删除 NewCommand / 迁移附件 / Home 新指令→统一 Chat / 停止执行 / timeout 修复 / 发送状态 UI
Wave C  状态与生命周期：Auth checking / ConversationList 错误态 / 消息分页 UI / 设备注册缓存 / 连接测试
Wave D  Android + 构建：app_name / version 2.3.0 / theme 收口 / mobile scripts / CI / release 版本同步
Wave E  CSS 与质量：CSS 收口 / inline style 清理 / LiquidGlassFilter 评估
Wave F  测试验证：单元测试 / 构建 / 最终回归
```
