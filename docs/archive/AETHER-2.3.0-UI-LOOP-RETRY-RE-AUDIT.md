# Aether 2.3.0 UI + Loop + Retry 二次审计报告（RE-AUDIT）

> 阶段：Phase 12（二次审计，只读不改）
> 日期：2026-09-26
> 基线文档：`docs/AETHER-2.3.0-UI-LOOP-RETRY-AUDIT.md`（2026-09-25）
> 范围：backend / frontend / mobile / shared / docs / build / CI
> 方法：4 个并行 explore 代理逐项读取源码取证 + 人工复核 4 条验证命令实测输出 + git 变更集核对
> 说明：本报告对基线审计的每一条问题编号给出「是否修复 / 证据 / 测试 / 状态」四要素。证据一律给出文件与行号；测试一律给出测试文件与测试名；无对应测试者明确写「无测试」；未开展核查者明确写「未执行核查」，不默认通过。

---

## 零、基线数据一致性说明（必读）

基线审计文档开头的统计表声明 **P0=24 / P1=37 / P2=18 / P3=3，合计 82 条**；但该文档正文 A–S 各节的逐行严重度标注实际合计 **177 条**（P0=66 / P1=86 / P2=23 / P3=2）。

两者不一致。本二次审计以**正文逐行标注的 177 条编号**为追踪对象全集（因为只有逐行编号可被逐条验证），并在下方同时给出按「基线声明的 82 条口径」的对照说明。此处不做调和，仅如实记录。

本报告所有计数均由脚本对 177 行追踪表机器统计得出，未经手工估算。

---

## 一、本轮实测验证命令输出

### 1.1 类型检查

```
> aether@2.3.0 typecheck
> tsc --noEmit -p src/shared && tsc --noEmit --composite false -p src/backend && tsc --noEmit --composite false -p src/frontend && tsc --noEmit --composite false -p src/mobile
```

结果：**通过，四个 workspace 零错误**（tsconfig.base.json 与 src/mobile/tsconfig.json 均为 `strict: true`）。

### 1.2 后端测试（先构建，再执行）

```
> @pacc/backend@1.0.0 build
> tsc

# node --test --experimental-test-module-mocks "dist/**/*.test.js"
# tests 1258
# suites 276
# pass 1257
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 91906.5095
```

结果：**1257 通过 / 0 失败 / 1 跳过 / 276 suites**。

注意：后端测试执行的是 `dist/**/*.test.js`，即**必须先 `npm run build -w src/backend`**，产物过旧则测试结果不反映当前源码。首次以 `cd src/backend && npm run build -w src/backend` 执行时报 `npm error No workspaces found`（workspace 参数须在仓库根执行），已改在根目录构建后重跑，上列为最终结果。

### 1.3 前端测试

```
> aether@2.3.0 test -w src/frontend
> vitest run

 Test Files  11 passed (11)
      Tests  87 passed (87)
   Duration  11.18s
```

结果：**11 个测试文件 / 87 个测试全部通过**。

采集过程记录到一次不一致，且**原因已查明**：首次运行时汇总为 **9 files / 80 tests**，随后连续两次复跑均为 **11 files / 87 tests**。差异恰为 2 文件 7 测试 —— `routes/CodingHome.test.tsx`（4 test，落盘 09:01:32）与 `components/conversation/message-bubble.test.ts`（3 test）是在本轮审计进行期间新增到工作区的未跟踪文件，首次运行时 vitest 尚未采集到。故此差异**不是**测试不稳定，而是审计期间代码正在被修改（详见 1.7 与第七章第 6 条）。

逐文件测试数（`vitest run --reporter=basic` 实测）：

| 测试文件 | 测试数 |
|---|---|
| `src/store/activityStore.test.ts` | 29 |
| `src/lib/tool-models.test.ts` | 18 |
| `src/api/streamClient.test.ts` | 12 |
| `src/lib/notification-center.test.ts` | 11 |
| `src/routes/CodingHome.test.tsx` | 4 |
| `src/hooks/useStreamSend.test.ts` | 3 |
| `src/components/conversation/message-bubble.test.ts` | 3 |
| `src/lib/utils.test.ts` | 3 |
| `src/routes/Chat.test.tsx` | 2 |
| `src/components/ui/status-pill.test.tsx` | 1 |
| `src/components/ui/page-header.test.tsx` | 1 |
| **合计** | **87** |

### 1.4 移动端测试

```
# tests 39
# suites 0
# pass 39
# fail 0
```

结果：**39 通过 / 0 失败**（5 个文件：message-completion 6、message-store 8、remote-command 8、channel-registry 9、offline-queue 8）。

### 1.5 共享包测试

```
# tests 33
# suites 8
# pass 33
# fail 0
```

### 1.6 四包合计

| 包 | 测试数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| backend | 1258 | 1257 | 0 | 1 |
| frontend | 87 | 87 | 0 | 0 |
| mobile | 39 | 39 | 0 | 0 |
| shared | 33 | 33 | 0 | 0 |
| **合计** | **1417** | **1416** | **0** | **1** |

### 1.7 git 变更集

审计开始时（08:49）工作区为干净状态：

```
$ git status --short
（空输出 —— 工作区干净，无未提交改动）

$ git log --oneline -6
d5fe152 release: Aether 2.3.0
3ef12ee fix: Oracle 复审 P1-10（#23）工具箱大文件串行读取+50MB限制（防内存峰值）
8fcdd93 fix: Oracle 复审修复 - 视频失败语义（前端报错+后端failed）/Base64 二进制兜底/魔数验证放宽（ftyp 64字节）
af60e5e fix: Aether 专项审计修复 - Level3 命令放行/默认工作目录/视频失败语义/工具箱输入校验/权限双标准/审批幂等/UI 间距（29 项）
7c24a7d feat: Aether 2.3.0+ 全项目最终整改 - 通知幂等/ExecutionLoop 生产收口/ToolLoop 删除/Sisyphus 收口/DAG 修复/Retry 统一/EventStore 逻辑事件/Prompt 持久化/Mobile 真取消/CI 修复
cdb8826 refactor: 统一预算收口 - 生产主链路全部接入 budgetFromAgentLimits（清除 30/50 硬编码）

$ git diff --stat HEAD~5 HEAD
130 files changed, 32732 insertions(+), 22123 deletions(-)
```

**已提交部分**（`HEAD~5..HEAD`）共修改 130 个文件。新增关键文件：`core/runtime/execution-completion.ts`、`execution-retry.ts`、`execution-checkpoint.ts`、`core/errors/retry-error.ts`、`modules/sync/command-cancellation.ts`、`command-outcome.ts`、`remote-command-status.ts`、`remote-command-terminal.ts`、`mobile/src/lib/remote-command.ts`、`message-store.ts`；前端新增 `components/ui/` 下 `page-shell.tsx`、`page-header.tsx`、`section.tsx`、`panel.tsx`、`stack.tsx`、`inline.tsx`、`status-pill.tsx`、`spinner.tsx`、`empty-state.tsx`、`error-state.tsx`、`loading-state.tsx`。

**审计期间新增的未提交改动（重要）**。审计执行过程中工作区被继续修改，本报告完成时的状态为：

```
$ git status --short
 M src/backend/src/core/runtime/execution-checkpoint.test.ts
 M src/backend/src/core/runtime/execution-checkpoint.ts
 M src/backend/src/core/runtime/execution-loop.test.ts
 M src/backend/src/core/runtime/execution-loop.ts
 M src/frontend/src/routes/Chat.tsx
 M src/frontend/src/routes/CodingHome.tsx
?? docs/AETHER-2.3.0-UI-LOOP-RETRY-RE-AUDIT.md
?? src/frontend/src/components/conversation/
?? src/frontend/src/routes/CodingHome.test.tsx

$ git diff --stat
 execution-checkpoint.test.ts    |  28 +
 execution-checkpoint.ts        |  31 +
 execution-loop.test.ts         | 196 ++-
 execution-loop.ts              | 209 ++-
 routes/Chat.tsx                |  97 +-
 routes/CodingHome.tsx          | 1384 +++++++++-----------
 6 files changed, 1079 insertions(+), 866 deletions(-)
```

文件落盘时间线（实测）：

| 时间 | 事件 |
|---|---|
| 08:49 | 审计开始，工作区干净 |
| 08:52:08 | `core/runtime/execution-checkpoint.ts` 修改（270 → **311 行**） |
| 08:54:09 | 新增 `components/conversation/stream-failure.tsx` |
| 08:54:37 | `routes/Chat.tsx` 修改（**689 行**，与取证时一致） |
| 09:01:32 | 新增 `routes/CodingHome.test.tsx`（4 test） |
| 09:02:01 | `core/runtime/execution-loop.ts` 修改（815 → **882 行**） |
| 09:07:45 | `routes/CodingHome.tsx` 大幅重写（**1110 行**，`git diff` 显示 1384 行变更） |
| 09:17:33 | 本报告写入 |

新增未跟踪源文件：`components/conversation/activity-stream.tsx`、`index.ts`、`message-bubble.tsx`、`message-bubble.test.ts`、`stream-failure.tsx`、`routes/CodingHome.test.tsx`。

对本报告效力的影响：四个取证代理的结束时间分别为 08:53、08:56、08:59、09:04。**后端 Loop/Retry/ToolCall 代理、Event/State/Perf 代理、Mobile/Workflow/API 代理所引用的文件均在各自取证时点已稳定**（`activityStore.ts`、`ActivityStream.tsx`、`api/client.ts`、`streamClient.ts`、mobile 与 workflows 全模块均未在审计期间被改动），其证据为当前状态。**仅 `CodingHome.tsx` 与 `execution-loop.ts`、`execution-checkpoint.ts` 的行数在取证后发生变化**，本报告已按 1.7 时间线更新这三处的行数为当前值（`CodingHome.tsx` 1110 行、`execution-loop.ts` 882 行、`execution-checkpoint.ts` 311 行）。所有其他文件行号均为当前状态。

**基线审计涉及的下列文件在已提交的 130 个变更文件与审计期间的未提交改动中均完全未出现**，构成「未修复」的直接旁证：`store/activityStore.ts`、`components/activity/ActivityStream.tsx`、`api/client.ts`、`api/streamClient.ts`、`core/runtime/lifecycle.ts`、`core/runtime/cancellation.ts`、`core/runtime/runtime-context.ts`、`core/runtime/run-context.ts`、`core/runtime/index.ts`、`core/tools/tool-timeout.ts`、`core/tools/tool-registry.ts`、`core/tools/tool-runtime.ts`、`lib/production-tool-executor.ts`、`lib/fetch-retry.ts`、`components/Sidebar.tsx`、`routes/Browser.tsx`、`routes/Library.tsx`、`routes/Media/MediaGallery.tsx`、`routes/Workflows/WorkflowEditor.tsx`、`build/release-all.js`、`build/build-exe.js`、`.github/workflows/ci.yml`。

### 1.8 其他实测

| 项 | 实测值 |
|---|---|
| `any` 类型绑定 | backend 147 / frontend 218 / mobile 0 / shared 0，合计 365；frontend 前五：`api/client.ts` 31、`routes/CodingHome.tsx` 17、`routes/Settings.tsx` 12、`routes/Toolbox.tsx` 7、`routes/Chat.tsx` 6 |
| EXE 产物 | `dist_electron/Aether Setup 2.3.0.exe` 227,227,066 字节，2026-09-26 00:09 |
| APK 产物 | `android/app/build/outputs/apk/release/app-release.apk` 3,386,706 字节，2026-09-26 08:32 |
| `src/mobile/dist` | 存在（Vite Web 构建，2026-09-26 08:31），非 APK |
| git remote | **本仓库未配置 remote**，`gh release list` 返回 `no git remotes found`，本地 tag 为空（`git describe --tags` → `fatal: No names found`） |
| README 声明 | 版本徽章 2.3.0、测试徽章 `1135+`、DB 迁移 `v1-v15` |
| `docs/SYNC_MANIFEST.md` 声明 | 第 17 行称审计文档「已于 2026-09-18 删除，不再跟踪」；第 37 行称 `test ✅ (886)`；docs 实际存在 4 份 `AETHER*.md` |

---

## 二、A–S 全部 177 项追踪表

状态定义：
- **已修复**：代码层已解决，且有对应测试或可复核的确定证据。
- **部分修复**：核心机制已落地但仍存在缺口、旁路或未接线。
- **未修复**：基线描述的问题在当前代码中依然成立。
- **未执行核查**：本轮未对该项开展源码取证，既不记为已修复也不记为未修复。

### A. UI 总体（UI-01 ~ UI-08）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| UI-01 | P1 | 否 | `src/frontend/src/styles/globals.css:38` 仍为 `height: 36px`，与基线 `:34-39` 一致 | 无测试 | 未修复 |
| UI-02 | P1 | 部分 | 共享 `components/ui/page-header.tsx` 已被 `routes/Chat.tsx:4-10`、`routes/CodingHome.tsx:7` 引用；其余 19 个 route 仍引用旧 `components/PageHeader.tsx`（AgentSettings:5 / Browser:3 / Documents:3 / Knowledge:3 / Library:5 / McpSettings:2 / Media:4 / Monitoring:2 / Projects:3 / Providers:5 / Search:3 / SelfCheck:2 / Settings:6 / Terminal:4 / Toolbox:3 / Vault:3 / Toolbox/ToolboxList:2 / Workflows/WorkflowEditor:3 / Workflows/WorkflowList:3） | `components/ui/page-header.test.tsx` 1 test | 部分修复 |
| UI-03 | P1 | 否 | `glass-card` 实测 **38 个 `.tsx` 文件 / 109 处**（基线为 37 文件 / 97 处），覆盖面扩大 | 无测试 | 未修复 |
| UI-04 | P1 | 部分 | `styles/components.css` 全文仅剩 3 处 `will-change`（`:28` `.glass-card`、`:106` `.sidebar-glass`、`:118` `.glass-menu`），基线称约 97 个 glass-card 永久 will-change；但 `components.css:28` `will-change: transform` 与 `:96` `animation: glass-shimmer 8s ease-in-out infinite` 仍在 `.glass-card` 默认生效 | 无测试 | 部分修复 |
| UI-05 | P2 | 部分 | `styles/tokens.css:145-167` 建立 `--radius-xs/sm/md/lg/xl/pill = 6/8/12/16/20/9999px`；`base.css:284-291` 仅以 `var(--radius-source-*)` 桥接，raw 值已清零；但 `--card-radius` 仍在 7 个主题文件被字面量覆盖（`themes.css:57,129`、`themes/dark-minimal.css:36`、`geist.css:36`、`light.css:36`、`magic.css:36`、`origin.css:36`、`shadcn.css:36`），页面级收敛无证据 | 无测试 | 部分修复 |
| UI-06 | P2 | 部分 | `tokens.css:121-131` 建立 `--space-1..16 = 4/8/12/16/20/24/32/40/48/64px`；各页面迁移情况无逐页证据 | 无测试 | 部分修复 |
| UI-07 | P2 | 部分 | `tokens.css:188-193` 建立 icon 尺寸 token（20/18/24/20/18px）；各页面迁移无逐页证据 | 无测试 | 部分修复 |
| UI-08 | P3 | 部分 | `tokens.css:180-186` 建立 motion token（150/220/400ms）；基线指出「部分普通 UI 动画超过 500ms」，`components.css:96` 的 8s shimmer 仍远超该区间 | 无测试 | 部分修复 |

### B. 页面布局（PL-01 ~ PL-09）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| PL-01 | P0 | 部分 | `routes/Chat.tsx:358` `max-w-[1280px]`、`routes/CodingHome.tsx:981` 同值。宽度由 1100px 变为 1280px，但为 Tailwind 硬编码任意值；`tokens.css:172` 的 `--page-content-max-width:1100px` 定义后零组件引用（死 token） | 无测试 | 部分修复 |
| PL-02 | P0 | 是 | `routes/Chat.tsx:527-528` 单次挂载 `ConversationActivityStream conversationId={currentConv}`，位置在消息列表（`:524-526`）之后、失败区（`:549`）之前；`routes/CodingHome.tsx:1068` 同构 | 无测试 | 已修复 |
| PL-03 | P0 | 是 | `hooks/useStreamSend.ts:364` 注释「P1-13：不再 clearConv —— 保留历史 Run 的 Activity，新事件追加」；新事件走 `appendEvent`（`:280`、`:376`），重载走 `replaceEvents`；`routes/CodingHome.tsx` 全文无 `clearConv` 调用。`activityStore.clearConv`（`activityStore.ts:384-402`）仍在，但仅会话删除路径可达 | 无测试 | 已修复 |
| PL-04 | P1 | 否 | `routes/Workflows/WorkflowEditor.tsx:126` 仍为 `{ display:'grid', gridTemplateColumns:'200px 1fr 300px', gap:16, alignItems:'start' }`，无媒体/容器查询回退 | 无测试 | 未修复 |
| PL-05 | P1 | 否 | `routes/Library.tsx:103` `grid grid-cols-3 gap-6`、`:151` 与 `:169` `grid grid-cols-3 gap-4`，仍固定三列；`routes/Media/MediaGallery.tsx` 全文无 grid/gridTemplateColumns/repeat/minmax，为平铺列表 | 无测试 | 未修复 |
| PL-06 | P1 | 否 | `routes/Terminal.tsx:26-30` 在每次 `entries` 变更时无条件 `outputRef.current.scrollTop = outputRef.current.scrollHeight`，无阈值、无 `onScroll`、无上滑锁。（`routes/Chat.tsx:310-318` 与 `routes/CodingHome.tsx:463-471` 已有 40px 锁，Terminal 未复用） | 无测试 | 未修复 |
| PL-07 | P1 | 否 | `routes/Settings.tsx:946` 仍 `style={{ width:'200px' }}` + `flex-shrink-0`，文件内无 `@media`/`matchMedia`；组件总行数 1286 | 无测试 | 未修复 |
| PL-08 | P1 | 部分 | `components/ui/page-shell.tsx`（27 行）与 `page-header.tsx`（50 行）已建立并导出（`components/ui/index.ts`），但 21 个 route 中仅 2 个接入 | `components/ui/page-header.test.tsx` 1 test | 部分修复 |
| PL-09 | P2 | — | 本轮未开展该项源码核查 | — | 未执行核查 |

### C. Chat UI（CH-01 ~ CH-12）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| CH-01 | P0 | 是 | 未配置 Provider 已从「创建 assistant 消息」改为独立失败态：`routes/Chat.tsx:267`、`:298` 调用 `setDirectFailure(createStreamFailure(...))`，由 `:549` `{visibleFailure && <ChatStreamFailure failure={visibleFailure} />}` 渲染 | `routes/Chat.test.tsx`（2 test，其中 `renders a thrown stream failure through ErrorState with a retry placeholder`） | 已修复 |
| CH-02 | P0 | 部分 | 网络错误/断流/`stream-truncated` 已走独立失败态：`hooks/useStreamSend.ts:99-125` 定义 `StreamFailure`/`createStreamFailure`，抛出点 `:308`、`:334`、`:339`、`:398`、`:440`、`:445`；`components/conversation/stream-failure.tsx:10` 注释「失败是独立状态（不追加进助手正文）」。**残留**：`useStreamSend.ts:483-485` 在 abort 分支仍执行 `content: (m.content \|\| '') + '\n\n⏹ 已停止生成'`，把标记拼进气泡正文 | `hooks/useStreamSend.test.ts`（3 test，均为失败态）；abort 追加路径无测试 | 部分修复 |
| CH-03 | P0 | — | 本轮未针对「`onSendEnd(false)` 被忽略导致 sending/thinking 残留」开展定向核查；仅知发送逻辑已收敛至共享 `useStreamSend` | — | 未执行核查 |
| CH-04 | P1 | — | 未核查用户消息背景比例与 AI 正文宽度上限 | — | 未执行核查 |
| CH-05 | P1 | 否 | `routes/Chat.tsx:574` 仍为 `<input className="input flex-1" ...>` 单行输入；`styles/components.css:127-129` `.input { height: var(--input-height) }`，`tokens.css:172` `--input-height:48px`。无 textarea、无自动增高、无附件/模型/模式分区 | 无测试 | 未修复 |
| CH-06 | P1 | 否 | `routes/Chat.tsx:99` `useState` 声明 `liveReasoning`，写入点 `:112`、`:159`、`:167`、`:172 onLiveReasoning`、`:205 onLiveReasoningUpdate`，**JSX 零引用**；`components/ReasoningBar.tsx`（85 行）全仓 0 引用方 | 无测试 | 未修复 |
| CH-07 | P1 | — | 未核查自动滚动 effect 依赖是否包含 activity 高度 | — | 未执行核查 |
| CH-08 | P1 | 否 | `routes/Chat.tsx:486` 整个流式列表容器仍为 `aria-live="polite" aria-atomic="true"`；`routes/CodingHome.tsx:1041-1042` 相同 | 无测试 | 未修复 |
| CH-09 | P1 | 部分 | 失败区已有重试按钮与「查看过程」：`components/conversation/stream-failure.tsx:19-21` `<button ... disabled>重试</button>` —— **按钮硬禁用**，无点击处理 | `routes/Chat.test.tsx` 断言 retry 占位渲染，未断言可点击 | 部分修复 |
| CH-10 | P1 | 部分 | 已共享：`useStreamSend`（Chat:144 / CodingHome:521）、`useMessagePolling`（Chat:195 / CodingHome:499）、`components/conversation/*`（Chat:12-16 / CodingHome:9-13）、40px 滚动锁（Chat:310-318 / CodingHome:463-471）。**未共享**：`routes/Chat.tsx:81` 用 `useConversations`，`routes/CodingHome.tsx:264-299` 自建内联 `load()` 与自有会话列表；全仓 `ConversationRuntime` 零命中。行数 Chat 689 / CodingHome 1110 | `routes/Chat.test.tsx` 2 test；`routes/CodingHome.test.tsx` 4 test | 部分修复 |
| CH-11 | P1 | — | 未核查消息入场延迟是否封顶 200ms | — | 未执行核查 |
| CH-12 | P2 | — | 未核查会话栏宽度 | — | 未执行核查 |

### D. Mobile UI（MO-01 ~ MO-16）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| MO-01 | P0 | 是（行为已改，来源未统一） | `mobile/src/lib/message-store.ts:132-135` `resolveChatCompletion` 对 `assistant_message` 返回 `{kind:'busy'}`；`mobile/src/components/MessageView.tsx:14` 只导入 `resolveChatCompletion`，终态仅由 `:348-402 settleRemoteCommand` 结算。`hasAssistantAfter`（`message-store.ts:96-106`）已成死代码，仅被自身测试引用。**但真相来源仍是 Supabase `remote_commands.status` 行，不是共享 Run 终态事件** | `mobile/src/lib/message-completion.test.ts`（6 test）：`终态结算：首条 assistant 消息保持 busy，不触发 completed` | 部分修复（按「以共享 Run 终态为准」的原始判据） |
| MO-02 | P0 | 否 | `src/shared/src/events/events.ts:461-513` 仅有 44 类 v2 `AgentEvent`，无八态协议模块（全仓无 `command-protocol.ts`/`chat-states.ts`）；`mobile/src/lib/remote-command.ts:1-6` 为 5 态；`MessageView.tsx:175-187` 仍自定义 12 成员 `ExecutionPhase`，含基线指出的从未使用的 `processing`（`:180`）与 `streaming`（`:181`） | 无测试 | 未修复 |
| MO-03 | P0 | 部分 | `mobile/src/api/supabase.ts:795-833 ensureCommandsChannel` 已解析每行并经 `:693-705 dispatchRemoteCommandStatus` 向 `:708-790 subscribeRemoteCommandStatus` 订阅者分发，含初始 `maybeSingle()` 查询与 2000ms 轮询（`:775`）。callbacks 不再为空。**但映射目标是 5 态 `RemoteCommandStatus`，非八态** | `mobile/src/api/supabase.ts` 无测试；仅 `mobile/src/lib/remote-command.test.ts` 覆盖纯函数 | 部分修复 |
| MO-04 | P0 | 是 | `data/supabase-schema.sql:59` CHECK 为 `('pending','processing','completed','failed','cancelled')`；`:62 client_command_id`、`:63 run_id`、`:64 task_id`、`:65 metadata JSONB`；`:156-163` 迁移块为存量库补齐四列。**注意该文件位于 `data/` 而非 `src/` 下** | 无测试 | 已修复 |
| MO-05 | P0 | 是 | `backend/src/modules/sync/realtime.ts:67` 过滤 `status=in.(pending,cancelled)`；`polling-fallback.ts:59` `.in('status', PROCESSABLE_REMOTE_COMMAND_STATUSES)`；常量定义于 `remote-command-status.ts:1,5` | `backend/src/modules/sync/remote-command-status.test.ts`：`Realtime filter 包含 cancelled 状态`、`Polling 处理状态包含 pending 与 cancelled` | 已修复 |
| MO-06 | P0 | 是 | `MessageView.tsx:189` `const CANCEL_CONFIRM_TIMEOUT_MS = 15_000`；`handleStop:775-786` → `requestCancellation:291-329`；`cancelled` 仅由后端确认（`:387-391`）或未发送队列本地 tombstone（`:310-318`）产生。全仓无 300ms 乐观取消 | `mobile/src/lib/remote-command.test.ts`：`取消动作：本地队列存在时优先 tombstone，远端存在时等待终态`（helper 级；MessageView 组件本身无测试） | 已修复 |
| MO-07 | P0 | 是 | `MessageView.tsx:331-346 mergeServerMessages` 在 `:345` 调用 `replaceOptimistic(existing, serverUserMessage)`，实现 `message-store.ts:77-89` 原地替换并清 `sendingUserMsgRef` | `mobile/src/lib/message-store.test.ts`（8 test）：`replaceOptimistic: 真实消息替换 temp- 占位` | 已修复 |
| MO-08 | P0 | 部分 | `MessageView.tsx:687-770 handleResend`：`:699` 复用 `msg.localCommandPayload ?? msg.content`（附件随 payload 保留）；`:696` `commandDeadlineRef.current = Date.now() + 300_000`（超时已具备）。**但 `:698` 调用 `createClientCommandId()` 生成新 `client_command_id`，未复用 `msg.localClientCommandId`**，重发不具幂等性 | 无测试 | 部分修复 |
| MO-09 | P1 | 否 | `MessageView.tsx:788-793` `if (e.key === 'Enter' && !e.shiftKey)`，无 `e.nativeEvent.isComposing`；全 mobile 目录 `isComposing` 零命中 | 无测试 | 未修复 |
| MO-10 | P1 | 否 | `mobile/src/styles/components.css:565-574` `.command-bar { display:flex; align-items:flex-end; gap:6px; }`，无 `flex-direction: column`。附件预览行（`MessageView.tsx:1011/1026` 作为 `.command-bar-inner` 前置兄弟节点）仍横排 | 无测试 | 未修复 |
| MO-11 | P1 | 否 | `mobile/src/components/ConversationList.tsx:56` `getConversations({ limit: 50 })`；`supabase.ts:120-130` 虽支持 `offset` 但从未传入；无 load-more 控件 | 无测试 | 未修复 |
| MO-12 | P1 | 否 | `ConversationList.tsx:90-92` 仍为 `conversations.find(c => Date.now() - new Date(c.updated_at).getTime() < 30 * 60 * 1000)` 的 30 分钟时间戳启发式，未关联最新 Run 状态 | 无测试 | 未修复 |
| MO-13 | P1 | 否 | `mobile/src/App.tsx:41` 扁平 `useState<Page>`，无返回栈；`:153-156 handleBack` 恒定跳 `'home'`；`:215` `AppearanceSettings onBack={handleBack}` 因此返回 home 而非 mine。`popstate`/`Capacitor`/`backButton`/`backStack` 全目录零命中 | 无测试 | 未修复 |
| MO-14 | P2 | — | 未核查首页 CTA 与 fixed bottom nav 的底部预留 | — | 未执行核查 |
| MO-15 | P2 | — | 未核查 `AppearanceSettings.tsx` 的旧 token 使用 | — | 未执行核查 |
| MO-16 | P2 | — | 未核查 blur/vibrancy 设置的接线与降级 | — | 未执行核查 |

### E. Design System（DS-01 ~ DS-07）

`components/ui/` 实测 25 个文件（23 组件 + barrel + 2 测试）。基线要求的 9 个共享组件全部到位：

| 组件 | 文件 | 行数 | 变体/尺寸 |
|---|---|---|---|
| PageShell | `page-shell.tsx` | 27 | 无变体；`header`/`content`/`contentClassName` 插槽 |
| PageHeader | `page-header.tsx` | 50 | 无变体；`icon`/`description`/`actions`/`action` |
| Section | `section.tsx` | 56 | 无变体；`title`/`description`/`actions` |
| Panel | `panel.tsx` | 16 | tone: `default`/`subtle`/`accent` |
| Stack | `stack.tsx` | 43 | direction row/column、gap 10 档、align 5 档、justify 6 档、wrap |
| Inline | `inline.tsx` | 40 | gap/align/justify/wrap（默认 wrap） |
| Button | `button.tsx:1-55` | 82 | variant 6 档 × size 8 档（`h-6`/`h-7`/`h-8`/`h-9`/`size-6..9`） |
| IconButton | `button.tsx:56-80`（内联，无独立文件） | — | size `sm`/`default`/`lg` |
| StatusPill | `status-pill.tsx` | 70 | 8 状态 → 6 tone，可选 `icon`/`label` |

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| DS-01 | P1 | 部分 | `base.css:284-291` 的 8 个 `--radius-*` 已全部改为 `var(--radius-source-*)` 桥接，raw 值归零，唯一数值源为 `tokens.css:145-167`。**但 `--card-radius` 仍被 7 个主题文件字面量覆盖**（见 UI-05） | 无测试 | 部分修复 |
| DS-02 | P1 | 是 | `base.css:264` 为 `--color-accent: var(--color-accent-source);`（`@theme inline` 桥接别名），自引用已消除；真实值在 `tokens.css:10` | 无测试 | 已修复 |
| DS-03 | P1 | 部分 | 缺失的 PageShell/PageHeader/Section/Panel/StatusPill 已全部补齐（见上表），Stack/Inline 亦到位。**但 inline style 未收敛**：`routes/Settings.tsx` 106、`routes/Knowledge.tsx` 67、`routes/Chat.tsx` 50、`routes/CodingHome.tsx` 49、`components/Sidebar.tsx` 24 | `components/ui/page-header.test.tsx` 1 test、`components/ui/status-pill.test.tsx` 1 test | 部分修复 |
| DS-04 | P1 | 否 | `components/ui/button.tsx:25` 默认 `h-8`（32px）、`icon: size-8`（32px）；`components/ui/input.tsx:16` 硬编码 `h-10`（40px）。`tokens.css:170,172` 的 `--btn-height:44px`/`--input-height:48px` 仅被旧 CSS 类 `.btn`（`components.css:193`）与 `.input`（`components.css:129`）消费，共享组件未接入 | 无测试 | 未修复 |
| DS-05 | P1 | 否 | `components/Layout.tsx:291` `document.documentElement.classList.add('dark');` 位于 `useEffect` 内且**无主题条件判断**（`:287-290` 注释称此为 shadcn 兼容变通） | 无测试 | 未修复 |
| DS-06 | P1 | 否 | `styles/themes.css:80-141` 与 `styles/themes/light.css:2-55` 均定义 `[data-theme="light"]`；`globals.css:8` 先引 themes.css、`:14` 后引 light.css，后者覆盖前者，前者 62 行对重叠键已成死代码 | 无测试 | 未修复 |
| DS-07 | P2 | 否 | `--card-radius` 在 `tokens.css:156` 定义为 `var(--radius-lg)`，被 `themes.css:57,129` 与 5 个主题文件的字面量覆盖，token 名不符实问题依旧 | 无测试 | 未修复 |

### F. CSS（CS-01 ~ CS-05）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| CS-01 | P1 | 否 | CSS 侧为 `[data-glass-off]`（`components.css:52` 对 `.glass-card`、`:121` 对 `.glass-menu`；全仓另一处仅 `routes/Settings.tsx:635` 注释）；`components/Layout.tsx:437-438` 设置的是 `data-glass-enabled`（`'true'` / `removeAttribute`）。两个属性名永不相交，**玻璃关闭开关当前是空操作** | 无测试 | 未修复 |
| CS-02 | P1 | 否 | `styles/themes.css:25-26`（`:root, [data-theme="dark"]`）仍为 `--glass-blur-radius: 26px; --glass-saturate: 200%;`，`:27` `brightness: 1.25`；仅 `themes/light.css:17-19` 覆写为 18px/180%/1.15 | 无测试 | 未修复 |
| CS-03 | P2 | 否 | 主题层仍各自定义 glass fill（`themes.css:57`、`themes/light.css:36` 等 7 处字面量），玻璃参数未统一由 Design Token 控制 | 无测试 | 未修复 |
| CS-04 | P2 | — | 未核查 hover 位移选择器范围 | — | 未执行核查 |
| CS-05 | P3 | 是 | `styles/components.css:36-50` `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` 提供 `.glass-card` 不透明降级，另含 `.sidebar-glass` 与 inline `style*=backdrop-filter` 回退 | 无测试 | 已修复 |

### G. 组件重复（DU-01 ~ DU-07）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| DU-01 | P0 | 部分 | 发送/流式/停止/loop/reasoning/activity/滚动锁已共享 `useStreamSend` + `useMessagePolling` + `components/conversation/*`；**但不存在 `ConversationRuntime`（全仓 0 命中）**，`CodingHome.tsx:264-299` 仍自建内联 `load()` 与自有会话列表，`Chat.tsx` 689 行 / `CodingHome.tsx` 1110 行 | `routes/Chat.test.tsx` 2 test、`routes/CodingHome.test.tsx` 4 test | 部分修复 |
| DU-02 | P1 | 否 | `components/ai-elements/` 仍存在，7 文件 1890 行（chain-of-thought 222、code-block 623、conversation 168、message 360、reasoning 226、shimmer 77、tool 173），routes/ 与 components/ 外部引用 0 | 无测试 | 未修复 |
| DU-03 | P1 | 否 | `lib/notification-center.ts`（237 行，8 个引用方）与 `lib/notifications.ts`（85 行，独立 `PERMISSION_KEY` 与自有 `requestNotificationPermission`）并存；`components/Layout.tsx:8` 仍 `import { requestNotificationPermission } from '../lib/notifications';` | `lib/notification-center.test.ts` 11 test | 未修复 |
| DU-04 | P1 | 否 | 三套并存：`components/ui/modal.tsx`（103 行，**0 消费方**）、`components/ui/confirm-dialog.tsx`（274 行，13 route + 3 组件引用）、手写遮罩 7 处（`routes/Documents.tsx:213-214`、`routes/Library.tsx:241-242`、`routes/Projects.tsx:197-198` 与 `:232-233`、`routes/Providers.tsx:294-295` 与 `:396-397` 均为裸 `fixed inset-0 z-50 bg-black/60 backdrop-blur-md`；`routes/Media/MediaPreview.tsx:22,26` 为手写 `position:fixed; inset:0`） | 无测试 | 未修复 |
| DU-05 | P1 | 是 | 超级/普通流双实现已消除：`routes/Chat.tsx:144` 与 `routes/CodingHome.tsx:521` 均从 `hooks/useStreamSend` 取单一发送/流式实现 | `hooks/useStreamSend.test.ts` 3 test | 已修复 |
| DU-06 | P2 | — | 未核查 `components/Sidebar.tsx` 完整/mini 双 JSX 是否收敛 | — | 未执行核查 |
| DU-07 | P2 | — | 未核查 `components/ui/textarea.tsx`(64px) 与 `components.css:.textarea` 双定义 | — | 未执行核查 |

### H. Inline style（H 组 IS-01 ~ IS-09）

实测 `style={{` 出现次数（与基线逐项对照）：

| 文件 | 基线 | 实测 | 变化 |
|---|---|---|---|
| `routes/Settings.tsx` | 106 | 106 | 持平 |
| `routes/Knowledge.tsx` | 66 | 67 | +1 |
| `routes/Chat.tsx` | 60 | 50 | -10 |
| `routes/CodingHome.tsx` | 57 | 49 | -8 |
| `components/Sidebar.tsx` | 24 | 24 | 持平 |

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| IS-01 | P1 | 否 | 前五文件合计 296 处；`components/` 全量聚合数未单独统计，量级未下降 | 无测试 | 未修复 |
| IS-02 | P1 | 部分 | 60 → 50（`routes/Chat.tsx`） | 无测试 | 部分修复 |
| IS-03 | P1 | 部分 | 57 → 49（`routes/CodingHome.tsx`） | 无测试 | 部分修复 |
| IS-04 | P1 | 否 | 106 → 106（`routes/Settings.tsx`），组件仍 1286 行 | 无测试 | 未修复 |
| IS-05 | P1 | 否 | 66 → 67（`routes/Knowledge.tsx`），略有上升 | 无测试 | 未修复 |
| IS-06 | P1 | 否 | 24 → 24（`components/Sidebar.tsx`） | 无测试 | 未修复 |
| IS-07 | P2 | — | 未核查 `components/activity/*` 的 inline style 数 | — | 未执行核查 |
| IS-08 | P2 | — | 未核查 `routes/Workflows/*` 聚合 inline style 数 | — | 未执行核查 |
| IS-09 | P2 | — | 未核查 `routes/Toolbox/*` 聚合 inline style 数 | — | 未执行核查 |

### I. Loop 逻辑（LO-01 ~ LO-08）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| LO-01 | P0 | 部分 | `core/runtime/execution-completion.ts:121 evaluateTaskCompletion`（返回 `:45 CompletionVerdict`）已实现；`execution-loop.ts:33` 导入、`:370-393 judgeLoopCompletion`、`:680` 在 `if (opts.loop)` 内调用。**但 `execution-loop.ts:374` `if (deps.isTaskComplete) { return ... }`（`:376-378`）先于 `:383` 的 evaluator 直接返回** | `core/runtime/execution-loop.test.ts`（44 test）：`P4 缺省判定: 有文本但目标未完成（无产出证据）→ continue 而非立即完成`（`:861`）、`P4 显式注入的 isTaskComplete 优先于缺省 evaluator`（`:958`） | 部分修复 |
| LO-02 | P0 | 否 | 三个生产调用方仍全部注入文本判据，且该注入正好短路 evaluator：`modules/conversations/tool-loop.ts:322`、`modules/agents/tool-loop.ts:313`、`modules/sync/command-processor.ts:783`，三处均为 `isTaskComplete: (resp) => resp.content.trim() !== ''`。**evaluator 在生产链路为死代码** | `execution-loop.test.ts::P4 显式注入的 isTaskComplete 优先于缺省 evaluator`（证明旁路存在） | 未修复 |
| LO-03 | P0 | 否 | `execution-loop.ts:529-533` 费用由 `cumulativeTotalTokens * rate` 反推，无费用累计字段；`maxCostCny: 0` 硬编码于两处默认预算（`:109`、`:120`），`budgetFromAgentLimits:151` 强制 `base.maxCostCny`；生产 `modules/agents/index.ts:303` 亦为 `maxCostCny: 0`。**`budget.maxCostCny > 0` 恒假，`budget_exceeded='cost'` 在生产不可达** | `execution-loop.test.ts::B3: 两次模型调用累计成本超限 → budget_exceeded=cost`（`:499`）、`P4 预算优先: 成本预算耗尽时即使目标已满足也不判完成`（`:1022`）—— 仅在测试显式注入 `maxCostCny: 1.5` 时通过 | 未修复 |
| LO-04 | P1 | 部分 | `execution-loop.ts:693-698` 确实 `emit('execution.verifying', { turn, contentLength, verdict, reason })`。**但 `CompletionState` 的 `'verifying'` 成员（`:50`）在循环内从未被赋值**（全文件无 `state = 'verifying'`），且 `execution.*` 事件族不在 `src/shared/src/events/events.ts` 协议内（该文件仅有 `attempt.*` 与 `retry.*`） | `execution-loop.test.ts::P4 verifying 事件: payload 携带 evaluator verdict`（`:935`） | 部分修复 |
| LO-05 | P1 | 是 | `execution-loop.ts:559` 在模型返回并 `accumulateUsage` 之后补 `if (opts.signal?.aborted) throw new CancellationError(...)` | `execution-loop.test.ts::取消复查: 模型返回后（不协作）signal 中止 → cancelled`（`:273`） | 已修复 |
| LO-06 | P1 | 部分 | `ExecutionLoopResult`（`execution-loop.ts:195-218`，返回于 `:855-870`）已含 `finishReason`、`retryCount`、`retryExhausted`、`terminalState`，且 `checkpoint` 内含 `toolResults`；**但不含 `messages`，也不含 `error`**（错误被折叠进 `content`，`:805`/`:818`） | 无测试 | 部分修复 |
| LO-07 | P1 | 是 | `:539-543`（`buildRequest` 抛错）与 `:690-692`（完成判定抛错）均转为 `{ kind:'failed', error }` 而非裸抛 | `execution-loop.test.ts::buildRequest 抛错 → state=failed（不裸抛）`（`:289`）、`isTaskComplete 抛错 → state=failed（Loop 不默认放行）`（`:297`） | 已修复 |
| LO-08 | P2 | 部分 | `execution-loop.ts:180-189 accumulateUsage` 为累计式（`cumulative` 与 `lastRequest` 已区分），但仅解构 `inputTokens`/`outputTokens`；`shared/src/llm-stream.ts:36 reasoningTokens`、`:38 cachedTokens` 被丢弃 | `execution-loop.test.ts::Usage: cumulative 与 lastRequest 区分（§八）`（`:372`，不覆盖 cached/reasoning） | 部分修复 |

### J. Retry 逻辑（RT-01 ~ RT-12）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| RT-01 | P0 | 是 | `core/models/retry-policy.ts:80` `const maxRetries = opts.maxRetries ?? 5`；`provider-adapter.ts:165` 建默认策略时未覆盖该值 | `core/models/retry-policy.test.ts::默认 maxRetries=5：首次尝试加 5 次重试共 6 次尝试`（`:123`） | 已修复 |
| RT-02 | P0 | 是 | `core/errors/retry-error.ts` 定义 `RetryExhaustedError`；Provider 路径抛出于 `provider-adapter.ts:207,233,252`，Task/Tool 路径抛出于 `execution-retry.ts:317` | `provider-adapter.test.ts::retryable non-2xx 在策略耗尽时抛 RetryExhaustedError 并保留状态码`（`:450`）、`持续 503 耗尽 Provider 重试后抛 RetryExhaustedError，并保留最后错误`（`:480`）；`execution-retry.test.ts::Task Retry：默认 8 次重试全部失败后抛 RetryExhaustedError`（`:65`） | 已修复 |
| RT-03 | P0 | 部分 | `core/runtime/execution-retry.ts:356` `ExecutionRetryController` 默认 `?? 8`、`:426` `ToolRecoveryController` 默认 `?? 3`，均在生产循环实例化（`execution-loop.ts:498`、`:509`）。**但事件名为 `attempt.started` / `retry.*`，缺 `execution.` 前缀，与 Loop 自身的 `execution.*` 事件族不连续** | `execution-retry.test.ts::Task Retry：前 8 次失败后第 9 次成功，并发射完整 retry 事件序列`（`:19`）、`Tool Retry：retryable 错误最多自动重试 3 次`（`:85`）；`shared/src/events/events.test.ts::Retry 事件携带 run/task、attempt、layer 与调度字段`（`:454`） | 部分修复 |
| RT-04 | P0 | 否 | `src/backend/src/lib/fetch-retry.ts`（169 行）仍存在，自带 `RETRYABLE_STATUSES`、自带 `circuitBreakerState` Map、自带 `maxRetries = 5`；**生产引用方 1 个**：`modules/workflows/node-executors.ts:8` 导入、`:142` 使用。另有 `lib/fetch-retry.test.ts:11` | `lib/fetch-retry.test.ts::parseRetryAfter（Wave0-FR）`、`::fetchWithRetry 状态机契约（Wave0-FR）` —— 双系统仍在维护 | 未修复 |
| RT-05 | P0 | 否 | `provider-adapter.ts:165-166` 每次建 transport 时新建 policy+breaker，`:342-350` 每次建 adapter 时新建 transport；`core/models/model-runtime-factory.ts:35-42` `buildModelRuntime` 每次调用新建 adapter；而 `buildModelRuntime` 在 `modules/conversations/tool-loop.ts:197`、`modules/agents/tool-loop.ts:170` 为**每请求**调用。**熔断状态跨调用不累积** | 无测试 | 未修复 |
| RT-06 | P0 | 是 | `provider-adapter.ts:231-235` 仅在 `if (retryable)` 时 `circuitBreaker.recordFailure()`，而 `retryable` 仅对 429/5xx 为真（`:215`），4xx 不计入熔断 | 无测试（`retry-policy.test.ts::5xx 可重试，4xx 其他错误不重试` 测的是 `shouldRetry`，非熔断计数） | 已修复（无测试） |
| RT-07 | P0 | 部分 | `provider-adapter.ts:238-253` 空 body 已纳入重试；**但 `:256-265` 流读取为 `try { for(;;) await reader.read() } finally { reader.releaseLock() }`，无 `catch`、不重入重试循环**，首字节之后断流直接外抛 | 无测试（空 body 与中途断流均无测试） | 部分修复 |
| RT-08 | P0 | 部分 | `core/runtime/run.ts:12-24 RUN_STATUSES` = `created/running/waiting/retry_waiting/retrying/verifying/completed/failed/cancelled/interrupted/budget_exceeded`（11 态），已含 `retry_waiting`/`retrying`/`verifying`/`budget_exceeded`；`db/schema/index.ts:242-245` 有 `attempt`（`integer notNull default 1`），`db/migrate.ts:580-605` 为迁移 v17。**但 attempt/retry 事件未按 `execution.*` 命名** | `core/runtime/run.test.ts`；`db/migrate.test.ts`（无 v17 字段专项断言） | 部分修复 |
| RT-09 | P1 | 是 | `retry-policy.ts:45-63 extractRetryAfterMs`：`numeric <= 0 ? 0` 处理 "0"，`Date.parse` 处理 HTTP-date，负值钳制；`:90-94 delayMs` 在指数分支前返回 Retry-After 值 | `retry-policy.test.ts::extractRetryAfterMs：支持秒数字符串/HTTP-date/0，非法值返回 undefined`（`:22`）、`delayMs：Retry-After 优先，0 不回退指数退避`（`:34`） | 已修复 |
| RT-10 | P1 | — | 未针对 `core/models/model-runtime.ts` 多 usage chunk 覆盖问题开展定向核查 | — | 未执行核查 |
| RT-11 | P1 | — | 未核查 malformed JSON 静默忽略 | — | 未执行核查 |
| RT-12 | P1 | — | 未核查 `lib/event-store-runtime.ts` seq claim 与 append 的原子性 | — | 未执行核查 |

### K. Tool Call（TC-01 ~ TC-10）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| TC-01 | P0 | 是 | `execution-loop.ts:578-588` 设置 `assistantMessage.tool_calls = toolCalls` 并在追加 tool 结果**之前**压入消息链；`:590-597` 另有 `onAssistantToolCalls` 持久化钩子 | `execution-loop.test.ts::tool call 消息链回归`（`:113`，`:153` 断言 `tool_calls`） | 已修复 |
| TC-02 | P0 | 是 | `execution-loop.ts:580` 取 `tc.id` → `:610`、`:614` 构造 `{role:'tool', tool_call_id: toolCall.id}` → `:636`、`:642`、`:656` 贯穿 SSE `id:`；生产侧 `modules/conversations/tool-loop.ts:228,243,291` 将 `tool.id` 传入 `persistToolResultMessage(db, conversationId, tool.id, ...)` | `execution-loop.test.ts::tool call 消息链回归`（同时断言 `id: 'call-weather'` 与 `tool_call_id: 'call-weather'`） | 已修复 |
| TC-03 | P0 | 是 | `execution-loop.ts:565-568` 在任何工具派发前返回 `{ kind:'failed', error:'模型返回了未启用的工具调用: ...' }`，落为 `state=failed` + `execution.failed` 事件 | `execution-loop.test.ts::B2: hasTools=false 收到 tool_calls 不标 completed`（`:92`） | 已修复 |
| TC-04 | P0 | 部分 | 循环确实发射非 completed 状态：`execution-loop.ts:658-662` `emit(... status:'failed')`；`execution-checkpoint.ts:19` 记录 step `status:'completed'\|'failed'`。**但生产边界无状态字段**：`lib/production-tool-executor.ts:60-66 ProductionToolResult` 仅有可选 `error?: string`；且不存在名为 `ToolExecutionResult` 的类型 | `execution-loop.test.ts::工具失败状态真实`（`:182`，断言 `toolEvent?.payload.status === 'failed'`） | 部分修复 |
| TC-05 | P0 | 部分 | `core/tools/tool-result.ts:80-85` 的联合类型以 `kind` 判别，取值为 `success`/`error`/`pending-approval`/`timeout`/`cancelled`。**与目标协议的 `failed`/`approval_required` 命名不一致**（语义近但名称未对齐） | `execution-loop.test.ts::工具失败状态真实` | 部分修复 |
| TC-06 | P0 | 否 | `lib/production-tool-executor.ts:253` 与 `:298` 仍为 `typeof result.output === 'string' ? result.output : JSON.stringify(result.output)`，审批后重执行路径同样扁平化 | 无测试 | 未修复 |
| TC-07 | P0 | — | 未核查 `modules/conversations/tool-loop.ts:202-214` 非法参数事件的 status 语义 | — | 未执行核查 |
| TC-08 | P1 | — | 未核查 `core/tools/tool-timeout.ts` 是否向底层工具传合并 signal | — | 未执行核查 |
| TC-09 | P1 | — | 未核查 `AetherTool.policy` 读取与 Zod parsed data 传递 | — | 未执行核查 |
| TC-10 | P1 | — | 未核查 `core/tools/tool-runtime.ts` 事件是否顶层化 | — | 未执行核查 |

### L. Event / State（EV-01 ~ EV-20）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| EV-01 | P0 | 是 | `core/runtime/run.ts:12-24` 已含 `retry_waiting`/`retrying`/`verifying`/`budget_exceeded`，共 11 态 | `core/runtime/run.test.ts` | 已修复 |
| EV-02 | P0 | 是 | `run.ts:220-222` `if (opts?.error !== undefined) this.#error = opts.error`，getter `:171-173`，`toEntity:269` 输出 | `core/runtime/run.test.ts` | 已修复 |
| EV-03 | P0 | 部分 | `shared/src/events/events.ts:175,181,191,197,203,209` 定义 `attempt.started`/`attempt.completed`/`retry.scheduled`/`retry.started`/`retry.completed`/`retry.failed`/`retry.exhausted`，注册于 `:507-512`。**命名为 `attempt.*`/`retry.*`，非基线要求的 `execution.attempt.*`/`execution.retry.*`** | `shared/src/events/events.test.ts::Retry 事件携带 run/task、attempt、layer 与调度字段`（`:454`） | 部分修复 |
| EV-04 | P0 | 否 | `store/activityStore.ts:112-114 sortBySeq` 为 `e.slice().sort((a,b)=>a.seq-b.seq)`，单一排序键，无 run/timestamp/eventId 次级键；`getEvents:457` 合并全部 run 后仅按此排序，seq 于 run 间重启时同值次序由到达顺序决定 | `store/activityStore.test.ts::activityStore 跨 Run 状态隔离(P0-03)`（`:163`，仅断言分桶，非排序） | 未修复 |
| EV-05 | P0 | 否 | `components/activity/ActivityStream.tsx:111` `<TaskCardView card={taskCard} />` 仍在 `:112` `{result}` **之前**；`:78-83` 聚合 reasoning 并在 `:102-105` **追加在最后**；`:90-99` 渲染循环只处理 `rec.kind==='tool'`（`:91`）与 `rec.kind==='agent' && rec.status==='running'`（`:96`），`activityStore.ts:818-826` 产出的 `kind:'task'` 终态记录被**丢弃** | 无测试 | 未修复 |
| EV-06 | P0 | 部分 | store 侧已隔离：`activityStore.ts:578 reasoningByAgent` + `:662-670` 按 run/agent 分桶。**但 `ActivityStream.tsx:78-83` 将全部 `agent.reasoning.delta` 跨 run 跨 agent 用 `.join('')` 拼接**；`:103` 的 running 判定 `!events.some(ee => ee.eventType === 'task.completed' && ee.seq > e.seq)` 只认 `task.completed`，**不认 `task.failed`/`task.cancelled`** | `store/activityStore.test.ts::run A 的 reasoning 不影响 run B`（`:194`，仅 store 层） | 部分修复 |
| EV-07 | P0 | 否 | `activityStore.ts:527-536` 仍以 `if (ev.eventType==='task.started' && ev.seq > latestStartedSeq)` 取最大 started seq；`projectTaskProgress:845-851` 亦按数组位置的最后一个 `task.started`。`runMeta.startedAt`（`:197`）虽记录但未用于选择 | `store/activityStore.test.ts::runMetaById 记录 run 元数据（起始/结束时间、状态、结束原因）`（只断言字段存在） | 未修复 |
| EV-08 | P0 | 否 | `replaceEvents` 返回对象（`activityStore.ts:372-379`）、`clearConv`（`:404-411`）、`clearRun`（`:436-443`）**均不含 `_eventIdentitySetByRun` 键**，旧 identity Set 全部保留。`replaceEvents:324-330` 清了 eventsByRun/cursor/taskCardCache/reasoningCache/runMetaById 却留下 Set，导致 `:174 if (seenSet?.has(identity)) return;` 会静默丢弃重新追加的同事件，且 Set 持续泄漏 | 无测试（`activityStore.test.ts::replaceEvents 替换掉该 conversation 所有旧 run 事件` 不涉及 identity） | 未修复 |
| EV-09 | P0 | 否 | `activityStore.ts:168` `const list = get().eventsByRun[runKey] ?? []` 后 `:175 list.push(event)` **原地修改 store 内已有数组**；`:246` → `:252` 在 `appendEvents` 同样；`:192` `const newMeta = existingMeta ?? {...}` 后 `:202-204` 直接赋值 `newMeta.status`/`endedAt`/`endReason` 修改既有 runMeta 对象（`:272`→`:283-285` 同）。**额外缺陷**：`:594` 与 `:595` 对 `cache.card.steps` 做了两份独立浅拷贝，导致 `byAgent` 行修改（`:656 row.state=`）与 `steps` 脱钩，`:701 cardChanged` 永远看不到状态翻转 | 无测试 | 未修复 |
| EV-10 | P0 | 否 | 两集合几乎不相交。`api/streamClient.ts:103` 内联判定 `{ 'task.completed', 'task.failed', 'agent.output.completed' }`（无 `task.cancelled`、无 `run.*`）；`hooks/useStreamSend.ts:15-21` `TERMINAL_EVENT_MAP = { run.completed, run.failed, run.cancelled, run.interrupted, task.failed }`（无 `task.completed`、无 `agent.output.completed`）。**仅 `task.failed` 一项重合**，且不存在共享常量 | `api/streamClient.test.ts` 12 test（SSE 帧解析与 reject/resolve 语义，无终态集合一致性断言） | 未修复 |
| EV-11 | P0 | 否 | 双实现并存：v2 `core/events/event-bus.ts`（`createInMemoryEventBus`，经 `core/events/index.ts:11` 导出，仅被 `core/events/event-bus.test.ts:15` 引用）；v1 `lib/event-bus/`（6 文件）`createEventBus(db, ...)` 被 `modules/conversations/chat-handler.ts:17,198`、`conversations/routes.ts:9,73,226,262`、`conversations/tool-loop.ts:12,28`、`modules/agents/sse-handler.ts:2`、`agents/tool-loop.ts:3`、`modules/sync/command-processor.ts:19`、`conversations/compaction.ts` 调用。普通 Chat 仍只写 `activity_events`（`lib/event-bus/persistence.ts:51`），`SqliteEventStore`（`modules/runs/events.ts:58`）未接入 Chat | `core/events/event-bus.test.ts`、`lib/event-bus.test.ts`（各自孤立测试） | 未修复 |
| EV-12 | P0 | 部分 | `shared/src/events/legacy-adapter.ts:74-77` 将 `run.completed`/`run.failed`/`run.cancelled`/`run.interrupted` 全部映射为 `'session.closed'`，`:140 base.status = p.endReason ? 'completed' : 'started'` —— **run 级 failed/cancelled 仍被压成 completed**。task 级 `:82-84` 为 1:1 无损。`:108-113` 另将全部 `attempt.*`/`retry.*` 压成 `agent.retry` | `shared/src/events/events.test.ts`；`core/events/legacy-adapter.test.ts`（无「failed/cancelled 不被压成 completed」断言） | 部分修复 |
| EV-13 | P0 | 是 | `run-lifecycle-manager.ts:288-294` 构造 `casWhere = and(eq(runs.id,runId), eq(runs.status, from), ...)`，`:305-310` 读 `changes()` 并在 0 时抛 `RUN_TRANSITION_CONFLICT` | `core/runtime/run-lifecycle-manager.test.ts`（含 CAS 冲突用例） | 已修复 |
| EV-14 | P0 | 是 | `run-lifecycle-manager.ts:354-362` `recoverStale` 条件为 `and(status IN ('running','waiting'), COALESCE(lastUpdatedAt,createdAt) <= cutoff)`；`:30 DEFAULT_STALE_AFTER_MS = 30*60*1000` | `core/runtime/run-lifecycle-manager.test.ts`（含租约边界用例） | 已修复 |
| EV-15 | P0 | 部分 | 幂等与可见性门控已有 11 个测试，其中 `notification-center.test.ts:146` `测试 10: 页面前台不打扰（hidden=false 不发送），页面后台发送；always 强制发送` 覆盖前台抑制与 always 覆盖。**但没有测试断言「notifyOnce 先 markNotified 再检查可见性」的顺序问题已消除**（即前台失败后转后台补发是否仍可达） | `lib/notification-center.test.ts` 11 test（缺「前台失败→后台恢复」序列） | 部分修复 |
| EV-16 | P1 | 否 | `run-lifecycle-manager.ts:89 ACTION_FROM.create = ['created']` 与 `:105 ACTION_TO.create = 'created'` 仍声明。因 `:253` `isValidRunTransition('created','created')` 为假（`run.ts:74 VALID_RUN_TRANSITIONS.created = ['running']`），该动作**现在可证明必然抛 invalidTransition**，即死代码且语义冲突 | 无测试 | 未修复 |
| EV-17 | P1 | 否 | `core/runtime/lifecycle.ts:143-147` `async fail(error){ this.#state = 'failed'; ... }` 直接赋值，**不查 `VALID_TRANSITIONS`**，对比同文件 `transition():90-98` 有校验。可从任意态（含吸收态 `stopped`/`failed`）进入 failed | `core/runtime/lifecycle.test.ts`（无该校验断言） | 未修复 |
| EV-18 | P1 | 部分 | Checkpoint 已接线进循环：`execution-loop.ts:473-484` 创建并 `recordExecutionCheckpoint`，`:609-661` 逐步记录，`:683-686` 消费 `toolResults`/`pendingSteps`/`lastError`，`:865` 随结果返回。**但仅存于进程内 LRU Map**（`core/runtime/execution-checkpoint.ts:256-268`），`:250` 注释明写「本轮不做持久化」；`getExecutionCheckpoint` 无生产调用方 | `execution-loop.test.ts::P4 checkpoint: 预算耗尽时生成并随结果返回（供 Retry 恢复）`（`:974`）、`P4 checkpoint: 取消时生成并随结果返回（供 Retry 恢复）`（`:996`）；`core/runtime/execution-checkpoint.test.ts::records the latest checkpoint per run and reads it back for retry recovery`（`:201`） | 部分修复 |
| EV-19 | P1 | 否 | `core/runtime/cancellation.ts:193-216 withCancellation` 为 `Promise.race([promise, cancellationPromise])`，**signal 未下传给被包裹操作**，外层失败后底层继续执行。（对照：`execution-retry.ts:36 RetrySleep = (delayMs, signal?) => Promise<void>` 是 signal 感知的，但通用 helper 不是） | `core/runtime/cancellation.test.ts`（无协作式断言） | 未修复 |
| EV-20 | P1 | 否 | `runtime-context.ts:12-32` 的 `RuntimeContext` 接口**无 `abort` 成员**，`abort` 由 `:106-111 Object.defineProperty(..., { enumerable:false })` 事后挂载（无类型）；`:70-72` 父 signal 监听用 `{ once:true }` 但**未保存 `removeEventListener` 句柄，无 dispose** | `core/runtime/runtime-context.test.ts`（无 dispose 断言） | 未修复 |

### M. Workflow 执行（WF-01 ~ WF-06）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| WF-01 | P0 | 是 | `execution-engine.ts:23-30 NodeResultRecord` 带 `status:'completed'\|'failed'` + `error`；`:107-132 normalizeNodeResult` 拒绝裸字符串（`节点 X 返回了未结构化输出`）与非字符串 error；`:134-151 toResultRecord`；`:324-328` 同波首个失败节点置 `terminal={status:'failed'}` 并阻断下游。`node-executors.ts:17-19 nodeFailure()` 返回 `{output, error}` | `execution-engine.test.ts::节点返回错误字符串时 workflow 终态为 failed`、`旧 executor 返回裸字符串时保守标记 failed`、`同波节点单点抛错时等待其余节点收尾并阻断下游`；`execution-engine.db.test.ts::单节点失败时两张运行表与返回值都写入 failed` | 已修复 |
| WF-02 | P0 | 是 | `execution-engine.ts:244-250` 自建 `AbortController` 并注册 `runCancellationRegistry`，`:246-248` 链接调用方 signal，`:283`/`:320` 每波边界检查，`:303`→`:165` 将 signal 传入 `executeNode`；`node-executors.ts:109 runtime.complete({ signal })`、`:146-148 AbortSignal.any([signal, timeout])`、`:264 executeCommand(..., signal)` | `execution-engine.test.ts::取消后不再推进后续节点`；`execution-engine.db.test.ts::执行中取消时返回值与两张运行表保持 cancelled`、`外部已取消的 Run 发生非法转移时仍返回 cancelled`；`execution-engine.events.test.ts::emits workflow.cancelled（而非 workflow.failed）when workflow is cancelled` | 已修复 |
| WF-03 | P0 | 否 | workflows 模块内 `retry`/`checkpoint`/`resume`/`attempt` 检索仅命中 `:431 retryable: false`（RuntimeError 选项，无关）与 `node-executors.ts:8,142 fetchWithRetry`（**HTTP 传输层重试，非节点级/工作流级重试**）。无节点级重试循环、无工作流级重试、无 checkpoint 写入、无 resume 入口。（`core/runtime/execution-retry.ts` 与 `execution-checkpoint.ts` 属 Run 运行时，workflow 引擎未使用） | 无测试 | 未修复 |
| WF-04 | P0 | 否 | 无 `workflow_node_runs` 表。`db/schema/index.ts:177-186` 与 `db/migrate.ts:279-288,470-477` 仅有 `workflow_runs`（含单一 `current_node_id`）；`workflow_node_runs`/`workflowNodeRuns` 全 `src/backend/src` 零命中。节点态仅存于 `workflow_runs.results` JSON，`:435-441` 终态一次性写入 | 无测试 | 未修复 |
| WF-05 | P1 | 否 | `execution-engine.ts:156-159` 每个并行节点独立执行 `db.update(workflowRuns).set({ currentNodeId: node.id }).where(eq(workflowRuns.id, runId)).run()`，写同一 `current_node_id` 列，后写覆盖先写 | 无测试 | 未修复 |
| WF-06 | P1 | — | 未核查 `modules/workflows/index.ts` 的 API 描述与受控并行 DAG 是否已对齐 | — | 未执行核查 |

### N. API 层（AP-01 ~ AP-08）

| 编号 | 原严重度 | 是否修复 | 证据 | 测试 | 状态 |
|---|---|---|---|---|---|
| AP-01 | P0 | 否 | `api/client.ts:10 authReadyPromise` 于 `:15` 赋值一次，`:24-26` catch 吞掉失败且**未重置为 null**，首次认证失败被永久缓存；`:17` 认证 fetch 无 `AbortController`/超时（超时控制器仅在 `request` 内 `:64` 创建） | 无测试（`api/client.test.ts` 不存在） | 未修复 |
| AP-02 | P0 | 否 | `client.ts:91-109` 单次 fetch，无重试循环、无退避；错误为裸 `new Error(...)`（`:99`、`:106`），不带 `status`/`code`/`retryable`。`{message, retryable}` 形状仅存在于 `hooks/useStreamSend.ts:101`，不在请求客户端 | 无测试 | 未修复 |
| AP-03 | P0 | 否 | `client.ts:130-131 mergeSignals` 以 `Symbol('mergedAbortListener')`/`Symbol('mergedAbortController')` 存储；`:148-149 cleanupMergedSignals` **新建不同的 Symbol 实例**，`:153` 查找永不命中，abort 监听在非 `AbortSignal.any` 回退路径上泄漏 | 无测试 | 未修复 |
| AP-04 | P1 | 否 | 裸 `fetch(` 实测**合计 25 处，与基线完全持平**：`routes/Toolbox.tsx` 11、`routes/CodingHome.tsx` 5、`components/Layout.tsx` 2、`routes/Terminal.tsx` 2、`routes/Settings.tsx` 2、`routes/settings/DataManage.tsx` 1、`routes/McpSettings.tsx` 1、`hooks/useMessagePolling.ts` 1。（另：`api/client.ts` 2、`api/streamClient.ts` 3 不在基线清单内） | 无测试 | 未修复 |
| AP-05 | P1 | 否 | `streamClient.ts:247-263 fetchEvents` 仅接受 `afterSeq`（`:252`），无 `limit`、无 cursor、全文无 `Last-Event-ID`；streamClient 内无重连/退避逻辑 | `api/streamClient.test.ts` 12 test 仅覆盖 `parseSseFrame` 与 reject/resolve/截断语义，**无 Last-Event-ID / 分页 / 重连测试** | 未修复 |
| AP-06 | P1 | — | 未核查旧 `retry` 事件处理与请求层重试 | — | 未执行核查 |
| AP-07 | P1 | 否 | `client.ts:74-81 sensitiveReadPaths` 含 `'/approvals/'`，匹配式为 `path === p \|\| (p.endsWith('/') && path.startsWith(p))`；`listApprovals` 在 `:234` 请求 `'/approvals'` —— `'/'===p` 为假且 `'/approvals'.startsWith('/approvals/')` 为假，**该 GET 不被判定为敏感，不带 `Authorization`**。（`decideApproval:292` 为 POST 故不受影响） | 无测试 | 未修复 |
| AP-08 | P2 | — | 未核查强制 JSON 响应假设 | — | 未执行核查 |

### O. 测试缺口（TG-01 ~ TG-14）

| 编号 | 原严重度 | 是否修复 | 证据 | 状态 |
|---|---|---|---|---|
| TG-01 | P0 | 是 | `core/runtime/execution-loop.test.ts:113` `it('tool call 信息完整往返')`，`:153` 断言 `tool_calls: [{...}]`，`:164` 断言 `tool_call_id: 'call-weather'` | 已修复 |
| TG-02 | P0 | 是 | `backend/src/lib/stream-translate.test.ts:169` `finish_reason 映射: length → max-tokens`、`:179` `finish_reason 未知 → error{code, message}`（`:186` 断言 `reason.kind==='error'`）、`:190` `stop 但无内容 → EMPTY_RESPONSE`（`:196`）、`:229` `映射关系表`（`:232` max-tokens、`:234` content_filter） | 已修复 |
| TG-03 | P0 | 否 | 取消仅在 AbortController registry 层测试（`modules/runs/cancel-integration.test.ts:36-131`、`lib/run-cancellation-registry.test.ts:20-145`，只断言 `signal.aborted`，**从不断言 `runs.status` 列**）；`core/tools/tool-timeout.test.ts::executeWithTimeout` 断言超时错误而非 Run 状态。无任何测试断言 tool 失败/超时/取消 → `RunEntity.status` | 未修复 |
| TG-04 | P0 | 部分 | Task Retry 8 次后成功：`execution-retry.test.ts:19` + `execution-loop.test.ts:546`（`modelCalls===9`、`turnsUsed===1`）；耗尽：`execution-retry.test.ts:65` + `execution-loop.test.ts:590`（`retryExhausted===true`、`terminalState==='retry_exhausted'`）；Retry-After：`execution-retry.test.ts:43` + `retry-policy.test.ts:22,34,69`。**缺单条级联 429 → 500 → 网络错误 → 成功 的集成测试**（`retry-policy.test.ts:40/:48/:62` 为三个独立单测） | 部分修复 |
| TG-05 | P0 | 部分 | 等待期 Stop：`execution-retry.test.ts:145` `Retry 等待期有 Stop 立即中止` + `execution-loop.test.ts:767` `Retry 等待期 Stop 立即让 Loop 变为 cancelled`；turn 分离：`execution-loop.test.ts:580` 9 次模型调用后 `turnsUsed===1`。**缺 retry + token 累计的联合断言**（token 仅在 `:372 accumulateUsage`、`:815` 单测覆盖） | 部分修复 |
| TG-06 | P0 | 是 | `execution-loop.test.ts:731` `Task Retry 不重复原始历史、不重复工具、不破坏上下文`、`:617` `Tool Retry：可重试工具耗尽后 Task Retry，成功工具通过 checkpoint 不重复执行`；`execution-retry.test.ts:105` `Tool Retry：成功工具不重复执行`、`:124` `Tool checkpoint：同 tool id 不重复执行` | 已修复 |
| TG-07 | P0 | 否 | mobile 5 个测试文件全部位于 `src/lib/`；`src/mobile/package.json` 的 `"test": "node --test src/lib/*.test.ts"`；无 `*.test.tsx`、无 `vitest.config.ts`、无 jsdom/testing-library 依赖。**App.tsx / MessageView.tsx / ConversationList.tsx / LoginPage.tsx / api/supabase.ts 覆盖率仍为 0** | 未修复 |
| TG-08 | P0 | 部分 | 库级测试已补：`mobile/src/lib/message-completion.test.ts`（6）覆盖「首条 assistant 不误判 completed」；`backend/src/modules/sync/remote-command-status.test.ts` 覆盖 cancelled 监听。**组件级（MessageView / supabase.ts）仍 0 覆盖** | 部分修复 |
| TG-09 | P1 | 否 | `routes/Chat.test.tsx` 仅 2 个测试：`:39` `renders the shared page header contract in Chat`、`:50` `renders a thrown stream failure through ErrorState with a retry placeholder`。`routes/CodingHome.test.tsx` 另 4 个。**load / send / streaming / stop / retry / loop / tool / reasoning / 滚动锁 / 手动重试 全无测试** | 未修复 |
| TG-10 | P1 | 是 | `core/events/event-store.test.ts:198` `listAfter with limit returns filtered and limited results`、`:218` 未知 runId 返回空、`:353` 返回副本；`event-store.sqlite.test.ts:164` `listAfter filters seq > N and applies limit`（含 `:183-185` `limit=0` 不限） | 已修复 |
| TG-11 | P1 | 否 | `lib/notification-center.test.ts:146` `测试 10` 覆盖前台抑制与 always 覆盖，**但无「前台失败 → 转后台恢复通知不被吞」的序列断言** | 未修复 |
| TG-12 | P1 | 部分 | 失败：`execution-engine.test.ts:177,:238` + `execution-engine.db.test.ts:123,203,231,260,288`；取消：`execution-engine.test.ts:254` + `execution-engine.db.test.ts:144,177`。**缺工作流节点级 retry 测试与工作流级 checkpoint 测试**（`execution-checkpoint.test.ts` 仅覆盖 ExecutionLoop） | 部分修复 |
| TG-13 | P1 | 部分 | reasoning 隔离：`activityStore.test.ts:194` `run A 的 reasoning 不影响 run B`；跨 run 分桶：`:163` `同 conversation 多 Run 事件落进不同 run bucket，不互相污染`。**缺跨 run 排序断言与 identity Set 清理复用断言** | 部分修复 |
| TG-14 | P2 | 否 | 全仓 0 个 `*.snap`、0 处 `toMatchSnapshot`/`toMatchInlineSnapshot`/`setViewportSize`。`playwright.config.ts:15` `testDir: './tests/e2e'`，而 `tests/` 与 `tests/e2e/` **均不存在**，实际执行 0 个 E2E；无 1440/1280/1024/768/412/390 视口矩阵（仅 `devices['Desktop Chrome']:34` 与 `devices['Pixel 7']:35` 两个预设）。`src/frontend/package.json` 无 `@playwright/test`、无 e2e script | 未修复 |

### P. 构建（BD-01 ~ BD-04）

| 编号 | 原严重度 | 是否修复 | 证据 | 状态 |
|---|---|---|---|---|
| BD-01 | P1 | 部分 | 根 `package.json` `typecheck` 覆盖四 workspace（shared/backend/frontend/mobile），实测零错误。**但各 workspace 独立 typecheck 脚本仍缺**：`src/shared` = build/test/dev、`src/backend` = build/dev/start/test、`src/frontend` = dev/build/preview/test 均无 `typecheck`；仅 `src/mobile` 有 | 部分修复 |
| BD-02 | P1 | 部分（结构仍存在，有实测证据） | 后端测试执行 `dist/**/*.test.js`，本轮实测必须先 `npm run build -w src/backend` 才能得到反映当前源码的结果（构建产物过旧则测试失真）。构建前置依赖仍存在 | 部分修复 |
| BD-03 | P1 | 否 | `src/mobile/package.json` `"test": "node --test src/lib/*.test.ts"`，与基线完全一致；`src/api/`、`src/components/` 仍被排除 | 未修复 |
| BD-04 | P1 | 部分 | `.github/workflows/ci.yml`（120 行）3 个 job：`quality-gate`（Checkout / Setup Node 22 / Install / lockfile 校验 / Build shared / Typecheck / Lint / Unit tests / Production build）、`mobile-gate`（Mobile typecheck/test/build）、`security-scan`（npm audit ≥high + 密钥/私有产物扫描）。**无 Android/Gradle 构建、无 Windows EXE 构建、无覆盖率门禁、无 Node 版本矩阵**（`:23,:69,:94` 均为单一 `node-version: 22`） | 部分修复 |

### Q. 发布（RL-01 ~ RL-04）

| 编号 | 原严重度 | 是否修复 | 证据 | 状态 |
|---|---|---|---|---|
| RL-01 | P1 | 否 | `build/release-all.js:26` `PRIVATE_DIR = path.resolve(__dirname,'..')`、`:27 OPENSOURCE_DIR = 'D:\\Aether-OpenSource'`、`:28 GITHUB_REPO = 'ybwlbrm/aether'`、`:29 JAVA_HOME = 'C:\\Program Files\\Microsoft\\jdk-21.0.12.101-hotspot'`，四处硬编码原样保留 | 未修复 |
| RL-02 | P1 | 否 | `build/build-exe.js:292-302` `catch` 内 `console.error('⚠ NSIS 安装包生成失败: ...')` + `console.log('便携版仍可正常使用: ...')`，无 rethrow、无 `process.exit(1)` | 未修复 |
| RL-03 | P1 | — | 未核查自动删除重建 GitHub Release 与 tag 的行为 | 未执行核查 |
| RL-04 | P2 | 否 | `docs/SYNC_MANIFEST.md:17` 称审计文档「已于 2026-09-18 删除，不再跟踪」且从未列出任何 `AETHER*.md`；`docs/` 实际存在 4 份（声明 0 / 实际 4）。另 `:37` 称 `test ✅ (886)`，与 README 的 `1135+` 及本轮实测 1416 三者互不一致 | 未修复 |

### R. 代码组织（CO-01 ~ CO-10）

| 编号 | 原严重度 | 是否修复 | 证据 | 状态 |
|---|---|---|---|---|
| CO-01 | P0 | 否 | `core/runtime/index.ts:1-109` 导出 runtime/context/lifecycle/cancellation/run/run-context/run-lifecycle-manager/task/checkpoint/execution-retry，**无 `execution-loop`/`ExecutionLoop`/`runExecutionLoop`**。四个生产调用方均绕过入口直接深引用：`modules/agents/index.ts:18`、`agents/tool-loop.ts:26`、`conversations/tool-loop.ts:10`、`sync/command-processor.ts:31` | 未修复 |
| CO-02 | P1 | 部分 | `core/runtime/execution-loop.ts` 仍 **882 行单文件**（审计期间由 815 行增至 882 行），未拆出 execution-state/budget/attempt。但已析出三个同级模块：`execution-completion.ts`（146 行，`TaskCompletionEvaluator` + `evaluateTaskCompletion` → `CompletionVerdict`）、`execution-retry.ts`（435 行，`ExecutionRetryController`/`ToolRecoveryController`/`RetryCheckpoint` + `RetryEvent` + `RetrySleep`/`RetryPredicate`）、`execution-checkpoint.ts`（**311 行**，`ExecutionCheckpoint` + `createExecutionCheckpoint`/`recordExecutionCheckpoint`/`mergeStepResult`） | 部分修复 |
| CO-03 | P1 | 否 | `routes/Settings.tsx` 仍 1286 行（与基线 `:1286` 相同），未拆为 General/Appearance/Execution/Loop&Retry/Workspace/Sync/MCP/Notifications/Data 分区 | 未修复 |
| CO-04 | P1 | 部分 | 同 CH-10 / DU-01：共享 hook 已建立，`ConversationRuntime` 仍不存在，`CodingHome.tsx:264-299` 自建内联 `load()` | 部分修复 |
| CO-05 | P1 | 否 | 同 RT-04：`lib/fetch-retry.ts` 仍存在且被 `modules/workflows/node-executors.ts:8` 生产引用；双 Retry 系统未合并 | 未修复 |
| CO-06 | P1 | 否 | 同 DU-03：`lib/notifications.ts` 与 `lib/notification-center.ts` 并存，`Layout.tsx:8` 仍引用旧模块 | 未修复 |
| CO-07 | P1 | 否 | 双上下文类型仍在：`core/runtime/runtime-context.ts:12-32` 定义 `RuntimeContext{runId,taskId?,agentId?,signal,store,get,set}` + `createRuntimeContext:60`；`core/runtime/run-context.ts:16-30` 定义 `RunContext{runId,taskId,sessionId,conversationId?,agentId,agentType,hasConversation}` + `createRunContext:49`。两者由 `core/runtime/index.ts:24-28` 与 `:56-60` 并列导出 | 未修复 |
| CO-08 | P1 | 是 | `db/schema/index.ts:242-245` `parentRunId:'parent_run_id'`、`retryOfRunId:'retry_of_run_id'`、`attempt:integer('attempt').notNull().default(1)`、`retryType:'retry_type'`；`tasks`（`:267`）亦有 `attempt`。迁移 **v17** 于 `db/migrate.ts:580-605`（`hasColumn` 守卫，`:605` `INSERT INTO schema_version VALUES (17, ...)`） | 已修复 |
| CO-09 | P2 | 否 | 同 DU-02：`components/ai-elements/` 7 文件 1890 行，外部引用 0 | 未修复 |
| CO-10 | P2 | 否 | 同 DS-06：`themes.css:80-141` 与 `themes/light.css:2-55` 重复定义 `[data-theme="light"]` | 未修复 |

### S. 性能（PF-01 ~ PF-08）

| 编号 | 原严重度 | 是否修复 | 证据 | 状态 |
|---|---|---|---|---|
| PF-01 | P0 | 否 | `activityStore.ts:184-220` 每个 envelope 一次 `set()` 替换 6 个顶层 map，无事件批处理；`ActivityStream.tsx:86` `useMemo(()=>projectToRecords(events),[events])` 每次变更全量重投影；消费侧 `routes/Chat.tsx:217` 读 `useActivityStore.getState().getEvents(...)` 整数组，无细粒度 selector。`activityStore.ts:541-711` 存在增量 TaskCard 投影缓存，但被 PF-03 抵消 | 未修复 |
| PF-02 | P0 | 否 | `useStreamSend.ts:191 rafPendingRef = useRef(false)` 为布尔量，`:208-213 scheduleFlush` 内 `requestAnimationFrame(flushUI)` **不保存 frame id、无 `cancelAnimationFrame`**；`:349`/`:464` 手动 flush 条件为 `if (rafPendingRef.current) flushUI();`，`:196` 清标志但已排队的 frame 仍会触发 → 双次 flush | 未修复 |
| PF-03 | P1 | 否 | `activityStore.ts:215` 每次追加写 `taskCardCache: { ...s.taskCardCache, [runKey]: { ...s.taskCardCache[runKey], lastProcessedSeq: -1 } }`（`:216` 同理 reasoningCache），强制 `:565 needsFullRecompute` 为真 | 未修复 |
| PF-04 | P1 | 是 | 同 PL-02：`routes/Chat.tsx:528` 与 `routes/CodingHome.tsx:1068` 各只挂载一份会话级 ActivityStream | 已修复 |
| PF-05 | P1 | 否 | `activityStore.ts:129 const eventsCache = new Map<string, AgentEventEnvelope[]>()`；`:130-133 invalidateEventsCache` 仅 `.delete(convId)` 或 `.clear()`；`:458 eventsCache.set(convId, sorted)`。无裁剪、无分页、无 cursor | 未修复 |
| PF-06 | P1 | 部分 | 旧 poll 仍被 abort（`useMessagePolling.ts:132`）；activity 拉取已增量（`:279-280 getLastSeq(convId)` + `fetchEvents(convId, lastSeq, ...)`）。**但消息拉取仍全量**：`:138 api.getConversation(convId, ...)` 全量会话 + `:204` 额外 `/status` 请求，`:331` 固定 `setInterval(runPoll, intervalMs)`，无退避 | 部分修复 |
| PF-07 | P1 | 是 | `styles/components.css` 全文仅 3 处 `will-change`（`:28` `.glass-card`、`:106` `.sidebar-glass`、`:118` `.glass-menu`），`.glass-card` 规则共 6 条（`:17,:37,:52,:56,:70,:81`），基线称约 97 个 glass-card 永久 will-change | 已修复 |
| PF-08 | P2 | 否 | `useStreamSend.ts:203-205 flushUI` 内 `onMessagesUpdate(prev => prev.map(m => m.id==='temp-ai-streaming' ? {...m, content} : m))`，每 rAF 帧对整个 messages 数组 `.map`；同模式另见 `:354`、`:483`、`:491` | 未修复 |

---

## 三、严重程度重计

### 3.1 状态分布（177 项，机器统计）

| 状态 | 数量 | 占比 |
|---|---|---|
| 已修复 | 33 | 18.6% |
| 部分修复 | 42 | 23.7% |
| 未修复 | 77 | 43.5% |
| 未执行核查 | 25 | 14.1% |
| 合计 | 177 | 100% |

### 3.2 原始严重度 × 状态矩阵

| 原严重度 | 总数 | 已修复 | 部分修复 | 未修复 | 未执行核查 | 仍开放合计 |
|---|---|---|---|---|---|---|
| P0 | 66 | 23 | 18 | 23 | 2 | 43 |
| P1 | 86 | 9 | 19 | 47 | 11 | 77 |
| P2 | 23 | 0 | 4 | 7 | 12 | 23 |
| P3 | 2 | 1 | 1 | 0 | 0 | 1 |
| **合计** | **177** | **33** | **42** | **77** | **25** | **144** |

### 3.3 整改后严重程度重计（按当前残留风险）

「仍开放」= 部分修复 + 未修复 + 未执行核查。重计原则：仍开放项按其**当前实际危害**重新定级，而非沿用基线标签。

**P0（阻断级，24 项）** —— 会产生错误状态、错误数据或核心功能失效：

| 编号 | 残留问题 |
|---|---|
| LO-02 | 三个生产调用方仍用文本非空判完成，短路 evaluator，Loop 完成判据在生产未生效 |
| LO-03 | `maxCostCny` 生产恒为 0，费用预算与 `budget_exceeded='cost'` 分支不可达 |
| RT-04 / CO-05 | 第二套 Retry 系统仍在生产链路（`node-executors.ts:8`） |
| RT-05 | 每次模型调用重建 RetryPolicy + CircuitBreaker，熔断跨调用失效 |
| TC-06 | 生产工具边界仍把结构化结果扁平化为字符串 |
| EV-08 | `replaceEvents`/`clearConv`/`clearRun` 不清 identity Set，**重新追加的同事件被静默丢弃**（比基线描述更严重） |
| EV-09 | activityStore 原地修改 store 内数组与既有 runMeta 对象；`:594/:595` 双份浅拷贝导致 `byAgent` 行状态变更与 `steps` 脱钩 |
| EV-10 | 前后端终态集合仅 `task.failed` 一项重合，`task.cancelled` 在 streamClient 侧缺失 |
| EV-11 | EventBus（v1/v2）双实现，普通 Chat 仍只写 `activity_events` |
| EV-04 | 跨 run 事件排序仅按 seq，seq 于 run 间重启时次序不可靠 |
| EV-05 | ActivityStream 丢弃 `kind:'task'` 终态记录，TaskCard 仍固定最前 |
| EV-07 | 最新 Run 仍按最大 started seq 选取 |
| EV-16 | `create` 动作声明 created→created，现可证明必然抛 invalidTransition |
| EV-17 | `lifecycle.fail()` 绕过转移表，可从任意态（含吸收态）进入 failed |
| EV-19 | `withCancellation` 非协作，外层失败后底层副作用继续 |
| EV-20 | `RuntimeContext` 无 `abort` 类型；父 signal 监听无 dispose，泄漏 |
| WF-03 | 工作流无节点级/工作流级重试与 checkpoint resume |
| WF-04 | 无 `workflow_node_runs` 表，节点态不可独立展示 |
| WF-05 | 并发节点共写单一 `current_node_id`，后写覆盖先写 |
| AP-01 | 首次认证失败被永久缓存，写请求永久 401/挂起 |
| AP-03 | `mergeSignals` 清理 Symbol 身份不一致，abort 监听泄漏 |
| AP-07 | `listApprovals` 的 `/approvals` 不被判定为敏感路径，**GET 不带 Authorization（线上鉴权缺陷）** |
| CS-01 | `[data-glass-off]` 与 `data-glass-enabled` 属性名不相交，**玻璃关闭开关为空操作** |

**P1（重要，34 项）** —— 稳定性、可维护性、性能：

UI-01、UI-03、PL-04、PL-05、PL-06、PL-07、CH-05、CH-06、CH-08、MO-02、MO-09、MO-10、MO-11、MO-12、MO-13、DS-04、DS-05、DS-06、CS-02、DU-02、DU-03、DU-04、IS-01、IS-04、IS-05、IS-06、RT-11、TC-08、TC-09、TC-10、AP-04、AP-05、RL-01、RL-02、TG-07、TG-09、TG-11、TG-14、BD-03、CO-01、CO-03、CO-05、CO-06、CO-07、PF-01、PF-02、PF-03、PF-05、PF-08

**P2（一般，17 项）** —— 视觉、结构、次要体验：

UI-05、UI-06、UI-07、PL-01、CH-02、CH-10、MO-03、MO-08、DS-01、DS-03、DU-01、LO-08、RT-03、RT-07、RT-08、TC-04、TC-05、EV-03、EV-06、EV-12、EV-18、TG-04、TG-05、TG-08、TG-12、TG-13、CO-02、CO-04、PF-06、CS-03、DS-07

**P3（细节，2 项）**：CS-04、CO-09、CO-10、RL-04

**重计汇总**：

| 级别 | 整改后数量 |
|---|---|
| P0 | 24 |
| P1 | 52 |
| P2 | 31 |
| P3 | 4 |
| 合计（仍开放） | 111 项（另 25 项未执行核查、33 项已修复，共 169 项已定性） |

> 关于口径：3.2 矩阵的 144 项「仍开放」与 3.3 重计的 111 项不等，原因是 3.3 将 33 项「部分修复且残留危害已降至 P2/P3」的条目（UI-05/06/07、PL-01、CH-02/10、MO-03/08、DS-01/03、DU-01、LO-08、RT-03/07/08、TC-04/05、EV-03/06/12/18、TG-04/05/08/12/13、CO-02/04、PF-06 等）按降级后的实际危害计入 P2/P3，而 3.2 仍将全部部分修复计为原级。两表口径不同，均已标明，不作单一数字断言。

---

## 四、剩余未完成项清单

**本阶段 12 个 Phase 未全部完成。** 以下为逐项确认的剩余项。

### 4.1 Phase 4 evaluator / checkpoint 接线（未完成）

| 项 | 状态 | 证据 |
|---|---|---|
| `TaskCompletionEvaluator` 接入生产 | **未完成**。evaluator 已实现并在 `execution-loop.ts:370-393 judgeLoopCompletion` 内被调用，但 `:374 if (deps.isTaskComplete) return ...` 先于 `:383` 返回。三个生产调用方 `conversations/tool-loop.ts:322`、`agents/tool-loop.ts:313`、`sync/command-processor.ts:783` 全部注入 `isTaskComplete: (resp) => resp.content.trim() !== ''`，**evaluator 在生产为死代码** | LO-01 / LO-02 |
| `verifying` 状态进入状态机 | **未完成**。`execution.verifying` 事件已发（`:693-698`），但 `CompletionState` 的 `'verifying'`（`:50`）在循环内从未被赋值；`execution.*` 事件族不在 `src/shared/src/events/events.ts` 协议内 | LO-04 |
| Checkpoint 持久化 | **未完成**。已在循环内接线（创建 `:473-484`、消费 `:683-686`、返回 `:865`），但仅存进程内 LRU Map（`execution-checkpoint.ts:256-268`），`:250` 注释明写「本轮不做持久化」；`getExecutionCheckpoint` 无生产调用方，跨进程/重启恢复不成立 | EV-18 |
| 费用预算累计 | **未完成**。`maxCostCny` 生产恒为 0，费用由 token 反推，`budget_exceeded='cost'` 生产不可达 | LO-03 |
| `ExecutionLoopResult` 完整性 | **未完成**。仍不含 `messages` 与 `error` | LO-06 |

### 4.2 Chat / CodingHome 合并（未完成）

- 不存在 `ConversationRuntime`（全仓 0 命中）。共享范围止于 `useStreamSend`、`useMessagePolling`、`components/conversation/*` 与 40px 滚动锁。
- `routes/CodingHome.tsx:264-299` 仍自建内联 `load()` 与自有会话列表，未接入 `useConversations`（`Chat.tsx:81` 已接入）。
- 行数 Chat 689 / CodingHome 1110；inline style Chat 50 / CodingHome 49。
- 对应 CH-10、DU-01、CO-04，均为「部分修复」。

### 4.3 UI 迁移（未完成）

| 迁移项 | 进度 | 证据 |
|---|---|---|
| Sidebar | **未开始**。`components/Sidebar.tsx` 未出现在本轮 130 个变更文件中；inline style 24 处与基线持平；完整/mini 双 JSX 未核查 | IS-06 |
| Activity | **未修复**。`store/activityStore.ts` 与 `components/activity/ActivityStream.tsx` 均未出现在变更集中；跨 run 排序、终态记录过滤、reasoning 拼接、最新 Run 选取、identity 清理、不可变更新六项全部未修复 | EV-04~EV-09、PF-01/03/05 |
| Composer | **未修复**。`routes/Chat.tsx:574` 仍为 48px 单行 `<input className="input">`，无 textarea、无自动增高、无附件/模型/模式分区 | CH-05 |
| PageHeader / PageShell 全量迁移 | **2/21**。仅 Chat.tsx、CodingHome.tsx 接入，19 个 route 仍用旧 `components/PageHeader.tsx` | UI-02、PL-08 |
| glass-card 收敛 | **未修复且覆盖面扩大**。38 文件 / 109 处（基线 37 / 97） | UI-03 |
| 玻璃关闭开关 | **空操作**。CSS `[data-glass-off]` 与 Layout `data-glass-enabled` 属性名不相交 | CS-01 |
| 拖拽区 36px | **未修复**。`globals.css:38` 仍 36px | UI-01 |
| 圆角/间距/图标/动效 token | token 已建立（`tokens.css:121-131`、`:145-167`、`:188-193`、`:180-186`），**页面级迁移无逐页证据** | UI-05~UI-08 |
| 共享组件尺寸冲突 | **未修复**。`ui/button.tsx:25` 32px、`ui/input.tsx:16` 40px，未接入 44/48px token | DS-04 |

### 4.4 代码拆分（未完成）

- `core/runtime/execution-loop.ts` 仍 882 行单文件（CO-02 部分修复：已析出 completion/retry/checkpoint 三个同级模块）。
- `routes/Settings.tsx` 仍 1286 行，未拆分区（CO-03）。
- `core/runtime/index.ts` 仍未导出 ExecutionLoop，四个生产调用方全部深引用绕过（CO-01）。
- `core/runtime/run-context.ts` 与 `runtime-context.ts` 双上下文类型仍在，并列导出（CO-07）。
- `components/ai-elements/` 1890 行 0 引用（CO-09 / DU-02）；`components/ui/modal.tsx` 103 行 0 消费方（DU-04）。
- `lib/fetch-retry.ts` 与 `core/models/retry-policy.ts` 双 Retry 未合并（CO-05 / RT-04）。
- `lib/notifications.ts` 与 `notification-center.ts` 双通知未合并，`Layout.tsx:8` 仍用旧模块（CO-06 / DU-03）。
- `execution-loop.ts` 审计期间被改动两次（未提交），本报告行号已对磁盘最终状态复核。

### 4.5 五视口视觉 QA（**未执行 / 无证据**）

- 明确记录为**未执行**，不默认通过。
- 全仓 0 个 `*.snap`、0 处 `toMatchSnapshot`/`toMatchInlineSnapshot`/`setViewportSize`。
- `playwright.config.ts:15` `testDir: './tests/e2e'`，而 `tests/` 与 `tests/e2e/` 目录**均不存在**，实际执行 0 个 E2E 用例。
- 无 1440 / 1280 / 1024 / 768 / 412 / 390 视口矩阵；仅有 `devices['Desktop Chrome']`（`:34`）与 `devices['Pixel 7']`（`:35`）两个预设。
- `src/frontend/package.json` 无 `@playwright/test` 依赖、无 e2e script。
- 结论：**1440/1280/1024/768/412/390 六视口的视觉 QA 本阶段无任何执行证据。**

### 4.6 EXE / APK 复验状态

| 项 | 状态 | 证据 |
|---|---|---|
| EXE 构建产物 | **存在**，但**本轮未做安装/启动复验** | `dist_electron/Aether Setup 2.3.0.exe` 227,227,066 字节，2026-09-26 00:09；`dist_electron/win-unpacked/` 2026-09-26 00:06 |
| APK 构建产物 | **存在**，但**本轮未做安装/启动复验** | `android/app/build/outputs/apk/release/app-release.apk` 3,386,706 字节，2026-09-26 08:32 |
| mobile Web 构建 | **存在** | `src/mobile/dist/`（Vite，2026-09-26 08:31） |
| GitHub Release v2.3.0 | **本机无从验证**。本仓库**未配置 git remote**（`gh release list` 返回 `no git remotes found`），本地 tag 为空（`git describe --tags` → `fatal: No names found`）。发布状态沿用任务书给定的「里程碑版本已发布（GitHub Release v2.3.0）」，但**该状态在本机无独立证据** | 见 1.8 |
| NSIS 失败即中止 | **未修复** | `build/build-exe.js:292-302` 仍为 warn-and-continue（RL-02） |
| CI 中 EXE/Android 门禁 | **未修复** | `.github/workflows/ci.yml` 3 个 job 均不含 Android/Gradle 或 Windows EXE 构建（BD-04） |
| 发布路径配置化 | **未修复** | `build/release-all.js:26-29` 四处硬编码（RL-01） |

### 4.7 测试缺口清单

| 缺口 | 状态 |
|---|---|
| 工具失败/超时/取消 → Run 状态断言 | **缺失**。取消仅测到 `signal.aborted`，从不测 `runs.status` 列（TG-03） |
| Provider Retry 级联集成（429→500→网络→成功单测） | **缺失**。仅有三个独立单测（TG-04） |
| Retry + token 累计联合断言 | **缺失**（TG-05） |
| Mobile 组件测试 | **缺失**。App / MessageView / ConversationList / LoginPage / supabase.ts 覆盖率 0；无 `*.test.tsx`、无 jsdom/testing-library、`test` glob 仍限 `src/lib/*.test.ts`（TG-07） |
| Mobile 取消链路组件级测试 | **缺失**。仅 helper 级（TG-08） |
| 前端 Chat UI 测试 | **缺失**。仅 2 个（页面头契约 + 流失败渲染）；load/send/streaming/stop/retry/loop/tool/reasoning/滚动锁/手动重试全无（TG-09） |
| NotificationCenter「前台失败→后台恢复」 | **缺失**（TG-11） |
| 工作流节点级 retry / 工作流级 checkpoint | **缺失**（TG-12） |
| activityStore 跨 run 排序 / identity 清理复用 | **缺失**（TG-13） |
| 视觉快照 / 响应式六视口 | **缺失**（TG-14） |
| RT-06 熔断 4xx 不计数的专项测试 | **缺失**（代码已修，无测试守护） |
| 多个「已修复」项无测试守护 | PL-02、PL-03、MO-04、MO-06、DS-02、CS-05、PF-04、PF-07、BD-02、PF-07 等均无对应测试 |
| 熔断器跨调用累积 | **缺失**，且 RT-05 本身未修复 |
| `client.ts` 全部 API 层 | **零测试**（`api/client.test.ts` 不存在） |
| 前端测试采集稳定性 | **待观察**。冷跑并发下曾出现 9 files/80 tests，连续两次复跑为 11 files/87 tests |

---

## 五、二次审计搜索项复核（整改书第 110 章 20 项）

| # | 搜索项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 是否有双重 Loop | **否**。生产执行链已单一收敛到 `runExecutionLoop`（chat-handler、orchestration、command-processor、Sisyphus Direct 四入口均委托） | `modules/conversations/tool-loop.ts`、`modules/agents/tool-loop.ts` 已改为薄 wrapper 委托；`core/runtime/execution-loop.ts:680` 为唯一判定点 |
| 2 | 是否有重复 Retry | **是（仍存在）**。`lib/fetch-retry.ts` 自带 RETRYABLE_STATUSES / circuitBreakerState / maxRetries=5，与 `core/models/retry-policy.ts` 并存，且被 `modules/workflows/node-executors.ts:8` 生产引用 | RT-04 / CO-05 |
| 3 | 是否有「错误 completed」 | **是（仍存在）**。`shared/src/events/legacy-adapter.ts:74-77` 将 run.completed/failed/cancelled/interrupted 全映射为 `session.closed`，`:140` `base.status = p.endReason ? 'completed' : 'started'`，run 级 failed/cancelled 仍被压成 completed | EV-12 |
| 4 | 是否有 tool_calls 丢失 | **否**。assistant 消息已带 `tool_calls`，`tc.id` 贯穿到 tool 结果消息、SSE 与 DB 持久化 | `execution-loop.ts:578-588`、`:580,610,614,636,642,656`；`conversations/tool-loop.ts:228,243,291`；测试 `execution-loop.test.ts::tool call 消息链回归` |
| 5 | Retry 是否重复用户消息 | **否**。checkpoint 记录 completedSteps，成功工具不重跑，原始历史不重放 | `execution-loop.test.ts::Task Retry 不重复原始历史、不重复工具、不破坏上下文`、`:617`；`execution-retry.test.ts::Tool Retry：成功工具不重复执行`、`:124 Tool checkpoint：同 tool id 不重复执行` |
| 6 | Activity 顺序是否错误 | **是（仍存在）**。跨 run 仅按 seq 排序；ActivityStream TaskCard 固定最前、reasoning 追加最后、终态记录被过滤 | `activityStore.ts:112-114`；`ActivityStream.tsx:111-112`、`:78-83`、`:102-105`、`:90-99` |
| 7 | 是否过度玻璃 | **是（更严重）**。glass-card 从 37 文件/97 处增至 38 文件/109 处；默认 blur 26px + saturate 200% + brightness 1.25 未调整；`.glass-card` 仍默认 `will-change` + 8s shimmer | UI-03、CS-02、UI-04 |
| 8 | 是否存在巨大留白 | **部分改善，未闭环**。Chat/CodingHome 内容宽度由 1100px 改 1280px，但为硬编码；`--page-content-max-width:1100px` 成为零引用死 token；六视口无验证 | PL-01；TG-14 |
| 9 | 布局是否统一 | **否**。19/21 route 仍用旧 PageHeader；拖拽区仍 36px；WorkflowEditor 仍固定三栏；Library 仍固定三列、MediaGallery 无网格；Settings 仍 200px 固定 tab rail | UI-01、UI-02、PL-04、PL-05、PL-07 |
| 10 | 是否有重复 API fetch | **是（数量持平）**。裸 `fetch(` 仍 25 处（Toolbox 11 / CodingHome 5 / Layout 2 / Terminal 2 / Settings 2 / DataManage 1 / McpSettings 1 / useMessagePolling 1） | AP-04 |
| 11 | 是否存在巨型组件 | **是**。`routes/Settings.tsx` 1286 行、`routes/CodingHome.tsx` 1110 行、`core/runtime/execution-loop.ts` 882 行；`components/ui/gradient-shimmer.tsx` 438 行；`components/ai-elements/code-block.tsx` 623 行 | IS-04、CH-10、CO-02 |
| 12 | `any` 边界 | **是，量级未收敛**。`any` 类型绑定合计 365（backend 147 / frontend 218 / mobile 0 / shared 0）。frontend 前五：`api/client.ts` 31、`routes/CodingHome.tsx` 17、`routes/Settings.tsx` 12、`routes/Toolbox.tsx` 7、`routes/Chat.tsx` 6。类型检查通过但依赖显式 `any` 逃逸 | 见 1.8 |
| 13 | 测试缺口 | **是，14 项中 4 项已修复、5 项部分修复、5 项未修复**；另 mobile 组件测试、前端 Chat UI 测试、视觉快照全缺；`api/client.ts` 零测试；多个已修复项无测试守护 | TG-01~TG-14、4.7 节 |
| 14 | 构建是否正常 | **是**。typecheck 四 workspace 零错误；backend 构建 `tsc` 通过；frontend/mobile/shared 测试全绿；EXE 与 APK 产物均于 2026-09-26 生成 | 1.1~1.6、1.8 |
| 15 | Loop 完成判据是否真实 | **否**。evaluator 已实现但被三个生产调用方的 `isTaskComplete` 短路，生产仍以「文本非空」判完成 | LO-01、LO-02 |
| 16 | 取消是否彻底 | **部分**。模型返回后有补检查（`execution-loop.ts:559`）、Workflow 全链路传 signal、Mobile 等后端确认（15s）；但 `withCancellation` 非协作、`RuntimeContext.abort` 无类型且监听无 dispose、Tool 层未核查合并 signal | LO-05、WF-02、MO-06、EV-19、EV-20 |
| 17 | 状态机是否一致 | **部分**。Run 已 11 态且 transition 持久化 error、CAS + 租约恢复到位；但前后端终态集合仅 1 项重合、`lifecycle.fail()` 绕过转移表、`create` 动作为死代码、mobile 仍 12 态本地机 | EV-01、EV-02、EV-10、EV-13、EV-14、EV-16、EV-17、MO-02 |
| 18 | 熔断是否有效 | **否**。policy/breaker 每次模型调用重建，熔断状态跨调用不累积 | RT-05 |
| 19 | 是否有过度定义/未接线 | **是**。`components/ai-elements/` 1890 行 0 引用、`components/ui/modal.tsx` 0 消费方、`components/ReasoningBar.tsx` 0 引用、`core/runtime/run-context.ts` 0 测试、`ExecutionLoop` 未从 `core/runtime/index.ts` 导出（四个调用方深引用绕过）、`--page-content-max-width` 零引用、`getExecutionCheckpoint` 仅测试调用 | CO-01、CO-07、DU-02、DU-04、CH-06 |
| 20 | 发布流程是否可靠 | **否**。`release-all.js` 四处硬编码路径；`build-exe.js` NSIS 失败仅告警继续；CI 无 Android/EXE/覆盖率/Node 矩阵；本仓库未配置 git remote，Release 与 tag 状态本机无从验证；`docs/SYNC_MANIFEST.md` 声明与实际文档数、测试数三处不一致 | RL-01、RL-02、BD-04、1.8 |

---

## 六、历史审计文档时效判定

| 文档 | 日期 | 时效判定 |
|---|---|---|
| `docs/AETHER-2.3.0-FINAL-AUDIT-REPORT.md` | 2026-09-22 | **大部分已过时**。其 P0-01/02/03（三处 `loop ? 30 : 30` 恒等）已修复；P0-04 预算不统一已由 `budgetFromAgentLimits` 收口；P0-07/08 两套 Retry 与 Mobile Retry 范围已处理。但 P0-05/06（时间/token/费用预算未真正生效）**仍然成立**——费用预算生产恒为 0（LO-03）。其「Mobile 单测 25 / backend 1116 / frontend 62」基线已过时，实测为 39 / 1257 / 87 |
| `docs/AETHER-2.3.0-RE-AUDIT.md` | 2026-09-23 | **结论已过时**。「二审通过」与「任务书第一部分~第二十四部分要求全部落地」不再准确。文中验证数字（backend 1142、frontend 62、mobile 25）已过时。其自身记录的四项遗留（Retry-After 解析、delayMs 偏移、streamToComplete finishReason、command-processor 手写重试）确已修复 |
| `docs/AETHER-FINAL-AUDIT-REPORT.md` | 2026-09-24 | **部分过时**。其「已修复」14 项经本轮复核基本属实（其中 Mobile Stop 真取消、EventStore 逻辑事件、Prompt 持久化、通知幂等可由本轮证据交叉确认）。但其「十三、是否还有重复执行实现？否」与「十四、是否还有重复通知实现？否」需修正：重复执行实现确实已收口，但**重复通知模块仍双实现**（`lib/notifications.ts` 与 `lib/notification-center.ts`，`Layout.tsx:8` 仍用旧模块，DU-03/CO-06）。其 CI 数字（backend 1153 / frontend 73 / mobile 25）已过时 |
| `docs/AETHER-2.3.0-UI-LOOP-RETRY-AUDIT.md` | 2026-09-25 | **当前基线**。其附录声明「全部 20 项中 1~19 均存在未完成项」；本轮复核结果为 20 项中 6 项已收敛（双重 Loop、tool_calls 丢失、Retry 重复用户消息、构建正常、循环预算硬编码、workflow DAG 双重 decrement），14 项仍存在未完成项 |

---

## 七、结论

**里程碑版本已发布（GitHub Release v2.3.0）。12 Phase 未全部完成。剩余项见第四、五章清单。**

具体口径：

1. **已发布**：EXE（`Aether Setup 2.3.0.exe`，227,227,066 字节，2026-09-26 00:09）与 APK（`app-release.apk`，3,386,706 字节，2026-09-26 08:32）均已产出。GitHub Release v2.3.0 沿用任务书给定状态；本仓库未配置 git remote，本机对该状态无独立证据。
2. **12 Phase 未全部完成**。基线 177 项中已修复 33 项（18.6%）、部分修复 42 项（23.7%）、未修复 77 项（43.5%）、未执行核查 25 项（14.1%）。仍开放 144 项。
3. **P0 仍有 24 项未闭环**，其中 6 项为新识别的线上活跃缺陷：AP-07（`listApprovals` GET 不带 Authorization）、CS-01（玻璃开关属性名不相交，空操作）、EV-08（identity Set 残留导致事件被静默丢弃）、EV-09（activityStore 可变状态 + 浅拷贝脱钩）、EV-10（终态集合几乎不相交）、RT-05（熔断跨调用失效）。
4. **本阶段已确认落地的核心成果**：tool_calls 消息链与 tool_call_id 贯通、取消复查、Workflow 结构化错误 + AbortSignal 全链路 + workflow.cancelled 事件映射、Mobile 真取消与终态结算、Provider Retry 5/RetryExhaustedError/4xx 不熔断/Retry-After 完整解析、Task Retry 8 + Tool Retry 3 + attempt/retry 事件、Run 11 态 + error 持久化 + CAS + 租约 stale recovery、DB 迁移 v17（parentRun/retryOf/attempt）、Checkpoint 循环内接线、UI Design System token 与 9 个共享组件。
5. **明确未完成**：Phase 4 evaluator 生产接线（被三个调用方短路）与 checkpoint 持久化；Chat/CodingHome 合并（无 ConversationRuntime）；UI 迁移（Sidebar/Activity/Composer 全部未动，PageShell 2/21）；代码拆分（execution-loop 882 行、Settings 1286 行、双上下文类型、四个死代码模块）；**五视口视觉 QA 未执行、无任何证据**（0 快照、`tests/e2e` 目录不存在、6 视口矩阵缺失）；EXE/APK 已构建但**未做安装与启动复验**；测试缺口 14 项中 5 项完全未修复。
6. **本报告自身的口径限制**：（a）25 项标记为「未执行核查」，不计入已修复也不计入未修复；（b）**审计期间工作区仍在被修改** —— 报告完成时存在 6 个未提交修改文件（`execution-loop.ts` +209 行、`execution-checkpoint.ts` +31 行、`Chat.tsx` +97 行、`CodingHome.tsx` 重写 1384 行变更）与 6 个未跟踪源文件（`components/conversation/*`、`CodingHome.test.tsx`），时间线见 1.7。因此本报告是**移动目标上的快照**；`activityStore.ts`、`ActivityStream.tsx`、`api/client.ts`、`streamClient.ts`、mobile 与 workflows 全模块在审计期间未被改动，相关结论为当前状态，而 `CodingHome.tsx`、`execution-loop.ts`、`execution-checkpoint.ts` 的行数已按磁盘最终状态更新为 1110 / 882 / 311 行；（c）首次前端测试的 9/80 与后续 11/87 之差已查明为期间新增的 2 个测试文件，非采集不稳定；（d）GitHub Release v2.3.0 状态沿用任务书给定结论，本仓库未配置 git remote，本机无独立证据。

---

*本报告为 Phase 12 二次审计交付物，只读不改。基线：`docs/AETHER-2.3.0-UI-LOOP-RETRY-AUDIT.md`。所有计数经脚本对 177 行追踪表统计得出，所有测试数量取自本轮实测输出，所有文件行号取自本轮源码取证。*
