# Aether 第三轮全维度审计报告（2026-09-04 第三次独立审计）

> 项目：Aether (D:\PersonalAICommandCenter) — 本地优先 AI 工作操作系统
> 审计日期：2026-09-04（第三轮，前两轮已完成 253 项修复并验收 92/100）
> 审计方式：5 路并行专项代理（安全/后端质量/前端质量/UI·UX/打包链路）+ 运行时门禁实测
> 本轮**只审计，未修改任何代码**

---

## 0. 运行时门禁基线（实测，非推断）

| 项 | 命令 | 结果 |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ PASS（shared/backend/frontend 三端 0 errors） |
| Lint | `npm run lint` | ⚠️ 0 errors / **908 warnings**（no-explicit-any + no-unused-vars 预存在） |
| Build | `npm run build` | ✅ PASS（1m29s） |
| Test | `npm test` | ✅ shared 9/9 · backend 116 pass/1 skip/0 fail · frontend 37/37（合计 162 pass） |
| 生产启动 | `NODE_ENV=production node dist/index.js` | ✅ health 200 · **/docs 404**（Swagger 生产不注册实测确认） |
| 认证 | `/api/terminal/execute` | ✅ 无 token 401 · 错误 token 401 · 有效 token 200 `{"output":"hello"}` |
| stderr | smoke_stderr | 空（无运行时错误） |

**结论：门禁全 PASS，无 FAIL 项，与前两轮基线一致。**

---

## A. 项目总体评分（第三轮）

```text
安全：        96/100   （核心 13 项 P0 修复全部验证有效；3 处边缘遗漏 + 纵深防御建议）
代码质量：    71/100   （后端 71；前端 5/10 DRY、双组件库、200+ 硬编码色）
架构：        88/100   （前轮拆分有效；残留 903 行 command-processor + 双组件库）
功能完整度：  90/100   （主要功能可用；部分页面三态/响应式仍缺）
逻辑可靠性：  82/100   （markDirty 双定时器竞态、sync 竞态、前端双重轮询）
稳定性：      90/100   （162 测试全绿、启动冒烟通过）
性能：        85/100   （前端双重轮询产生 2x 请求、mergeSignals 监听器泄漏）
UI 一致性：  78/100   （Token 体系落地，但 200+ 硬编码色 + 双组件库并存）
UX：          84/100   （三态基本齐全；9/13 页面移动端断点缺失、a11y 缺口）
视觉审美：    82/100   （主题切换可用；gradient/code-block 固定色、glass 变量不全）
可维护性：    83/100   （大文件拆分大部分落地；Setup.exe 打包链路缺失）

总评分：      85/100   （前两轮 92 基线保持；本轮新增发现聚焦"最后一公里"）
```

---

## B. 问题总数（第三轮新发现，去重后）

```text
P0：5
P1：24
P2：31
P3：12
合计：72
```

> 说明：前两轮 253 项中 P0/P1 100% 修复已验证保持有效（本报告第 1 节逐项确认）。本轮 72 项为**第三轮独立审计新发现**，主要集中于：打包链路（Setup 生成缺失/APK 无签名/版本不一致）、前端双重轮询与竞态、后端 markDirty 竞态与静默 catch、UI 硬编码色与响应式断点。

---

## C. 问题详细清单

### C-0 P0（5 项）

| ID | 类别 | 文件:位置 | 问题 | 原因 | 影响 | 修复方案 |
|---|---|---|---|---|---|---|
| BLD-03 | 打包 | build/build-exe.js:217-224 | **Setup.exe（NSIS 安装包）生成链路完全缺失**——当前仅产出便携版 `dist_exe/app/Aether.exe`，`electron-builder.yml` 从未被调用 | build-exe.js 用 @electron/packager 手动组装，无 NSIS 步骤 | 用户要求"重新打包 setup"无法满足；分发只能用便携版 | build-exe.js 末尾调用 electron-builder 生成 NSIS |
| BLD-09 | 打包 | android/app/build.gradle | **APK 无签名配置**（无 keystore、无 signingConfig） | 从未配置签名 | 产出的 release APK 为 unsigned，无法直接安装 | 生成 keystore + signingConfig（或 debug 签名兜底） |
| FE-DUP-01 | 重复执行 | CodingHome.tsx:455-534 + useMessagePolling.ts:190-220 | **双重消息轮询**：CodingHome 内联 1s 轮询 + useMessagePolling 2s 轮询并存 | Chat 用 hook、CodingHome 内联实现 | 同一会话每秒 1.5 次请求，2x 服务端压力、合并竞态 | CodingHome 统一迁移到 useMessagePolling |
| FE-LEAK-01 | 泄漏 | api/client.ts:86-116 | **mergeSignals 监听器泄漏**：polyfill 路径 addEventListener 无正常完成清理 | once:true 仅 abort 时移除 | 长生命周期 signal 每请求泄漏 2 监听器 | 改用 AbortSignal.any() 或显式 removeEventListener |
| BE-RC-01 | 竞态 | db/client.ts:43-51 | **markDirty 双定时器清理不原子**：flushTimer/maxLatencyTimer 可能被并发清除 | 并发 markDirty 竞态 | 5s 兜底失效、数据延迟落盘 | 单例防抖 + maxLatency 合并或 Mutex |

### C-1 P1（24 项，分组紧凑列出）

**安全（3）**：NEW-001 `lib/search-tools/web-fetch.ts:49` redirect:'follow' 可能绕过 SSRF（改 manual+逐跳校验）；NEW-002 3 个高风险端点（workflows/:id/run、mcp/servers/:id/test、testing/run）缺 Bearer 认证（加入 sensitivePaths）；NEW-003 5 处直接 fetch(provider.baseUrl) 无防御性校验（compaction.ts:59 / command-processor.ts:419 / agents/index.ts:216 / monitoring/index.ts:108 / mcp-client.ts:94）。

**后端逻辑（7）**：BE-RC-02/03 sync processingCommandIds 重连闭包丢失 + 重试 effectiveConvId 竞态（可重复处理命令/建重复对话）；BE-UA-01/02 sync-config.ts:175-177,216-218 启动全量同步 fire-and-forget（数据丢失风险）；BE-SC-01/02 orchestration.ts:196,554-568 关键路径 SilentCatch（故障无日志）；BE-V-01 fetchWithRetry 仍从 conversations 反向导出（分层倒置）；BE-RL-01/02 polling-fallback/realtime 定时器未显式清理（泄漏）。

**前端逻辑（7）**：FE-RACE-01 消息/活动轮询共享 pollReqIdRef 相互干扰；FE-RACE-02 handleSelectConv 无请求守卫（快速切会话旧响应覆盖）；FE-DUP-02 远程命令双处理（Layout 事件 + CodingHome ?remote= 检测）；FE-DUP-03 初始化三 effect 双加载；FE-DUP-04 新建对话双路径；FE-ERR-01 ApiError 无类型分类；FE-ERR-06 轮询失败静默吞错。

**UI/UX（4）**：UI-T-01~33 硬编码色值 200+ 处（34 文件，P0 组内 33 项合并为本 P1 组：gradient-shimmer 12 组渐变、McpSettings 12 处、Library 9 处等）；UI-R-01~14 9/13 页面无 sm 断点；UI-A-01~04 图标按钮缺 aria-label 30+ 处、Tab 无方向键、下拉无键盘；UI-D-01~09 双组件库并存（components.css class 版 vs ui/ React 版）。

**打包（3）**：BLD-01/02 构建顺序与增量残留（打包不复现）；BLD-08/12 版本三处不一致（package.json 1.0.0 vs android 1.0 vs builder 无 version）；BLD-10/11 mobile 不在 workspaces + 无 APK 打包脚本。

### C-2 P2（31 项，分组）

- **后端魔法数字 10**：MN-01~10（RETRY_DELAYS、熔断阈值、MAX_HISTORY、MAX_TOOL_CALLS 双定义、maxTurns 500/30 三处、截断 3000/50000、SSE 60s、审批 60s）
- **前端死代码/重复 9**：DEAD-01~09（ai-elements 组件库未用 7 文件、双代码块、双 Modal、双 Tabs、console.log 残留 7 处、注释残留）
- **后端结构/错误 6**：V-02~04 大文件拆分、SC-03~06 静默 catch、EH-02/03 错误处理、DC-01~06 死代码
- **后端资源 4**：RL-03~08 定时器/流/DB 清理
- **UI 其他 2**：STATE-01 uiMode/mode 命名混淆、S-06/07 主题 glass 变量不一致

### C-3 P3（12 项）

NEW-004 Electron 43 EOL（P2 降级）、NEW-005 ssrf.ts 重复、DEAD-10/11 未用导入、OTH-01~03 any 收窄、OTH-06 confirm-dialog 焦点陷阱、BLD-13~19 脚本兼容/路径硬编码、SC 日志增强等。

---

## D. 重复问题清单（第三轮重点）

| 重复 | 位置 | 影响 |
|---|---|---|
| 消息轮询 1s+2s 并存 | CodingHome 内联 + useMessagePolling | 双重请求 + 合并竞态（P0） |
| 远程命令处理两套 | Layout 事件分发 + CodingHome ?remote= 检测 | 同一命令可能双触发 |
| 双组件库（CSS class vs React） | components.css vs ui/*.tsx | 9 类组件双实现 |
| MAX_TOOL_CALLS=50 双定义 | conversations/tool-loop.ts + agents/tool-loop.ts | 改一处漏一处 |
| maxTurns 500/30 三处 | chat-handler / agents tool-loop / command-processor | 同上 |
| ai-elements 组件库 7 文件未接入 | components/ai-elements/ | 死代码 + 包体积 |

---

## E. 功能缺失清单

| 功能 | 状态 | 缺失 | 优先级 |
|---|---|---|---|
| **Setup.exe 安装包** | ❌ 完全缺失 | NSIS 生成链路（electron-builder 未接线） | P0 |
| **APK 签名** | ❌ 无签名 | keystore/signingConfig | P0 |
| **一键打包脚本** | ❌ 无 | build:all 串联 EXE+APK | P1 |
| 统一版本源 | ❌ 三处不一致 | 根 package.json 单一真相源 | P1 |
| 移动端响应式 | ⚠️ 部分 | 9/13 页面无 sm 断点 | P1 |
| a11y 键盘导航 | ⚠️ 部分 | Tab 方向键、下拉键盘、aria-label 批量 | P1 |

---

## F. UI/UX 问题清单

**一致性**：硬编码色 200+ 处（34 文件）、双组件库 9 类、圆角 8 种、阴影 10+ 种、动画 duration 12 种。
**布局**：9/13 页面缺 sm 断点、Chat/CodingHome 侧栏移动端无抽屉、base.css overflow-x:hidden 掩盖横向滚动。
**可访问性**：图标按钮 30+ 无 aria-label、Tab 无方向键、confirm-dialog 无焦点恢复、消息列表无 aria-atomic。
**美学**：code-block 固定深色（4 套浅色主题异常）、gradient-shimmer 12 组硬编码渐变、shadcn/geist glass 变量不透明、origin/dark-minimal 缺 --on-accent。

---

## G. 架构问题

| 问题 | 影响 | 推荐 |
|---|---|---|
| fetchWithRetry 反向导出（conversations→外部） | 分层倒置 | 统一从 lib/fetch-retry.ts 导入 |
| 双组件库并存 | 维护地狱、行为不一致 | 废弃 components.css 组件类，全站用 ui/ |
| mobile 脱离 workspaces | 依赖漂移、构建遗漏 | 纳入 workspaces + build:apk 脚本 |
| build-exe.js 手动组装 vs electron-builder.yml | Setup 缺失、native 模块脆弱 | 统一 electron-builder |

---

## H. 修复路线图

```text
Wave 1（P0 打包 2 项 + 安全 P1 3 项 + 后端竞态 P0 1 项 + 前端 P0 2 项）
  ├─ BLD-03 Setup.exe 生成链路 + BLD-09 APK 签名
  ├─ NEW-001/002/003 SSRF redirect + 认证端点 + fetch 防御
  ├─ BE-RC-01 markDirty 竞态
  └─ FE-DUP-01 双重轮询 + FE-LEAK-01 mergeSignals

Wave 2（P1 后端逻辑 7 项 + 前端逻辑 7 项）
  ├─ sync 竞态/未 await/静默 catch/反向导出/定时器
  └─ 轮询守卫分离/会话切换守卫/远程命令去重/ApiError

Wave 3（P1 UI 4 组 + 打包 3 项）
  ├─ 硬编码色→token、响应式断点、a11y、双组件库统一
  └─ 版本统一、mobile workspaces、build:all

Wave 4（P2/P3 批量）
  ├─ 魔法数字、死代码、console 清理、错误处理增强

每 Wave 后：typecheck + lint + build + test + 启动冒烟 → 复审
```

---

## 附：误报/降级记录

| 原发现 | 处理 | 理由 |
|---|---|---|
| /docs 200（首测） | 降级 | 未设 NODE_ENV=production，Swagger 开发模式注册属正常；生产模式实测 404 |
| terminal 403（首测） | 降级 | 缺 CSRF header 先于认证校验返回 403，属预期；带 header 后 401→401→200 |
| Electron 43 EOL | P3 | 升级风险大且本机 43.3.0 运行正常，列入后续版本规划 |
