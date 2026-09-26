# Aether 2.3.0 UI + Loop + Retry 全项目整改审计报告

> 阶段：Phase 1（完整审计，只读不改）
> 日期：2026-09-25
> 范围：backend / frontend / mobile / shared / docs / build / CI
> 说明：本报告为整改执行前的基线快照。所有问题均带文件与行号证据；严重程度分级 P0/P1/P2/P3 依整改书定义。

---

## 严重程度统计

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 24 | 会产生执行错误 / 状态错误 / 数据错误 / 核心功能错误 |
| P1 | 37 | 明显影响稳定性、体验、可维护性或性能 |
| P2 | 18 | 视觉、代码结构、次要体验优化 |
| P3 | 3 | 非必要细节优化 |

---

## A. UI 总体问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| UI-01 | P1 | `src/frontend/src/styles/globals.css:34-39` | 全站 36px 拖拽层覆盖所有标准页面顶部 | Electron 拖拽区设计未做页面安全区 | 标题/按钮被遮挡，点击穿透 | 建立 Safe Header / PageShell 统一顶栏，拖拽区只保留 12px | Layout、所有 routes | 是（布局快照） |
| UI-02 | P1 | 全部 routes | 页面顶部结构不统一：标准 PageHeader 36px/32px、CommandCenter 48px/32px、CodingHome 初始 18vh | 各页面各自实现标题 | 视觉层级漂移 | 统一 PageHeader（Title + Description + Actions），高度稳定 | 全部 routes | 否 |
| UI-03 | P1 | `components.css:17-97` | `glass-card` 实际挂载 97 处、37 个 TSX 文件 | 处处套玻璃 | 层级多、边框多、视觉密度高 | 玻璃只保留 Sidebar/Composer/Modal/Toolbar，其余用普通 Surface | 全部页面 | 否 |
| UI-04 | P1 | `components.css:28,76-97` | 97 个 glass-card 永久 `will-change` 并运行 8s shimmer | 定义过重 | 性能与动效过度 | 分离"玻璃表面"与"内容表面"，动画收敛至 micro/normal | components.css | 否 |
| UI-05 | P2 | 多页面 | 同一页面同时出现 8/10/12/14/16/18/20/24/28px 圆角 | 无统一圆角 token 强制 | 视觉漂移 | 按 radius-xs/sm/md/lg/xl 收敛 | tokens.css + 各页面 | 否 |
| UI-06 | P2 | 多页面 | 间距 6/7/9/14/18/22/26/36/44px 散落 | 无统一间距约束 | 节奏不一致 | 间距收敛到 4-8-12-16-20-24-32-40-48-64 | 各页面 | 否 |
| UI-07 | P2 | 各页面 | 图标尺寸不一致（24/28/32/36/40/48px） | 无 icon token | 层级混乱 | 统一 icon 16/18/20/24/32px | 各页面 | 否 |
| UI-08 | P3 | 多页面 | 动画时长不统一，部分普通 UI 动画超过 500ms | 无动画 token | 节奏不齐 | micro 120ms / normal 180ms / panel 220ms / page 260ms | 各页面 | 否 |

---

## B. 页面布局问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| PL-01 | P0 | `routes/Chat.tsx:394-397` | 内容总宽 1100px 受限，消息/Composer 达不到 820-880px | 全局 max-width 设计 | 大屏大量空白、正文偏窄 | 页面 max-width 1180-1280px，左右留白 ≥24px | Layout、Chat | 是（视觉 QA） |
| PL-02 | P0 | `routes/Chat.tsx:545-551` | 完整 ActivityStream 在每条用户消息后重复渲染 | 事件与消息无关联绑定 | N 条消息 N 份活动树，重复且低效 | Activity 按 Run 挂载，每个 Run 一次 | Chat、ActivityStream | 是 |
| PL-03 | P0 | `routes/CodingHome.tsx:647-648,753-755` | 每轮发送调用 clearConv 清空整个会话 Activity | 注释声称"仅当前轮"但实现全清 | 历史执行过程丢失 | 只清当前 Run 的事件 | CodingHome、activityStore | 是 |
| PL-04 | P1 | `routes/Workflows/WorkflowEditor.tsx:126` | 编辑器固定 `200px 1fr 300px` 三栏 | 无响应式 | 窄屏不可用 | 窄屏改横向堆叠 | WorkflowEditor | 是 |
| PL-05 | P1 | `routes/Library.tsx:103,169`、`routes/Media/MediaGallery.tsx:141,154` | 分类/内容固定三列 | 无网格响应式 | 窄屏压缩 | grid auto-fill minmax | Library、Media | 否 |
| PL-06 | P1 | `routes/Terminal.tsx:26-30` | 新输出总是强制滚底 | 无用户上滑锁 | 用户查看历史被干扰 | 复用 Chat 的 40px 滚动锁 | Terminal | 否 |
| PL-07 | P1 | `routes/Settings.tsx:944-955` | 200px 固定 Tab rail，无窄屏折叠 | 桌面优先 | 768px 以下拥挤 | 窄屏横向滚动 Tab | Settings | 是 |
| PL-08 | P1 | 多页面 | 页面依赖 window 滚动，无统一 page shell/header/content/footer 结构 | 无 PageShell 抽象 | body+内部多级滚动 | 建立 PageShell 滚动契约 | 全部 routes | 否 |
| PL-09 | P2 | `routes/Browser.tsx:48-58` | 跨域 iframe 访问与 X-Frame 拦截被同一判断处理 | 判断不严谨 | 正常跨域站点被误报阻止 | 区分网络错误与 CSP 拦截 | Browser | 否 |

---

## C. Chat UI 问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| CH-01 | P0 | `routes/Chat.tsx:304,326,335` | URL 直达路径把"未配置 Provider"和请求失败创建为 assistant 消息 | 错误路径写入消息 | 失败伪装成 AI 回复 | 失败走 execution status 区，与 assistant 消息分离 | Chat、useStreamSend | 是 |
| CH-02 | P0 | `hooks/useStreamSend.ts:299-309,404-414,448-462` | 网络错误/断流/stream-truncated 被追加到 AI 正文 | 错误处理复用文本流 | 用户看到"AI 说错误" | 错误独立渲染，正文只含真实输出 | useStreamSend、Chat、CodingHome | 是 |
| CH-03 | P0 | `routes/Chat.tsx:201-207` | 失败/停止后的 `onSendEnd(false)` 被忽略，本地 sending/thinking 残留 | 回调状态未复位 | 按钮保持发送态 | Hook 统一暴露 idle/sending/running/retrying/verifying/completed/failed | Chat、useStreamSend | 是 |
| CH-04 | P1 | `routes/Chat.tsx:37-58` | 用户消息 75% 全色背景；AI 也是 75% 且无 820-860px 上限 | 无消息宽度 token | 对比过强、正文过窄 | 用户 68-72% 轻 accent surface，AI 最大 820-860px | Chat、CodingHome | 是（视觉 QA） |
| CH-05 | P1 | `routes/Chat.tsx:597-614` | Composer 仅 48px 单行 | 未按整改目标实现 | 无附件/模型/模式分区 | 116-136px composer，上 textarea 下左工具右模式/模型/发送 | Chat、Composer 组件 | 是 |
| CH-06 | P1 | `routes/Chat.tsx:140,205,210,242` | liveReasoning 已维护但没有任何 JSX 渲染 | ReasoningBar 未接入 | 推理过程只能看 Activity | 轻提示"正在处理 · 12s → ▼ Think"，展开 220-280px | Chat、ReasoningBar | 是 |
| CH-07 | P1 | `routes/Chat.tsx:363-374` | 自动滚动不感知 Activity 高度变化 | effect 依赖不含 activity | 过程区增长后不再贴底 | 依赖加入 run/activity seq | Chat | 是 |
| CH-08 | P1 | `routes/Chat.tsx:507` | 整个流式消息列表 `aria-atomic` | 无障碍错误 | 读屏频繁朗读 | 改为 aria-live polite 细粒度 | Chat | 否 |
| CH-09 | P1 | `routes/Chat.tsx:592-596` | 自动 retry 只有一行状态文本，无"重试生成"按钮 | 无 Manual Retry | 用户无法手动恢复 | 失败区提供 [立即重试]/[查看过程]/[复制错误] | Chat | 是 |
| CH-10 | P1 | `routes/CodingHome.tsx:595-874` | CodingHome 独立重写发送、流式、停止、错误、loop、reasoning | 双页面两套实现 | 行为漂移、维护成本翻倍 | 收敛为共享 ConversationRuntime + ConversationComposer | CodingHome、Chat | 是 |
| CH-11 | P1 | `routes/Chat.tsx:33-35` | 消息入场延迟随索引增长且未封顶 | 动画 index*60ms | 长对话尾部延迟 | 延迟封顶 200ms | Chat | 否 |
| CH-12 | P2 | `routes/Chat.tsx:399-402` | 会话栏 288px（目标 260-280px） | 常量未调整 | 偏差 8px | 调至 260-280px | Chat | 否 |

---

## D. Mobile UI 问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| MO-01 | P0 | `MessageView.tsx:273-308` | 第一条 assistant 行即判定 completed | 以"出现 assistant 消息"推断终态 | 桌面还在 retrying/verifying 时手机已显示完成并可继续发 | 以共享 Run 终态事件/命令终态为准 | MessageView、supabase | 是 |
| MO-02 | P0 | `MessageView.tsx:169-181` | 本地状态机为 idle/sending/queued/waiting/processing/streaming/completed/failed/timeout/cancelling/cancelled，processing/streaming 从未使用 | 无共享八态协议 | 与桌面状态不一致 | 引入 shared 八态：idle/sending/running/retrying/verifying/completed/failed/cancelled | MessageView | 是 |
| MO-03 | P0 | `supabase.ts:614-652` | commands channel 只更新 pendingCount，callbacks 为空 | Run 状态未订阅 | 远端 failed/cancelled 不进入 UI | 订阅 command/run 状态并映射八态 | supabase、MessageView | 是 |
| MO-04 | P0 | `supabase.ts:368-380` | 取消行 status=cancelled 违反 `CHECK (status IN ('pending','processing','completed','failed'))`，缺 metadata 列，缺 run_id | 契约未同步 | Stop 命令按随仓 SQL 部署时无法插入/无法命中 | 扩展 schema：cancelled 状态 + metadata 列 + run_id/task_id | supabase-schema.sql、supabase.ts | 是 |
| MO-05 | P0 | `realtime.ts:46-65`、`polling-fallback.ts:45-55` | Desktop 只监听/查询 pending | 未处理取消 | 取消命令到达不了处理器 | 监听 pending+cancelled，或 Realtime 全量过滤 | realtime、polling | 是 |
| MO-06 | P0 | `MessageView.tsx:488-512` | Stop 后 300ms 本地显示 cancelled，不等后端确认 | UI 乐观 | 真实取消失败时用户以为已停止 | 等待后端确认或超时回滚 | MessageView | 是 |
| MO-07 | P0 | `MessageView.tsx:420-428` | `replaceOptimistic` 未接入，真实用户消息与临时消息重复 | 乐观消息未替换 | 重复用户气泡 | 按 client_command_id/content 替换 | MessageView | 是 |
| MO-08 | P0 | `MessageView.tsx:467-486` | 重发未复用原幂等键、附件丢失、无 timeout | resend 简化实现 | 可能重复插入、无限等待 | resend 复用原 key+attachments+timeout | MessageView | 是 |
| MO-09 | P1 | `MessageView.tsx:514-519` | Enter 发送未检查 `isComposing` | IME 未处理 | 中文输入法回车误发送 | 增加 composition 检查 | MessageView | 是 |
| MO-10 | P1 | `components.css:565-574,679-708` | `.command-bar` 缺 `flex-direction:column`，附件行与输入行横向挤压 | 样式缺失 | 附件预览布局错误 | 补 column + 自适应高度 | components.css | 是（视觉 QA） |
| MO-11 | P1 | `ConversationList.tsx:54-72` | 列表只取 50 条，无 load-more | 无分页 UI | 旧会话不可达 | offset/limit 加载更多 | ConversationList | 是 |
| MO-12 | P1 | `ConversationList.tsx:89-108` | activeConv 仅按 30 分钟更新时间推断 | 无 Run 状态 | "继续工作"可能指向已完成的会话 | 关联最新 Run 状态 | ConversationList | 是 |
| MO-13 | P1 | `App.tsx:153-156,211-227` | Appearance 返回 home 而非 mine；系统返回键未接入 | 路由简单 | 返回路径错误 | 记忆返回栈 + popstate/Capacitor back | App | 是 |
| MO-14 | P2 | `ConversationList.tsx:295-298`、`components.css:372-386,747-760` | 首页 CTA 与 fixed bottom nav 重叠风险 | 无底部预留 | 首屏遮挡 | 底部 padding safe-area | components.css | 否 |
| MO-15 | P2 | `AppearanceSettings.tsx:174-275` | 使用未定义的 `--accent/--text/--border/--danger` 旧 token | 主题 token 未迁移 | 颜色回退异常 | 迁移到 tokens.css | AppearanceSettings | 否 |
| MO-16 | P2 | `AppearanceSettings.tsx:10-20`、`glass.css:28-33` | blur/vibrancy 参数无实际消费点；降级只覆盖 `.glass` | 玻璃参数未接线 | 设置无效、降级失效 | 接线 token 或移除设置 | AppearanceSettings、glass.css | 否 |

---

## E. Design System 问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| DS-01 | P1 | `styles/tokens.css` vs `styles/base.css:158-164` | radius 同名双定义：tokens sm=10/md=14/lg=18/xl=24 vs base 覆盖 6/8/10/14 | 两层 token 冲突 | 圆角体系失效 | 单一 token 源，base 引用 tokens | tokens.css、base.css | 否 |
| DS-02 | P1 | `styles/base.css:139` | `--color-accent: var(--color-accent)` 自引用 | 复制粘贴错误 | 该 CSS 变量循环失效 | 指向 tokens.css 的 accent | base.css | 否 |
| DS-03 | P1 | `styles/components.css` + 35 组件 | 161 处 inline style 与手写类并存，缺少 PageShell/Section/Panel/StatusPill | 无共享组件体系 | 样式分散 | 建立 PageShell/PageHeader/Section/Panel/Stack/Inline/Button/IconButton/StatusPill | 全部组件 | 否 |
| DS-04 | P1 | `components/ui/button.tsx:22-33`、`input.tsx:15-20`、`tokens.css:71-79` | Button 32px/Input 40px 与项目 44/48px token 冲突 | 两套组件生态（Base UI 语义变量 vs 原始 CSS 变量） | 密度不一致 | 统一尺寸 token | ui/*、tokens.css | 否 |
| DS-05 | P1 | `Layout.tsx:284-294` | 始终 `add('dark')`，light theme 下也激活 dark 变体 | 主题处理硬编码 | 浅色主题组件色异常 | dark class 只按主题启用 | Layout | 是 |
| DS-06 | P1 | `styles/themes.css:80-141` + `styles/themes/light.css:2-55` | light 主题重复定义 | 主题文件职责重叠 | 维护漂移 | 只保留单一 light 定义 | themes.css、light.css | 否 |
| DS-07 | P2 | `tokens.css` | `--card-radius` 24px 被主题层覆盖为 12/14/16px | 覆盖无约束 | token 名不符实 | 覆盖必须显式声明 | tokens.css、themes.css | 否 |

---

## F. CSS 问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| CS-01 | P1 | `components.css:52` vs `Layout.tsx:435-438` | `[data-glass-off]` 与 `data-glass-enabled` 属性名不一致 | 契约漂移 | 玻璃关闭开关失效 | 统一属性名并测试 | components.css、Layout | 是 |
| CS-02 | P1 | `components.css:17-97` | 默认 26px blur、200% saturate、SVG 位移、8s shimmer、hover 上浮 | 玻璃过重 | 与"克制玻璃"目标冲突 | 弱化默认玻璃参数 | components.css | 否 |
| CS-03 | P2 | 多主题 | 部分主题 glass fill 60-95% 或纯色 | 主题各自定义 | 玻璃效果名存实亡 | 玻璃参数只由 Design Token 控制 | themes/* | 否 |
| CS-04 | P2 | `components.css` | hover 位移应用于所有 glass-card | 选择器过宽 | 静态容器也跳动 | hover 只给 Button/可点击卡/导航项 | components.css | 否 |
| CS-05 | P3 | `components.css` | `.glass-card` 无 `@supports` 降级 | 忽略无 backdrop-filter 环境 | 部分环境无背景 | 提供不透明降级 | components.css | 否 |

---

## G. 组件重复

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| DU-01 | P0 | `routes/Chat.tsx` vs `routes/CodingHome.tsx` | 发送/流式/停止/retry/loop/reasoning/activity/滚动锁/token 栏各自实现一遍 | 无共享 ConversationRuntime | 行为漂移、双倍维护 | 抽 useConversation/useConversationMessages/useConversationSend/useExecutionRun/useExecutionStatus/useMessageScroll | Chat、CodingHome、hooks | 是 |
| DU-02 | P1 | `components/ai-elements/*` | message/reasoning/tool/conversation/code-block/chain-of-thought 全套未接入业务页面 | 组件库未落地 | 高质量实现闲置 | 接入 Chat 消息/推理/工具渲染 | Chat、ai-elements | 是 |
| DU-03 | P1 | `lib/notification-center.ts` vs `lib/notifications.ts` | 两套通知实现并存，Layout 仍调用旧权限入口 | 迁移未完成 | 权限行为不一致 | 统一 NotificationCenter | Layout、notification* | 是 |
| DU-04 | P1 | `components/ui/modal.tsx`、`confirm-dialog.tsx` vs 各页面手写弹层 | 三套弹窗体系 | 无强制规范 | 交互不一致 | 统一 Modal/Confirm | 全部弹窗 | 否 |
| DU-05 | P1 | `hooks/useStreamSend.ts` vs CodingHome 内联 | 超级/普通流双实现 | 页面各自演进 | 两处 bug 两倍修复 | 单一 useExecutionRun | hooks、CodingHome | 是 |
| DU-06 | P2 | `Sidebar.tsx` 完整/mini 两套 JSX | 双结构维护 | 规则漂移 | 收敛单数据源渲染 | Sidebar | 否 |
| DU-07 | P2 | `components/ui/textarea.tsx`(64px) vs `components.css:.textarea`(100px) | 同概念双定义 | 生态分裂 | 样式不一致 | 合并到 shared 组件 | ui、components.css | 否 |

---

## H. Inline style 过多

| 编号 | 严重度 | 文件 | 数量 | 建议 | 新增测试 |
|---|---|---|---|---|---|
| IS-01 | P1 | `components/` 全部 | 161 处（16 个文件非零） | 抽 panel/row/title/subtitle/button/input/status/card 类 | 否 |
| IS-02 | P1 | `routes/Chat.tsx` | 60 | 拆 MessageRow/Composer/StatusBanner | 否 |
| IS-03 | P1 | `routes/CodingHome.tsx` | 57（另有大量内联） | 接入共享组件 | 否 |
| IS-04 | P1 | `routes/Settings.tsx` | 106（聚合 111） | 拆分 General/Appearance/Execution/Sync 分区 | 否 |
| IS-05 | P1 | `routes/Knowledge.tsx` | 66 | Tab/搜索/列表用组件 | 否 |
| IS-06 | P1 | `components/Sidebar.tsx` | 24 | 激活态等用 CSS 类 | 否 |
| IS-07 | P2 | `components/activity/*` | 34 | 状态行/步骤行组件化 | 否 |
| IS-08 | P2 | `routes/Workflows/*`（聚合） | 134 | 编辑器布局组件化 | 否 |
| IS-09 | P2 | `routes/Toolbox/*`（聚合） | 87 | ToolCard/流程面板组件化 | 否 |

---

## I. Loop 逻辑问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| LO-01 | P0 | `core/runtime/execution-loop.ts:395-397,410-414` | Normal 无工具即 completed；Loop 默认判据仍为 `content.trim() !== ''` | 文本即完成 | 进度文本被当成最终答案，Loop 过早结束 | 引入 TaskCompletionEvaluator（目标完成/工具成功/错误/验证/Artifact） | execution-loop、三个调用方 | 是 |
| LO-02 | P0 | `modules/conversations/tool-loop.ts:310-312`、`modules/agents/tool-loop.ts:250-252`、`modules/sync/command-processor.ts:668-670` | 三个生产 hook 全部仍用文本非空 | 未迁移 | 整改目标落空 | 统一 evaluator 注入 | 三个模块 | 是 |
| LO-03 | P0 | `core/runtime/execution-loop.ts:267-274` | `maxCostCny>0` 时无费用累计，立即 budget_exceeded | 费用字段缺失 | 费用预算不可用 | 接入 Usage/cost 累计 | execution-loop、usage | 是 |
| LO-04 | P1 | `core/runtime/execution-loop.ts:389-407` | verifying 仅一个内部状态，无 onEvent 通知 | 未接线 | UI/Activity 看不到验证阶段 | 事件化 verifying + verifier 结果 | execution-loop | 是 |
| LO-05 | P1 | `core/runtime/execution-loop.ts:291-343` | 模型调用结束后未再检查取消 | 检查点不全 | 取消期间仍可继续完成 | 模型返回后补取消检查 | execution-loop | 是 |
| LO-06 | P1 | `core/runtime/execution-loop.ts:174-184,432-442` | 结果不返回 messages/finishReason/error/ToolResult | 结果结构过窄 | 无法 checkpoint/审计/重试 | 扩展 CompletionResult | execution-loop | 是 |
| LO-07 | P1 | `core/runtime/execution-loop.ts:302,395-407` | `buildRequest`/`isTaskComplete` 异常未转 failed | try 范围不足 | 异常裸抛 | 纳入错误转换 | execution-loop | 是 |
| LO-08 | P2 | `core/runtime/execution-loop.ts:158-168` | 累计 token 忽略 cached/reasoningTokens | 覆盖式更新 | 用量统计失真 | 全字段累计 | execution-loop、usage | 是 |

---

## J. Retry 逻辑问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| RT-01 | P0 | `core/models/retry-policy.ts:63` | Provider 默认 maxRetries=3（目标 5） | 默认值未对齐 | 传输重试不足 | ExecutionPolicy 统一默认 5 | retry-policy、settings | 是 |
| RT-02 | P0 | `core/models/provider-adapter.ts:185-217` | 重试耗尽后仍抛 `retryable=true` 的普通 ModelError | 无耗尽类型 | 上层无法区分耗尽 | RetryExhaustedError | provider-adapter、errors | 是 |
| RT-03 | P0 | 全仓 | 没有 Task Retry（默认 8）与 Tool Retry（默认 3）控制器 | 未实现 | 任务失败无恢复 | ExecutionRetryController + ToolRecoveryController | runtime、tools | 是 |
| RT-04 | P0 | `lib/fetch-retry.ts` 与 `core/models/retry-policy.ts` 并存 | 两套 Provider Retry | 历史遗留 | 行为双轨 | 全部收敛到 RetryPolicy | 相关调用点 | 是 |
| RT-05 | P0 | `core/models/provider-adapter.ts:368-378` | 每次模型调用重建 transport/RetryPolicy/CircuitBreaker | 生命周期过短 | 熔断状态丢失 | 共享 Provider 级 Policy/CB 实例 | provider-adapter、factory | 是 |
| RT-06 | P0 | `core/models/provider-adapter.ts:193-221` | 4xx 计入熔断失败；HTTP 成功早于 body 完整 | 状态记录时机错误 | 熔断误判 | 只在可重试错误记失败，body 完成再记成功 | provider-adapter | 是 |
| RT-07 | P0 | `core/models/provider-adapter.ts:223-241` | 空 body/流中断不进入重试 | 重试边界只在读头 | 流错误不恢复 | 流错误纳入重试 | provider-adapter | 是 |
| RT-08 | P0 | `core/runtime/execution-loop.ts` | 无 Attempt 概念，Run 无 retry_waiting/retrying 状态 | 数据模型缺失 | 重试不可观察 | Run/Task 增加 Attempt + retry 状态 | run、task、schema | 是 |
| RT-09 | P1 | `core/models/provider-adapter.ts:196-212` | Retry-After 只识别正数秒，忽略 0/HTTP-date | 解析不完整 | 退避不准确 | 完整解析 + Retry-After 优先 | provider-adapter | 是 |
| RT-10 | P1 | `core/models/model-runtime.ts:234-237` | 多 usage chunk 互相覆盖 | 覆盖式更新 | 用量丢失 | 累计式更新 | model-runtime | 是 |
| RT-11 | P1 | `core/models/provider-adapter.ts:428-436` | malformed JSON 静默忽略 | 解析宽容 | 截断不可见 | 结构化流错误 | provider-adapter | 是 |
| RT-12 | P1 | `lib/event-store-runtime.ts:121-147` | seq claim 与 append 非原子 | 两步写入 | 缺口/丢失 | 事务化 claim+append | event-store-runtime | 是 |

---

## K. Tool Call 问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| TC-01 | P0 | `core/runtime/execution-loop.ts:345-351` | assistant 消息不带 `tool_calls`，下一轮产生孤立 tool 消息 | 消息组装遗漏 | Model 上下文不完整，多轮工具必然出错 | 追加 `{role:'assistant', content:null, tool_calls:[...]}` | execution-loop | 是（回归测试：Model2 收到 assistant.tool_calls + tool result） |
| TC-02 | P0 | `core/runtime/execution-loop.ts:374,381` | 执行工具时丢失 `tc.id`，但 tool result 又依赖该 ID | 参数漏传 | 事件/持久化/审批/重试无法关联 call | executeTool 携带 callId | execution-loop | 是 |
| TC-03 | P0 | `core/runtime/execution-loop.ts:354,410-414` | `hasTools=false` 时模型返回 tool_calls 被当最终答案 | 能力校验缺失 | 假成功 | 拒绝或转为错误 | execution-loop | 是 |
| TC-04 | P0 | `core/runtime/execution-loop.ts:375-381` | 工具失败被转字符串并固定发 tool_completed(completed) | 状态丢失 | 假成功、状态错误 | ToolExecutionResult(status: success/failed/timeout/cancelled/approval_required) | execution-loop、tool-executor | 是 |
| TC-05 | P0 | `core/tools/tool-result.ts:11-83` | 结果类型缺 failed/approval_required 命名 | 与目标协议不一致 | 状态语义不统一 | 扩展 ToolExecutionResult | tool-result | 是 |
| TC-06 | P0 | `lib/production-tool-executor.ts:59-65,229-330` | 结构化结果在生产边界转字符串 | 适配降级 | 错误信息丢失 | 全链路结构化 | production-tool-executor | 是 |
| TC-07 | P0 | `modules/conversations/tool-loop.ts:202-214` | 非法参数发 tool.completed(status:error) | 状态不一致 | 前端无法区分 | 统一 error 语义 | tool-loop | 是 |
| TC-08 | P1 | `core/tools/tool-timeout.ts:54-78,132-181` | timeout 只 race，底层工具收不到合并 signal | 非协作取消 | 超时后副作用继续 | 传入合并 signal | tool-timeout | 是 |
| TC-09 | P1 | `core/tools/tool-registry.ts:17-30`、`tool-executor.ts:204-226` | AetherTool.policy 字段未被读取；Zod 校验后仍传原始 input | 接线缺失 | 策略/解析数据未生效 | 执行器读取 policy 与 parsed data | tool-registry、tool-executor | 是 |
| TC-10 | P1 | `core/tools/tool-runtime.ts:128-151,165-294` | ToolRuntime 事件是嵌套包装，非顶层 v2 事件；无重试执行器 | 未接入 EventStore | 工具事件不可回放 | 顶层事件 + 自动重试 | tool-runtime | 是 |

---

## L. Event / State 问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| EV-01 | P0 | `core/runtime/run.ts:15-22,53-71` | RunStatus 缺 retry_waiting/retrying/verifying/budget_exceeded | 状态模型不全 | 终态/中间态不可表达 | 扩展 Run 状态机 | run、schema | 是 |
| EV-02 | P0 | `core/runtime/run.ts:160-198,225-243` | transition 接收 error 但不保存，toEntity 用 endReason 代替 | 参数未落地 | 失败详情丢失 | error 持久化 | run、run-lifecycle-manager | 是 |
| EV-03 | P0 | `shared/src/events/events.ts:320-344,393-439` | 无 execution.attempt.* / execution.retry.* 事件 | 协议缺失 | Retry 不可观察 | 新增 attempt/retry 事件协议 | events.ts | 是 |
| EV-04 | P0 | `store/activityStore.ts:112-114,448-459` | 多 run 聚合只按 seq，无 run/timestamp/eventId 次级排序 | 排序过窄 | Timeline 顺序不可靠 | 稳定排序契约 | activityStore | 是 |
| EV-05 | P0 | `components/activity/ActivityStream.tsx:85-113` | TaskCard 固定最前、reasoning 追加最后、终态记录被过滤 | 非 Timeline 实现 | 时间线失真 | 全部记录按 seq 渲染 | ActivityStream | 是 |
| EV-06 | P0 | `components/activity/ActivityStream.tsx:77-83,101-104` | reasoning 跨 run/agent 无分隔拼接；running 只认 completed | 投影缺陷 | 推理顺序错乱、状态残留 | 按 run/agent 隔离 + failed/cancelled 终态 | ActivityStream | 是 |
| EV-07 | P0 | `activityStore.ts:523-538` | 用最大 started seq 选择最新 Run，seq 重启时可能选错 | 跨 run 比较失效 | TaskCard 显示错误 Run | 按 run 开始时间/序号选择 | activityStore | 是 |
| EV-08 | P0 | `activityStore.ts:305-445` | replace/clear 不清理 identity Set | 清理遗漏 | 复用 runKey 后事件被错误去重 | 清理 identity | activityStore | 是 |
| EV-09 | P0 | `store/activityStore.ts:168-205,246-289` | 写路径原地修改旧数组与已有 runMeta | 可变状态 | React 状态污染 | 不可变更新 | activityStore | 是 |
| EV-10 | P0 | `api/streamClient.ts:79,103` vs `hooks/useStreamSend.ts:15-25` | Stream 终态集合（task.completed/task.failed/agent.output.completed）与通知终态集合（run.*/task.failed）不一致 | 双集合漂移 | 正常完成不发通知、task.cancelled 误判截断 | 统一终态协议 | streamClient、useStreamSend | 是 |
| EV-11 | P0 | `EventBus` vs `event-store` 双实现 | 普通 Chat 只写 activity_events | 事件入口不统一 | 事件完整度不一致 | 统一事件入口 | event-bus、chat-handler | 是 |
| EV-12 | P0 | `shared/src/events/legacy-adapter.ts:31-107,123-208` | v1/v2 terminal 映射有损，failed/cancelled 可压成 completed | 适配丢失 | 终态错误 | 保真映射 | legacy-adapter | 是 |
| EV-13 | P0 | `run-lifecycle-manager.ts:145-210` | 状态更新无 from-status CAS | 无乐观锁 | 并发双终态竞态 | CAS 更新 | run-lifecycle-manager | 是 |
| EV-14 | P0 | `run-lifecycle-manager.ts:233-251` | recoverStale 处理所有 running/waiting | 无租约/时间条件 | 活跃 Run 被误标 | 租约+超时条件 | run-lifecycle-manager | 是 |
| EV-15 | P0 | `lib/notification-center.ts:114-159` | notifyOnce 先 markNotified 再检查可见性/权限 | 顺序错误 | 失败通知被吞 | 发送成功后落幂等 | notification-center | 是 |
| EV-16 | P1 | `run-lifecycle-manager.ts:58-78,145-171` | create 动作映射 created→created，与 Run 状态机冲突 | 死代码 | API 语义错误 | 修正/移除 | run-lifecycle-manager | 是 |
| EV-17 | P1 | `core/runtime/lifecycle.ts:90-147` | fail() 绕过合法转移表，可从任意态进入 failed | 验证缺失 | 状态机不严格 | 校验转移 | lifecycle | 是 |
| EV-18 | P1 | `core/runtime/checkpoint.ts:15-43,51-189` | Checkpoint 仅是序列化原语，未接入 Loop/DB/恢复 | 未接线 | 重试无恢复依据 | 接入 checkpoint 恢复 | checkpoint、execution-loop | 是 |
| EV-19 | P1 | `core/runtime/cancellation.ts:193-215` | withCancellation 只让外层 Promise 失败，副作用继续 | 非协作 | 取消不彻底 | 底层接受 signal | cancellation | 是 |
| EV-20 | P1 | `core/runtime/runtime-context.ts:60-113` | abort 不在接口类型中，父 signal 监听无 dispose | 类型/生命周期 | 泄漏、无法取消 | 显式接口 + dispose | runtime-context | 是 |

---

## M. Workflow 执行问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| WF-01 | P0 | `workflows/node-executors.ts:64-81`、`execution-engine.ts:125-137` | 节点错误被返回为字符串，引擎视为成功 | 错误扁平化 | Workflow 假 completed | 结构化节点结果 + 失败传播 | node-executors、engine | 是 |
| WF-02 | P0 | `workflows/execution-engine.ts:125-187` | Workflow 未接入 AbortSignal，根 Run 取消后继续执行 | 无取消传播 | 取消失效 | 传播取消到各节点 | execution-engine | 是 |
| WF-03 | P0 | 全 workflow 模块 | 无 Node Retry / Workflow Retry / checkpoint resume | 未实现 | 失败即重来 | 节点级状态 + retry + resume | workflows | 是 |
| WF-04 | P0 | `workflow_runs` schema | 无节点级状态表，只靠 current_node_id | 数据模型缺失 | 无法展示 4/7 节点 | workflow_node_runs 表 | schema | 是 |
| WF-05 | P1 | `workflows/execution-engine.ts:85-141` | 并发节点共同写同一 currentNodeId | 共享可变 | 状态竞争 | 每节点独立状态 | engine、schema | 是 |
| WF-06 | P1 | `modules/workflows/index.ts:121-125` | API 描述"顺序执行"，实际受控并行 DAG | 文档漂移 | 语义不符 | 文档与行为对齐 | workflows | 否 |

---

## N. API 层问题

| 编号 | 严重度 | 文件 | 问题表现 | 根本原因 | 实际影响 | 建议方案 | 涉及文件 | 新增测试 |
|---|---|---|---|---|---|---|---|---|
| AP-01 | P0 | `api/client.ts:13-41` | 首次认证失败被永久缓存，认证 fetch 无超时 | Promise 缓存不重置 | 写请求永远 401/挂起 | 失败重置 + 超时 | client.ts | 是 |
| AP-02 | P0 | `api/client.ts:56-115` | request 无自动 retry、无结构化错误（status/code/retryable） | 未实现 | 错误不可编程 | 统一错误类型 + 请求重试 | client.ts | 是 |
| AP-03 | P0 | `api/client.ts:130-160` | fallback mergeSignals 清理 Symbol 不一致 | 双 Symbol 变量 | 监听泄漏 | 统一 Symbol | client.ts | 是 |
| AP-04 | P1 | 8 个业务文件 25 处裸 fetch | 未收口到 api.xxx() | 历史调用 | auth/error/retry 不一致 | 全部收口 | Toolbox/Settings/Terminal/CodingHome/Layout/DataManage/McpSettings/useMessagePolling | 是 |
| AP-05 | P1 | `api/streamClient.ts:43-58,247-263` | 无 Last-Event-ID、limit、cursor、重连 | 未实现 | 断线恢复不可靠 | 实现 Last-Event-ID + 分页 + 退避重连 | streamClient | 是 |
| AP-06 | P1 | `api/streamClient.ts:124-126` | 旧 `retry` 事件只更新 retryInfo | 未扩展 | 无法自动恢复 | 请求层重试 | streamClient、useStreamSend | 是 |
| AP-07 | P1 | `api/client.ts:74-82,234` | sensitive path `/approvals/` 与 `listApprovals` 路径 `/approvals` 不匹配 | 前缀错误 | 敏感读请求未带认证 | 修正匹配 | client.ts | 是 |
| AP-08 | P2 | `api/client.ts:92` | 强制 JSON 响应 | 假设过强 | 204/文件流失败 | 支持可选响应类型 | client.ts | 否 |

---

## O. 测试缺口

| 编号 | 严重度 | 说明 | 新增测试 |
|---|---|---|---|
| TG-01 | P0 | ExecutionLoop 无 assistant.tool_calls 消息链断言、无 tool_call_id 匹配断言 | 是 |
| TG-02 | P0 | 无 finishReason=max-tokens / content_filter / error 完成语义测试 | 是 |
| TG-03 | P0 | 无工具失败/超时/取消对 Run 状态影响测试 | 是 |
| TG-04 | P0 | 无 Task Retry（8 次成功/耗尽）、Provider Retry 集成（429→500→网络→成功）、Retry-After 测试 | 是 |
| TG-05 | P0 | 无 Retry 取消（等待中 Stop 立即停止）、Retry 与 Loop turn 分离、Retry 与 Token 累计测试 | 是 |
| TG-06 | P0 | 无 Retry 不重复用户消息、不重复成功 Tool、不破坏上下文测试 | 是 |
| TG-07 | P0 | Mobile 无组件测试：App/MessageView/ConversationList/Login/supabase.ts 覆盖率 0 | 是 |
| TG-08 | P0 | Mobile 无"首条 assistant 误判 completed"、取消链路（CHECK/监听/run_id）、状态同步测试 | 是 |
| TG-09 | P1 | 前端无 Chat loads/send/streaming/stop/retry/loop/tool/reasoning/scroll/manual retry UI 测试 | 是 |
| TG-10 | P1 | EventStore 无分页/cursor/afterSeq UI 侧测试 | 是 |
| TG-11 | P1 | NotificationCenter 无"聚焦时失败→后台恢复通知被吞"测试 | 是 |
| TG-12 | P1 | workflow 节点失败/取消/重试/checkpoint 无测试 | 是 |
| TG-13 | P1 | ActivityStore 无跨 run 顺序、reasoning 隔离、identity 清理复用测试 | 是 |
| TG-14 | P2 | 前端无视觉快照/响应式（1440/1280/1024/768/412/390）测试 | 是 |

现状：全仓 114 个 `*.test.ts`（backend 104 / frontend 5 / mobile 3 / shared 2）。

---

## P. 构建问题

| 编号 | 严重度 | 文件 | 问题表现 | 建议 | 新增测试 |
|---|---|---|---|---|---|
| BD-01 | P1 | `package.json:29` | `typecheck` 覆盖全部 workspace 但 backend/frontend/shared 无独立 typecheck 脚本 | 补各 workspace typecheck | 否 |
| BD-02 | P1 | 根 `test` 依赖先 build shared/backend | 测试需要构建产物 | 保留但固化 CI 顺序 | 否 |
| BD-03 | P1 | `src/mobile/package.json` test 仅 `src/lib/*.test.ts` | Mobile 测试面过窄 | 扩展测试范围 | 是 |
| BD-04 | P1 | `.github/workflows/ci.yml:58-83` | CI 无 Android/Gradle/EXE 构建、无覆盖率、无 Node 版本矩阵 | 增加 Android + EXE 门禁 | 否 |

---

## Q. 发布问题

| 编号 | 严重度 | 文件 | 问题表现 | 建议 | 新增测试 |
|---|---|---|---|---|---|
| RL-01 | P1 | `build/release-all.js:26-45` | 自用版路径/开源版路径/JDK 路径硬编码 | 配置化 | 否 |
| RL-02 | P1 | `build/build-exe.js:290-302` | NSIS 失败仅告警，Setup 可能缺失仍继续发布 | 失败即中止 | 否 |
| RL-03 | P1 | `build/release-all.js` | 自动删除重建 GitHub Release 与 tag | 覆盖风险 | 保留历史 tag | 否 |
| RL-04 | P2 | `docs/SYNC_MANIFEST.md:17` | 声称审计文档已删除，实际 docs 下有 6 份 | 更新清单 | 否 |

---

## R. 代码组织问题

| 编号 | 严重度 | 文件 | 问题表现 | 建议 | 新增测试 |
|---|---|---|---|---|---|
| CO-01 | P0 | `core/runtime/index.ts:1-90` | ExecutionLoop 未从 Runtime 公共入口导出 | 补导出，统一入口 | 否 |
| CO-02 | P1 | `core/runtime/execution-loop.ts` | 单文件承载 loop/state/budget/tool/completion | 拆分 execution-state/budget/attempt/retry/checkpoint/completion/error | 是 |
| CO-03 | P1 | `routes/Settings.tsx:1286` | 巨型组件 | 拆分 General/Appearance/Execution/Loop&Retry/Workspace/Sync/MCP/Notifications/Data | 是 |
| CO-04 | P1 | `routes/Chat.tsx` + `routes/CodingHome.tsx` | 双对话系统 | 收敛共享 hooks 与组件 | 是 |
| CO-05 | P1 | `lib/fetch-retry.ts` vs `core/models/retry-policy.ts` | 双 Retry 系统 | 合并 | 是 |
| CO-06 | P1 | `lib/notifications.ts` vs `lib/notification-center.ts` | 双通知系统 | 合并 | 是 |
| CO-07 | P1 | `core/runtime/run-context.ts` vs `runtime-context.ts` | 双上下文类型 | 统一 | 是 |
| CO-08 | P1 | `db/schema` | runs/tasks 无 parentRun/retryOf/attempt 字段 | 扩展 schema 迁移 | 是 |
| CO-09 | P2 | `components/ai-elements/*` | 未使用组件库 | 接入或移除 | 否 |
| CO-10 | P2 | `styles/themes/light.css` vs `themes.css` | 重复定义 | 单一职责 | 否 |

---

## S. 性能问题

| 编号 | 严重度 | 文件 | 问题表现 | 建议 | 新增测试 |
|---|---|---|---|---|---|
| PF-01 | P0 | `store/activityStore.ts` | 每个 envelope 更新 store，ActivityStream 每次全量重投影 | 事件批次 + 增量投影 + 细粒度 selector | 是 |
| PF-02 | P0 | `hooks/useStreamSend.ts:152-175` | rAF 无句柄/无取消，手动 flush 后仍重复执行 | 保存 frame id + cancel | 是 |
| PF-03 | P1 | `store/activityStore.ts:215-216,260-261` | 每次追加重置 TaskCard 游标，增量缓存退化 | 正确增量游标 | 是 |
| PF-04 | P1 | `routes/Chat.tsx:545-551` | N 条用户消息 N 份 Activity 树 | Run 单次挂载 | 是 |
| PF-05 | P1 | `store/activityStore.ts:448-459` | getEvents 缓存引用导致内存持续增长 | 分页/cursor/裁剪 | 是 |
| PF-06 | P1 | `hooks/useMessagePolling.ts:128-145,319-339` | 新 poll abort 旧 poll；空闲仍全量拉取 | 退避 + 增量 | 是 |
| PF-07 | P1 | `components.css` | 97 个 glass-card 永久 will-change + 动画层 | 惰性 will-change | 否 |
| PF-08 | P2 | `hooks/useStreamSend.ts` | flushUI 每帧 map 整个 messages 数组 | 增量更新单条 | 否 |

---

## 附录：与整改书重点条款的对照

| 整改书要求 | 当前状态 |
|---|---|
| 第二十三章 修复 Tool Call 消息链 | 未修复（TC-01/TC-02） |
| 第二十四章 max_tokens 完成语义 | 未修复（EL-03） |
| 第二十一章 TaskCompletionEvaluator | 未实现（LO-01/LO-02） |
| 第二十二章 Verifying 阶段 | 仅有内部状态，未接线（LO-04） |
| 第二十五至三十一章 多层 Retry | Provider 层存在且缺陷多；Task/Tool Retry 未实现 |
| 第三十三至三十六章 失败对话与手动 Retry | 未实现统一 FailureCard / Manual Retry |
| 第三十七至三十八章 Retry Event Protocol | 事件协议缺失 |
| 第四十二至四十三章 Run 状态明确与一致 | 状态模型缺失 + 事件/DB/UI 不一致 |
| 第四十六至四十八章 ExecutionLoop 改造与 ToolResult | 未实施 |
| 第四十九至五十二章 Provider 统一 | 双系统并存 |
| 第五十三至五十五章 API/Hook/对话统一 | 未收口（25 处裸 fetch；双对话系统） |
| 第五十六至五十七章 Mobile 行为统一 | 未统一（首条 assistant 即 completed） |
| 第六十四至六十八章 共享组件与失败 UI | 缺失 PageShell/StatusPill/RetryStatus/ExecutionStatus/ExecutionTimeline/FailureCard |
| 第八十二至九十章 测试要求 | 主要缺口集中在 Loop/Retry/状态/Mobile |
| 第一百零九章 交付文档 | 本审计已创建；后续需 RE-AUDIT |
| 第一百一十章 二次审计项 | 全部 20 项中，1/2/3/4/5/6/7/8/9/10/11/12/13/14/15/16/17/18/19 均存在未完成项 |

---

*本报告为审计基线。后续阶段按整改书顺序执行：P0 → P1 → Loop → Retry → Conversation → UI Design System → Chat UI → Other UI → Refactor → Tests → Build → Visual QA → Final Re-Audit。*
