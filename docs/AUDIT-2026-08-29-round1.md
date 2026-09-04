# 项目全维度审计报告（第一轮）

- 项目：D:\PersonalAICommandCenter（Aether — 本地优先 AI 工作操作系统）
- 日期：2026-08-29
- 审计方式：6 路并行全量审计（后端 / 前端 / 安全 / 性能与执行重复 / UI·UX·审美 / 配置·依赖·周边）+ 运行时基线实测
- 范围：src/backend（24 模块）、src/frontend（18 路由）、src/shared、src/mobile、electron、build、qa、docs、配置与脚本、数据目录
- 本轮**只审计，未修改任何代码**

---

## 0. 运行时基线（实测，非推断）

| 检查 | 命令 | 结果 |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ PASS |
| Lint | `npm run lint` | ⚠️ 0 errors / **585 warnings**（no-explicit-any + no-unused-vars 为主） |
| Build | `npm run build` | ✅ PASS（43.6s；存在 >500kB chunk 警告） |
| Test | `npm test` | ⚠️ 直接跑 82/85 FAIL 3 → **重新 build 后 85/85 PASS** |
| 启动 | server_stderr.txt | 空（无运行时错误记录） |

**基线结论**：构建链可用；测试依赖 dist 新鲜度（`npm test` 不自动 build → 过期 dist 会产生假失败，且失败用例各挂 33 秒才超时）。

---

## A. 项目总体评分

```text
代码质量：    55/100   （585 lint 警告、God 文件×10、重复逻辑 6+ 组）
架构：        60/100   （模块边界清晰，但无服务层、存在跨模块反向 import）
功能完整度：  75/100   （12 大模块基本可用；工具箱未完成、导出/搜索/工作流有半成品）
逻辑可靠性：  55/100   （轮询竞态、Abort 复用串话、静默吞错、事务缺口）
稳定性：      70/100   （85 测试全绿、有 ErrorBoundary；存在心跳泄漏与未处理拒绝）
性能：        50/100   （会话列表 N+1 全表扫描、flushSync 每事件强渲染、agent loop 无预算）
安全：        55/100   （已有纵深防御：allowlist/CSRF/CSP/AES-256-GCM；但 13 个 P0）
UI 一致性：   55/100   （Tailwind OKLCH 覆盖主题变量、3 套按钮系统、50+ 内联卡片样式）
UX：          65/100   （部分页面三态完整；a11y/键盘/响应式/焦点管理缺口）
视觉审美：    60/100   （设计语言碎片化：4 种卡片圆角、3 种悬停位移、动画常量不统一）
可维护性：    45/100   （19/24 后端模块零测试、组件测试 0%、文档与现实脱节）

总评分：      56/100
```

---

## B. 问题总数

6 路原始发现 ≈ 290 条；跨 lane 去重与误报剔除（BD-002 路由未分割=误报；DEP-02 canvas 未使用=误报；DEP-04 drizzle 死代码=误报；RUNTIME-02 降级；DATA 系列因非 git 仓库降级）后：

```text
P0：47
P1：86
P2：79
P3：41
合计：253
```

---

## C. 问题详细清单（P0 全列；P1–P3 分组紧凑列出）

### C-0 P0 清单（47 项，逐项列出）

#### 安全 P0（13）

| ID | 文件:位置 | 问题 | 修复方案 |
|---|---|---|---|
| SEC-001 | backend/lib/command.ts:276-280 | Windows 内建命令经 `cmd.exe /s /c <整串>` 执行，`^&`、`FOR` 等 cmd 解析怪癖可绕过 token 过滤 | 一律 `spawn(cmd, args, {shell:false})`；内建命令改原生实现（dir→fs.readdir 等） |
| SEC-002 | backend/modules/data/index.ts:294-296 | 同上，`/api/projects/exec` 内建命令整串过 shell | 同上 |
| SEC-003 | backend/modules/workflows/index.ts:269-271 | 同上，workflow system 节点整串过 shell | 同上 |
| SEC-004 | backend/modules/documents/index.ts:169-178 | 下载端点信任 DB 中 `doc.path`；DB 被污染即可读任意系统文件 | DB 只存 UUID 文件名，运行时 `resolve(docDir, filename)` 重建并白名单校验 |
| SEC-005 | backend/modules/media/index.ts:60-65 | 静态文件端点 `relative()` 校验缺陷（`resolve(rel)===rel` 恒 false，逻辑失效） | `filePath.startsWith(resolve(mediaDir)+sep)`；DB 只存文件名 |
| SEC-006 | backend/modules/export/index.ts:70-74 | 同 SEC-005 的校验缺陷 | 同上 |
| SEC-007 | backend/modules/search/index.ts:170-178 | 网页抓取跟随重定向，未校验跳转目标 → 可打云元数据 169.254.169.254 | `redirect:'manual'` 并逐跳 `isSafeFetchUrl` |
| SEC-008 | backend/modules/mcp/index.ts:192 | 远程 MCP server.url 未过 `isSafeFetchUrl` 即 fetch | 创建/更新/测试三处均校验 |
| SEC-009 | backend/modules/media/index.ts:172-273 | AI provider 返回的 video_url/image_url 二次 fetch 无 SSRF 校验 ×5 处 | 全部过 `isSafeFetchUrl` |
| SEC-010 | backend/modules/workflows/index.ts:104-623 | provider.baseUrl 取自 DB 未校验即 fetch | provider 写库时校验 baseUrl |
| SEC-011 | backend/config/index.ts:36-48 | 主加密密钥落盘 `.encryption_key`（icacls 挡不住同用户/管理员进程） | 迁移 OS 钥匙串（DPAPI/keytar） |
| SEC-012 | backend/lib/crypto.ts:31-34 | 非 `enc:` 前缀明文 key 静默回退可读 | 读取端拒绝明文 + 强制重写加密 + 迁移脚本 |
| MOB-01 | mobile/src/api/supabase.ts:43-59 | **service_role key 明文存 localStorage**（代码注释自承认 P0-3），设备丢失=全库沦陷 | 改 anon key + RLS；或全部经后端 sync 代理 |

#### 前端逻辑 P0（9，去重后）

| ID | 文件:位置 | 问题 | 修复方案 |
|---|---|---|---|
| FE-01 | Layout.tsx:207-259 + CodingHome.tsx:228-329 | 远程命令**双轮询**（1.5s×2），竞态+双倍请求 | 轮询集中 Layout；CodingHome 只监听事件 |
| FE-02 | Layout.tsx:251-258 | 轮询 fetch 无 AbortSignal；卸载瞬间在途请求泄漏 | AbortController + await 后检查 cancelled |
| FE-03 | Layout.tsx:122-130 | 幻灯片 timer 依赖仅 length，同长换图不重置；cleanup 捕获旧 ref | 函数式 cleanup + 完整依赖 |
| FE-04 | Chat.tsx:134-151 | 事件轮询无序号守卫，慢响应可乱序到达 | 套用 loadReqIdRef 守卫模式 |
| FE-05 | Chat.tsx:286-291 | AbortController 复用：旧流 finally 在新流启动后执行 → 跨会话加载错消息 | 每次发送新建 controller；旧者独立保存 |
| FE-06 | CodingHome.tsx:189+195 | mount 双加载（load() 与 ?new= 处理器各拉一遍 providers/conversations） | 合并初始化入口 |
| FE-07 | Chat.tsx:128+196 | 同上双加载 | 同上 |
| FE-08 | CodingHome.tsx:439-510 | 消息 1s 轮询无去重守卫，快速响应可重复合并 | loadReqIdRef + 按 ID 合并 |
| FE-09 | Media.tsx:296-299 | 假进度条（不管真实状态一律爬到 90%） | 移除假进度，显示真实耗时 |
| FE-10 | Providers.tsx:84-87 | getSupabase 返回 null，调用方当 client 用 → 同步静默失败 | 返回真实 client 或显式 throw |
| FE-11 | Settings.tsx:147-183 | 同步配置恢复竞态：hasKey=true 但 localStorage 无 key → 显示已连接实际断开 | key 解析完成前不得置 connected |

#### 流协议 P0（1）

| ID | 文件:位置 | 问题 | 修复方案 |
|---|---|---|---|
| ST-01 | frontend/api/streamClient.ts:88-128 | envelope 负载双发射：同内容既发 `envelope` 又发 `text-delta` → 所有聊天 UI 双渲染 | envelope 发射后 `return` |

#### 后端逻辑 P0（8，去重后）

| ID | 文件:位置 | 问题 | 修复方案 |
|---|---|---|---|
| BE-01 | app.ts:173-175 + db/client.ts:43-50 | markDirty 竞态：onResponse 每请求触发；maxLatencyTimer 不随 flushTimer 重置 → 提前/重复 flush | 单例防抖；两 timer 同清 |
| BE-02 | lib/tool-executor.ts:113 + workflows/index.ts:92 | `executeFileTool` 是 async 却未 await → 工具结果拿到的是 Promise | 补 await（workflows 注释已自承认） |
| BE-03 | sync/index.ts:1040-1065 + 1027 | 轮询回调与递归重连无错误边界 → 未处理拒绝可崩进程 | try/catch + await |
| BE-04 | agents/index.ts:701-712 + conversations/index.ts:580 | AI 分析/工具调用非 ok 非可重试状态时静默落入兜底 | 显式错误处理 |
| BE-05 | agents/index.ts:882-887 + conversations/index.ts:574 | 客户端断开后工具执行不检查 abort，继续烧钱 | abort signal 传入 executeTool |
| BE-06 | data/index.ts:506-548 | 导入会话的 messages insert 在事务外 → 崩溃即半成品 | 移入同一 transaction |
| BE-07 | sync/index.ts:287-312 | 会话+首消息 upsert 非原子 | 补偿/重试机制 |
| BE-08 | conversations/index.ts:328-335 | SSE heartbeat 在早退错误路径不清除 → interval 泄漏 | try/finally |

#### 性能 P0（5，去重后）

| ID | 文件:位置 | 问题 | 修复方案 |
|---|---|---|---|
| PF-01 | conversations/index.ts:102-143 | 会话列表/详情 N+1：全表扫 assistant 消息 + 逐行 JSON.parse 算 token | conversations 表加 tokenTotal 列，写入时增量维护 |
| PF-02 | conversations/index.ts:546 | loop 模式 maxTurns=500 且无工具调用总预算 → 失控成本 | maxToolCallsPerRequest（如 50）硬预算 |
| PF-03 | conversations/index.ts:574-580 | 429 重试无熔断无抖动，重试风暴 | 熔断器 + jitter + 尊重 Retry-After |
| PF-04 | activityStore.ts:83-89 | 每个 agent 事件 flushSync 强同步渲染 → 流式期间主线程卡顿 | 去 flushSync，用 React 19 自动批处理 + useDeferredValue |
| PF-05 | activityStore.ts:191-296 | projectTaskCard 每事件全量重投影 O(n²) | 增量投影 |

#### 结构 P0（God 文件/函数，14 项）

| ID | 文件 | 规模 | 拆分方向 |
|---|---|---|---|
| GF-01 | backend/modules/agents/index.ts | 69.7KB / ~2300 行；orchestrate handler 单函数 500+ 行 | agent-definitions / orchestration / sse-handler / tool-loop / routes |
| GF-02 | backend/modules/conversations/index.ts | 55.7KB / ~1800 行；message handler 700+ 行 | chat-handler / sse-stream / tool-loop / compaction / routes |
| GF-03 | backend/modules/sync/index.ts | 60.5KB / ~2000 行；processRemoteCommand 700+ 行 | sync-config / realtime / polling / command-processor / engine |
| GF-04 | backend/modules/toolbox/index.ts | 38.4KB / ~1200 行 | image/doc/audio/pdf/encoding 分域 |
| GF-05 | backend/modules/workflows/index.ts | 31.3KB / ~1000 行 | store / engine / node-executors / ai-creator |
| GF-06 | backend/modules/data/index.ts | 30.1KB / ~1000 行 | settings / projects / import-export / exec |
| GF-07 | backend/lib/search-tools.ts | 24.3KB / ~800 行 | 按工具类拆分 |
| GF-08 | backend/lib/event-bus.ts | 13.5KB / ~450 行 | chunk-packer / persistence |
| GF-09 | backend/lib/command.ts | 13.8KB / ~450 行（安全关键） | executor / validator / history |
| GF-10 | backend/lib/dal.ts | 12.3KB / ~400 行 | 按实体拆分 |
| GF-11 | frontend/routes/CodingHome.tsx | 1197 行 | 与 Chat 共享 hooks + 拆分子组件 |
| GF-12 | frontend/routes/Media.tsx | 1034 行 | Form/Gallery/Preview/useToast |
| GF-13 | frontend/routes/Settings.tsx | 1023+ 行 | Sync/Appearance/General 拆 tab |
| GF-14 | frontend/routes/Workflows.tsx + Chat.tsx + Toolbox.tsx + Knowledge.tsx + Layout.tsx | 952/864/630/651/523 行 | 各自按域拆分 |

#### UI P0（4）

| ID | 位置 | 问题 | 修复方案 |
|---|---|---|---|
| UI-01 | frontend/styles/base.css:123-129 | Tailwind OKLCH `:root/.dark` 覆盖主题 CSS 变量 → `bg-primary` 等语义色不随 6 套主题切换 | 移除 OKLCH 覆盖，@theme 映射到主题变量 |
| UI-02 | button.tsx vs hover-glow-button.tsx vs components.css .btn-primary | 3 套按钮系统并存（hover-glow 432 行实为死代码） | 统一 Button(cva)，删另外两套 |
| UI-03 | Chat.tsx:52 / Sidebar.tsx:131 / CommandCenter.tsx:99 等 | `text-white` on accent 渐变 → 亮主题对比度失效（WCAG 不达标） | 语义化 on-accent 前景变量 |
| UI-04 | Settings.tsx:813 | 主题经 JS 后置设置 → 首屏闪烁错误主题 | index.html 内联脚本预置 data-theme |

### C-1 P1 清单（86 项，分组）

**安全（8）**：MarkdownEditor `dangerouslySetInnerHTML` 缺 CSP nonce/DOMPurify（SEC-013）；hover-glow 内联 style 违 CSP（SEC-014）；敏感端点仅 CSRF 无认证：terminal 执行（SEC-016）、security 设置提权（SEC-017）、明文 key 读取（SEC-018）；CORS 白名单硬编码（SEC-019）；Swagger 生产暴露 `/docs`（SEC-020）；Electron 走 http:// 非 https（SEC-021）；Electron 端口硬编码 3000（SEC-022）。

**后端逻辑/质量（24）**：force-summary 兜底逻辑 ×4 处重复（CQ-016）；tool-dedup ×3（CQ-017）；AI fallback ×3（CQ-018）；isPathSafe ×4 变体（CQ-019）；provider-test ×3（CQ-020）；AI 分析提示词 ×2（CQ-015）；magic numbers 批量（CQ-021~024：maxTurns 500/30、MAX_HISTORY 100、各 timeout）；routeMessage 正则路由脆弱（CQ-025）；console.warn/error 直连 ×9 处（CQ-029~034）；TODO/修复注记残留 ×6（CQ-035~040）；旧协议双轨代码（CQ-041/042）；compaction 失败静默（LC-025）；循环图 topoSort 继续执行（LC-020）；symlink 递归风险（LC-018）；provider 前先写 SSE 头再 503（LC-022）。

**前端逻辑/质量（14）**：mergeSignals 监听器累积（A20）；clip-path hack（A21）；hover-glow 每渲染生成 432 条 CSS 规则（A22）；gradient-shimmer 每实例独立 WAAPI（A23）；Settings applyGlassToCSS 依赖缺失（A29）；glass slider 每变动全量写 localStorage（A30）；8 处 loading/error/empty 三态重复实现（D07）；toast 三套并存（D05）；Toolbox 用原生 confirm（D06）；会话 CRUD 三处复制（D02）；流式发送 ~300 行 ×2 复制（D03）；消息轮询 ×2（D04）；useEffect 缺清理/依赖若干（A31/A46）。

**性能（14）**：MCP 工具每个 loop 轮次重载（BP-009/010）；工具箱重依赖未全懒加载（BP-003）；图转 PDF 全量入内存（BP-004）；PDF 逐页 canvas 累积（BP-005）；sync N+1 upsert ×2（BP-007/008）；历史截断 O(n²)（BP-006）；compaction 共享 120s 预算（AI-004）；子 agent 无并发上限（AI-005）；sync 复制 agent loop 缺守卫（AI-006）；MCP 调用无重试无 fallback（AI-003）；reasoningText 每次渲染全量 join（RP-003）；contextTokens 未 memo（RP-004）；项目/文档/Knowledge 等页面焦点与焦点陷阱缺失（UI lane P1 组）；响应式断点缺失（CommandCenter/Knowledge/Settings 网格无移动端列数）。

**测试与工程（8）**：19/24 后端模块零测试；前端组件/路由/钩子测试 0%；`npm test` 不保证 dist 新鲜（假失败且 33s/例超时）；shared 6 导出模块仅 1 测试文件；qa/ 16 个手工截图无断言；eslint no-explicit-any 仅 warn（585 警告不中止）；eslint 整目录豁免 electron/android/wechat-bridge；移动端不在 workspaces（200MB 重复 node_modules + 版本漂移）。

**安全周边（4）**：testing/run 无速率限制可 DoS（SEC-025）；monitoring/system 泄露内网拓扑（SEC-026）；monitoring/models 解密全部 key 顺序外呼（SEC-027）；import/all 不消毒消息内容（SEC-030）。

**UI/UX（其余 P1）**：缺共享 Tabs/Input/Textarea/EmptyState/Spinner/Modal；50+ 内联卡片样式绕开 .glass-card；图标按钮缺 aria-label；流式内容无 live region；模态无焦点陷阱；亮主题重复定义冲突（themes.css vs themes/light.css）；移动端 localStorage 配置漂移。

### C-2 P2 清单（79 项，分组）

前端：magic 轮询间隔 5 处（A24）、事件名 magic strings ×7（A25）、rAF 滚动未节流（A27）、reasoning 双处计算（A28）、webkitdirectory 非标准（A36）、拖拽自定义 MIME（A37）、safeUrl 放行 http（A38）、Markdown 链接正则（A39）、code-block 硬编码暗色（A40）、Terminal 2s 轮询无 abort（A43）、Vault 自动锁 timer 抖动（A45）等。
后端：fetchWithRetry 被 5 模块从 conversations 反向 import（CQ-048~052→应落 lib/fetch-retry.ts）；隐式 any/命名误导（CQ-026/027/044-047）；静默 catch ×4（LC-024/026/027/028）；无分页（BP-014）；EventBus 每请求全表扫 seq（BP-013）；overflowHistory 无界（BP-012）；字符数≈token 估算对 CJK 失真 2-4 倍（AI-007）；agent 路由正则误判（AI-009）。
配置/工程：三份图标脚本重复（BUILD-02）、gen-liquid-map 硬编码相对路径（BUILD-03）、backend-bundle.js 入库（BUILD-04）、sql-wasm 2.5MB 入库（BUILD-06）、三处杀端口实现不一致（SCRIPT-03）、start.bat 绕过 npm start（SCRIPT-04）、start.ps1 注释过期（SCRIPT-02）、.gitignore 缺口（CONFIG-08）、.env.example 缺变量（CONFIG-06）、capacitor webDir 指向非 workspace 产物（CONFIG-05）、mobile tsconfig 漂移（MOBILE-04）、移动端与前端聊天逻辑 60% 重复（MOBILE-03）、koffi 无类型（DEP-03）、backend workspace 未声明实际依赖（DEP-05）。
UI/UX：动画常量不统一（stagger 0.04/0.05/0.1、lift -1/-3、scale 0.97/0.98）、4 种卡片圆角（14/16/22/24px）、50+ 内联 fontSize px、GradientShimmer 滥用、滚动条样式未全局应用、空状态不一致。
数据卫生：data/settings.json 含 3MB base64 背景图（DATA-02）、dist_exe_old_102205 残留含旧密钥副本（DATA-04）。

### C-3 P3 清单（41 项，分组）

`[SilentCatch]` 日志模式 ×15（A33）；`/* ignore */` 注释 ×50+（A34）；CodeTableView 折叠状态不持久（A50）；Library 重命名无键盘操作（A49）；chain-of-thought 绝对定位连线（A42）；CSP connect-src 通配端口（SEC-040）；Electron connect-src https: 全放（SEC-041/ELECTRON-01）；selfcheck/monitoring 信息暴露（SEC-024/026 降级部分）；crypto 明文告警日志（SEC-042）；MCP allowlist 含 deno/bun/java 可拉远程脚本（SEC-034）；MCP stdio 无 maxBuffer（SEC-035）；workflow allowlist 含 start/explorer（SEC-036）；sync 远程命令需审批（SEC-039）；export 无行数上限（SEC-028）；startup 日志过详（SEC-032）；shared 缺 subpath exports（SHARED-01）；baseUrl schema 空串合法（SHARED-02）；SSE_DONE 死导出（SHARED-03）；mobile LiquidGlassFilter 隐藏 SVG（MOBILE-05）；electron second-instance 不传 argv（ELECTRON-04）；backend 未处理 shutdown IPC 或致 DB 强杀（ELECTRON-05）；wechat-bridge 空目录（WECHAT-01）；docs 三处过时/矛盾（DOCS-01/02/03）；android 构建产物待清（ANDROID-01/02）；快速启动.bat 文件名乱码风险（SCRIPT-01）；dist 旧产物目录堆积。

---

## D. 重复问题清单（重点）

### 代码重复
| 重复内容 | 位置 | 数量 |
|---|---|---|
| force-summary 兜底 | agents:1076 / conversations:809 / sync:772 / workflows:175 | 4 |
| 工具结果去重 | agents:1066 / conversations:852 / sync:805 | 3 |
| isPathSafe 变体 | data:18 / media:12 / documents:34 / sync:241 | 4 |
| provider 连接测试 | providers:238 / data:212 / monitoring:95 | 3 |
| AI 分析提示词+解析 | agents:693 / conversations:574 | 2 |
| agent 主循环（maxTurns/compaction 等） | conversations:546 / sync:456 | 2 |
| 会话 CRUD + 轮询 | Chat / CodingHome / Layout | 3 |
| 流式发送 ~300 行 | Chat:276 / CodingHome:551 | 2 |
| 图标生成脚本 | build/gen-icon / generate-icon / make-ico | 3 |
| 杀端口逻辑 | start.bat / run.bat / start.ps1 | 3 |
| 移动端聊天 UI 与前端 | mobile/App.tsx vs Chat.tsx | ~60% |

### UI 重复
| 重复内容 | 数量 |
|---|---|
| 按钮系统（cva / hover-glow / .btn-primary） | 3 套 |
| loading/error/empty 三态手写 | 8+ 页 |
| toast 实现（Media 自研 / 系统通知 / 无） | 3 套 |
| Tabs 手写（Settings/Knowledge/Chat/CodingHome） | 4 处 |
| 内联卡片样式绕开 .glass-card | 50+ 处 |
| 模态（confirm-dialog / Settings 内联 portal / Projects） | 3 处 |

### 执行重复（一次动作多次执行）
| 链路 | 后果 |
|---|---|
| 远程命令：Layout 1.5s 轮询 + CodingHome 1.5s/2s 轮询（DEX-001/FE-01） | 双倍请求 + 竞态，可能重复执行 AI 任务 |
| mount 双加载（DEX-002/003、FE-06/07） | 双倍 providers/conversations 拉取 |
| streamClient envelope 双发射（ST-01） | 同内容 envelope+text-delta → 双渲染 |
| conversations-changed 事件 + mount effect（DEX-004） | CRUD 后重复拉列表 |
| 通知权限请求 ×3（Layout/CodingHome/Chat） | 重复提示 |
| MCP 工具清单每个 loop 轮次重拉（BP-009/010） | 30× 网络/FS 开销 |
| 状态检查进会话时 ×2（DEX-009） | 双倍状态请求 |

---

## E. 功能缺失清单

| 功能 | 当前状态 | 缺失 | 优先级 | 建议 |
|---|---|---|---|---|
| 工具箱 | README 自标 🚧 | 部分转换器未完成；音频处理未完成 | P1 | 完成或下架入口 |
| /api/export | 仅内联 data 数组 CSV/JSON/MD | 无法导出会话/知识库等 DB 数据 | P1 | 与 /api/export/all 合并统一 |
| 搜索 | 聚合 DDG/本地/网页 | 无排序、无分页、结果质量低 | P1 | 加 ranking + pagination |
| 记忆抽取 | 仅手动 /api/memory/extract | 无自动抽取调度 | P1 | 会话结束后台任务 |
| 工作流 | 顺序执行 | 无并行分支；循环图不报错 | P1 | 并行调度 + 环检测 |
| 同步冲突 | last-write-wins | 无冲突解决 | P2 | CRDT/版本向量或明示覆盖 |
| 监控 | models 顺序全量探测 | 无缓存、易撞限流 | P2 | 5min TTL 缓存 |
| 列表端点 | 全量返回 | conversations/agents/workflows/documents/media 无分页 | P2 | limit/offset 或游标 |
| 认证层 | 仅 CSRF header | 敏感端点无本地 token | P1 | localhost token + 审批流扩面 |
| 审计日志 | 无 | 命令执行/删文件/改设置/key 读取无痕 | P2 | 追加式安全日志 |

---

## F. UI / UX 问题清单

**一致性**：OKLCH 覆盖主题（UI-01 P0）；3 套按钮（UI-02 P0）；4 种卡片圆角；6 处硬编码 hex 破坏主题（confirm-dialog 蓝/红、Sidebar/CommandCenter text-white、AIAgentInput #64748b、Settings 功能组色、PageHeader 渐变、hover-glow 8 个色值）。
**布局**：CommandCenter/Knowledge/Settings 网格无移动端断点（P1）；Chat 1100px 定宽移动端横滚（P1）；Projects 行高 56px 定死文本截断（P1）。
**交互**：send 按钮无焦点环；tab 列表无方向键导航；消息列表无键盘可达；模态无焦点陷阱；Library 重命名无 Enter/Esc。
**响应式**：上述网格 + Settings 特性卡 <640px 不堆叠。
**可访问性**：图标按钮缺 aria-label（Sidebar/Settings tabs）；流式更新无 live region；缺 skip link；亮主题多处对比度不达标。
**美学**：不像同一产品——玻璃实现 3 种、动画常量 3 套、GradientShimmer 滥用、滚动条样式不一、亮主题定义两处冲突。
**动画**：page enter 双系统（CSS vs Framer）、stagger/lift/scale 常量不统一、流式渲染两路（rAF 批处理 vs 逐 token setState）。

---

## G. 架构问题

| 问题 | 影响 | 推荐架构 |
|---|---|---|
| 无服务层：路由 handler 内混 DB/AI 调用/工具执行/SSE（agents 2300 行 handler） | 不可测、改一处全身动 | handler → service → dal 三层；先拆 6 大 God 文件 |
| fetchWithRetry 被 5 模块从 conversations 反向 import | 循环依赖风险、职责错位 | 落 lib/fetch-retry.ts |
| 前端双聊天实现（Chat vs CodingHome）+ 三处会话 CRUD | 修 bug 要改 3 遍 | useConversations / useStreamSend / useMessagePolling hooks |
| 状态投影每次全量重算（activityStore） | O(n²) 渲染 | 事件溯源 + 增量投影 |
| 移动端独立 workspace 外、复制前端 60% | 双倍维护 | 纳入 workspaces，共享组件包 |
| sql.js WASM + 防抖 flush 自研持久化 | flush 竞态/断电窗口 | 中期评估 better-sqlite3（原生、事务、WAL） |
| 安全靠单点 isSafeFetchUrl/isPathSafe 且各有 4 变体 | 覆盖不齐即洞 | 单一 lib/path-guard.ts + lib/url-guard.ts，全模块强制引用 |
| 主题系统被 Tailwind OKLCH 层截胡 | 6 套主题形同虚设 | @theme 映射 CSS 变量，删 OKLCH 覆盖 |

---

## H. 修复路线图

```text
Wave 0（阻断项，先做）
  ├─ 构建链：test 前自动 build（修 33s 假失败）+ clean 跨平台（BUILD-01）
  └─ git 卫生：确认无仓库/初始化规范（后续改动可回溯）

Wave 1（P0 安全 13 项）
  ├─ 命令执行三处 → spawn argv + 内建原生化（SEC-001/002/003）
  ├─ 路径三处 → UUID 文件名重建（SEC-004/005/006）
  ├─ SSRF 四面 → isSafeFetchUrl 全覆盖 + 重定向逐跳（SEC-007/008/009/010）
  ├─ 密钥：落盘→DPAPI/钥匙串；明文回退拒绝（SEC-011/012）
  └─ 移动端 service_role → anon+RLS/后端代理（MOB-01）

Wave 2（P0 逻辑/协议/性能 27 项）
  ├─ 流协议 ST-01 envelope 双发射
  ├─ 前端轮询整合 FE-01/02/04/08 + mount 双加载 FE-06/07
  ├─ Abort 串话 FE-05 + 工具 abort BE-05
  ├─ 后端 BE-01..08（markDirty/await/拒绝/事务/heartbeat）
  ├─ 性能 PF-01..05（tokenTotal 列/工具预算/熔断/去 flushSync/增量投影）
  └─ 前端直改 FE-03/09/10/11（timer/假进度/getSupabase/同步竞态）

Wave 3（P0 结构 14 项 God 文件拆分）
  └─ 后端 10 + 前端 4，按路线图 H 顺序逐个拆分并回归

Wave 4（P1 86 项，按组批量）
  ├─ 安全认证层 + Swagger/CORS 生产化
  ├─ 重复逻辑归并 lib（force-summary/dedup/path-guard/provider-test/fetch-retry/agent-loop）
  ├─ UI Token 修复 + 共享组件库（Tabs/Input/EmptyState/Spinner/Modal）
  ├─ 测试补盲：核心模块优先（providers/conversations/agents/data/media）
  └─ 功能补全：export 统一、搜索分页排序、工具箱收尾

Wave 5（P2 79 项批量）
Wave 6（P3 41 项批量 + 文档/卫生）

每 Wave 后：typecheck + lint + build + test + 启动冒烟 → 全量复审
```

---

## 附：误报/降级记录（审计纪律）

| 原发现 | 处理 | 理由 |
|---|---|---|
| BD-002「路由无代码分割」 | ❌ 误报剔除 | App.tsx:44-62 全部 18 路由 lazy+Suspense（已复核） |
| DEP-02「@napi-rs/canvas 未使用」 | ❌ 误报剔除 | toolbox/index.ts:373,476 动态 import 使用 |
| DEP-04「drizzle-orm 死代码」 | ❌ 误报剔除 | db/client.ts:31 drizzle(sqlDb, {schema}) 实际在用 |
| DATA-01/02/03「敏感文件已提交 git」 | ⬇️ 降 P2 | 项目非 git 仓库（无 .git），风险转为本地卫生/分发前清理 |
| RUNTIME-02「stderr 为空疑似吞错」 | ⬇️ 降 P3 | 空=无错误，属正常；保留为日志观测改进 |
| ELECTRON-01「webPreferences 危险」 | ⬇️ 降 P3 | sandbox/contextIsolation/nodeIntegration 配置正确；仅 CSP connect-src 过宽（并入 SEC-041） |
| TEST-01「92% 模块零测试」 | ✏️ 修正 | 与后端 lane 对账：19/24 模块零测试 + lib 8/25 有测试（85 用例实测全绿） |
