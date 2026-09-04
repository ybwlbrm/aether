# 项目全维度审计报告（第三轮）

> 审计对象：Aether (D:\PersonalAICommandCenter)
> 审计日期：2026-08-22（第三轮，前两轮已修复 77 项）
> 审计方式：5 路并行探索 Agent 深度源码审计 + 动态 API 回归验证 + 全量构建验证 + 运行时行为验证
> 技术栈：React 19 + Vite 6 + Fastify 5 + Drizzle ORM + sql.js + Electron + Capacitor Android

---

## A. 项目总体评分

```
代码质量：74/100
架构：76/100
功能完整度：72/100
逻辑可靠性：68/100
稳定性：75/100
性能：62/100
安全：70/100
UI 一致性：65/100
UX：67/100
视觉审美：78/100
可维护性：65/100

总评分：70.4/100
```

> 说明：项目基础设施安全架构（CSP/Host 校验/CSRF 白名单/加密存储）经动态验证均有效；
> 但存在 3 个运行时确认的隐藏逻辑缺陷 + 大量历史债务（3.18MB settings、God 组件、零测试覆盖）。

---

## B. 问题总数

```
P0：3
P1：24
P2：31
P3：15
总计：73
```

---

## C. 问题详细清单

### 🔴 P0 级（3 项）— 动态验证确认的致命缺陷

#### P0-1：Workflow 执行 BFS 只从第一个根节点开始 → 多根 DAG 后半部分节点永不执行
- **文件**：`src/backend/src/modules/workflows/index.ts:494`
- **动态验证 ✅**：创建 3 节点（root1→leaf, root2→leaf）工作流，运行结果 `{"root1":{...},"leaf":{...}}` — **root2 及依赖它的下游节点被静默跳过**，但 run 状态仍标记 `completed`，用户无感知数据缺失
- **根因**：`queue = ordered.length > 0 ? [ordered[0].id] : []` 只以一个根节点为 BFS 起点；topoSort 返回多个入度为 0 的根节点时，其余根及其子树全部丢弃
- **影响**：复杂并行工作流（多个独立入口）执行不完整，输出静默缺失
- **修复方案**：将所有入度为 0 的节点全部入队（`execSet` 提取），或遍历 ordered 中所有未被 visited 的节点

#### P0-2：AI 文件工具命令执行白名单含 `cmd`/`powershell` → 命令安全限制完全失效
- **文件**：`src/backend/src/modules/data/index.ts:189,241`、`src/backend/src/modules/workflows/index.ts:256`、`src/backend/src/modules/toolbox/index.ts`
- **动态验证**：`SAFE_COMMANDS` 含 `cmd`；`spawn('cmd.exe', ['/s','/c', cmd])` 时 cmd 可重新解析任意命令 → `cmd /c powershell -c ...`、`cmd /c reg add ... autorun` 全部绕过 FORBIDDEN_COMMANDS 子串扫描
- **根因**：`cmd`/`powershell`/`pwsh` 作为"白名单可执行程序"，等于给 AI（可被提示注入诱导）打开了任意命令执行大门
- **影响**：AI 生成的命令/被 prompt 注入的 Agent 可执行任意系统命令（不只被禁止的 format/del 等）
- **修复方案**：从白名单移除 `cmd`/`powershell`/`pwsh`/`start`；保留位 mapping 则改为参数级校验（拒绝 `/c`、`-Command`），或对含幂等命令的模式改为人工确认

#### P0-3：Mobile 端 Supabase service_role Key 明文持久化 → 数据库全量控制权外泄
- **文件**：`src/mobile/src/api/supabase.ts:40`、`src/mobile/src/App.tsx:138,148`
- **证据**：`saveConfig()` 将 `supabaseKey` 明文写入 `localStorage('aether_supabase_key')`；用户被引导填写 **service_role key**（文档 `data/supabase-fix-rls.sql` 显示用 service_role 直连绕过 RLS）
- **根因**：客户端直连 Supabase 使用 service_role（绕过 RLS 的超级权限）而非 anon key + 行级安全
- **影响**：设备丢失/WebView 备份/任意 XSS 均可提取 key → 攻击者获得整个数据库读写权
- **修复方案**：CSP 期间先加 `allowBackup=false`（Android）+ 提示改用 anon key；长期统一走后端同步代理

---

### 🟠 P1 级（24 项）

| ID | 文件:行号 | 类别 | 问题 | 影响 | 修复方案 |
|---|---|---|---|---|---|
| P1-1 | conversations/index.ts:373 / agents:725,837 | 稳定性 | SSE body `reader.read()` 无超时（fetchWithRetry 120s 只覆盖响应头） | AI 半开连接 → 请求/socket 永久挂起 | 每轮 `reader.read()` 用 Promise.race 60s 超时 |
| P1-2 | conversations:464 / agents:775 | 稳定性 | `callMcpTool` 无超时（MCP server 无响应时 await 永久挂起） | SSE 卡死，客户端必须断连 | Promise.race 加超时 + abort |
| P1-3 | agents/index.ts:754-757 | 逻辑 | 工具调用分块累积未校验 `tc.index`（conversations:417 有 last.index 校验，agents 缺） | 模型分多次返回同 index 工具块时参数丢失/覆盖错误 | 对齐 conversations 的 last.index 校验 |
| P1-4 | data/index.ts:92-94 | 安全 | `/api/settings/security` 的 allowedDirs 校验 `.filter(d => existsSync(d) \|\| d.includes('workspace'))` | 任意含 "workspace" 子串的不存在路径可通过 → 越权目录 | 移除 includes 宽松匹配，严格 existsSync |
| P1-5 | data/index.ts:485,514 / media:349,382 / documents:168,247 | 逻辑 | 删除/导入路径校验用 `config.allowedDirs`，但媒体/文档实际存于 `config.dataDir/**` | allowedDirs 与存储目录同源冲突 → 自产文件的校验失败，删除时 unlink 不执行，孤儿文件堆积 | 校验集追加 dataDir 子目录 |
| P1-6 | data/index.ts:38-39 vs :67 | 性能 | bgImages（数组）未迁移；背景图 base64 仍内嵌 settings.json | 3.18MB settings 每次 GET /api/settings 与每次对话 getSettings() 全量传输+解析 | 迁移逻辑扩展到数组；getSettings 加缓存 |
| P1-7 | agents/index.ts:446,455 | 逻辑 | customPrompts Map 只写不读（死代码）；`agent.systemPrompt =` 直接修改模块级共享对象且不持久化 | 用户改的 Agent prompt 重启丢失；多会话全局污染 | 移除模块级 mutation，写 DB/持久化 |
| P1-8 | data/index.ts:453-476 | 数据 | 导入重建消息 `delete(messages)` + insert 无事务 | 导入中断 → 消息半删半插，对话完整性破坏 | 包 db.transaction |
| P1-9 | documents/index.ts:196,215 | 安全 | preview 路径 `${id}.preview.json` 未校验 id 为 UUID | `id=../../data/settings` 可读目录外文件（读-改-写链） | id 必须匹配 UUID 正则否则 404 |
| P1-10 | media/index.ts:25-36,275-281 | 安全 | SVG 占位图将 apiError/提示文本直接拼 `<text>` 未 XML 转义 | stored-XSS（image/svg+xml 同源加载） | 转义 `&<>"`；失败时不写占位文件 |
| P1-11 | toolbox:256,677-680 | 安全 | 转换变量 target / 下载 :filename 无格式校验 | 目录穿越（写/读任意目录） | 统一 safeFilename() 白名单 |
| P1-12 | conversations:330-357 | 性能 | `listMcpTools()` 在 SSE headers 已发送后才串行加载所有 MCP server | 慢 MCP server 拖慢所有消息；15s+ 只见 heartbeat | TTL 缓存 + listMcpTools 前置或降级 |
| P1-13 | agents:550-554 | 逻辑 | agent model 为空时直接透传 `model: ''` | AI API 400，SSE 直接 error，用户无解释 | `cfg.model || p.defaultModel` |
| P1-14 | workflows/index.ts:460-466 | 稳定性 | workflow run（同步请求）无客户端断开信号，节点循环等待全部完成 | 客户端断连后仍执行全部节点（浪费 AI 调用/副作用） | 注入 abort signal |
| P1-15 | selfcheck/index.ts:119-136 | 逻辑 | 依赖完整性检查用 `process.cwd()` 找 node_modules | 从 src/backend 启动时误报"缺 22 个依赖"（动态验证：error 状态） | 用 config 根/包解析路径 |
| P1-16 | mobile MessageView:146 / NewCommand:229 | 逻辑 | 远程命令前标记 `[mode=][level=]` 双轨不统一（NewCommand 加密、MessageView 不加密） | 手机端双向收发的命令解析不一致 → 部分命令静默失败 | 统一协议 |
| P1-17 | mobile MessageView:148-151 / NewCommand:230-233 | UX | 错误被吞（sendCommand 返回 false 无提示；temp 消息移除无错误状态） | 用户发送失败完全无感 | 失败时恢复临时消息+toast |
| P1-18 | electron/main.js:155 | 安全 | 无 `setWindowOpenHandler`/`will-navigate` 防护（外链新窗口） | target=_blank 链接打开不受控 BrowserWindow | 外链改 shell.openExternal + 拒绝渲染层开窗 |
| P1-19 | electron/main.js:183-190 | 安全 | ipcMain 'show-notification' 无 sender 校验 | 受限渲染进程可伪造通知（低危） | 校验 event.senderFrame 为主 frame |
| P1-20 | android/AndroidManifest.xml:5 | 安全 | `android:allowBackup="true"` | WebView localStorage（含 key）可被 ADB/云备份提取 | allowBackup=false |
| P1-21 | capacitor.config.ts:4 vs gradle:7 | 架构 | appId 漂移：config `com.pacc.mobile` vs gradle `com.pacc.app` | 重打 cap sync 时应用 ID 被覆盖，签名/上架不一致 | 统一为单一 appId |
| P1-22 | electron-builder.yml:9-33 | 打包 | files 清单缺 playwright/playwright-core 系列（build-exe.js 有，builder.yml 无） | electron-builder 产出的应用 /api/testing 崩溃 | 两套打包脚本 files 统一 |
| P1-23 | workflow system 节点 & data exec | 安全 | 危险命令过滤基于子串，`rd /s /q`、`rmdir`、`taskkill` 等可绕过；cmd 兜底（见 P0-2） | 命令限制可被绕过 | 改用解析式命令校验 |
| P1-24 | 全项目 | 测试 | **测试覆盖为 0**：`npm run test` 显示 0 tests（shared/backend 0 用例，vitest "No test files found" code 1） | 无回归防护 | 为核心模块补最小冒烟测试 |

---

### 🟡 P2 级（31 项，节选高价值）

| ID | 文件:行号 | 类别 | 问题 |
|---|---|---|---|
| P2-1 | frontend 58 处 `alert()` | UX | 全站错误反馈用原生 alert（阻塞式、不可样式化、无法堆叠）→ 统一 toast |
| P2-2 | workflows:283 | 逻辑 | 未知节点类型返回文本"未知节点类型"但 run 状态是 completed — 半失败静默 |
| P2-3 | media:191-219 | 稳定性 | 视频生成轮询 60×5s 无客户端断开快速中止（只每轮检测 request.raw.destroyed） |
| P2-4 | media/documents | 性能 | readFileSync 全量读入内存（大文件/大图片无大小上限） |
| P2-5 | toolbox pdf-read `scale:1.5` | 性能 | A0 超大幅面 PDF 渲染 → canvas 超大 → OOM |
| P2-6 | conversations GET list | 性能 | 每次列表请求全表扫描 assistant 消息计算 tokenTotal |
| P2-7 | conversations:131-155 | 性能 | 获取对话全量消息无分页（长会话全量载荷） |
| P2-8 | store/app.ts:6-22 | 死代码 | sidebarOpen/currentRoute/setSidebarOpen/setCurrentRoute 从未使用 |
| P2-9 | hover-glow-button.tsx | 死代码 | 整个组件 14KB 未被任何文件引用（死包） |
| P2-10 | PromptTemplateSelector:30-84 | 死代码 | saveTemplate/deleteTemplate/persist 三个函数从未被调用 |
| P2-11 | Layout.tsx:58 | 死代码 | 动态 import client.js 与顶部静态 import 重复 |
| P2-12 | AIAgentInput:12,74 | 死代码 | isFocused state 未读取；onFocus 空 handler |
| P2-13 | vite.config.ts:26-31 | 架构 | radix-vendor 手动 chunk 指向已不使用的 radix 组件（已换 base-ui） |
| P2-14 | base.css:377 | UX | `.streamdown button:not(.CodeTableView *) { display:none }` 隐藏 Streamdown 全部渲染按钮 |
| P2-15 | 组件级代码 | 一致性 | 硬编码颜色 #5e9eff/#a78bfa/#0d1117/#94a3b8 遍布 15+ 文件，绕过 design tokens |
| P2-16 | confirm-dialog:96-108 | UX | 按钮顺序（取消左/确认右）与全站其他表单相反，破坏肌肉记忆 |
| P2-17 | Media.tsx:337,364-368 | 稳定性 | `clearInterval(progressIntervalRef.current!)` 非空断言可能 TypeError |
| P2-18 | useAutosaveDraft:27-39 | 逻辑 | key 切换时旧 key 草稿不 flush 被 clearTimeout 丢弃，且旧值写入新 key |
| P2-19 | Layout:20-25 | 稳定性 | sampleLuminance 的 getImageData 无 try/catch（跨域图/污染 canvas → SecurityError） |
| P2-20 | client.ts:57-63 | 逻辑 | mergeSignals polyfill：并发共享 signal 时 A 的 cleanup 清掉 B 的 abort 监听 |
| P2-21 | client.ts:203-207 | 逻辑 | SSE 结束只 flush decoder tail，buffer 未收官（末事件无空行时丢失） |
| P2-22 | 前端路由 60+ useEffect | 稳定性 | 大量 useEffect 无 cancelled 守卫/清理（快速切换可能 setState）
| P2-23 | hover-glow 432 span | 性能 | 每个 hover 按钮渲染 432 个 span + 432 条 CSS rule → DOM/CSS 爆炸 |
| P2-24 | Media/Toolbox 假进度条 | UX | setInterval 假进度到 90%，与真实无关 |
| P2-25 | mobile supabase.ts:152-229 | 稳定性 | Realtime 订阅无错误回调/重连策略（断线后不自动恢复） |
| P2-26 | mobile Resource | UX | AppearanceSettings bgMsg 赋值未使用（死变量） |
| P2-27 | start_dev.bat | 构建 | dev 脚本不杀 3000 端口（start.bat 有），双跑冲突 |
| P2-28 | deploy.bat | 构建 | UTF-8 with BOM → cmd 首行 `@echo off` 失效乱码 |
| P2-29 | android strings.xml | 品牌 | app_name "Personal AI Command Center" 与 Aether 品牌不一致；图标仍 Capacitor teal 默认 |
| P2-30 | electron Tray | UX | tray 用 `nativeImage.createEmpty()` 空白图标 |
| P2-31 | Search/知识库 | 功能 | 搜索知识库结果 url:'' 已修但相关数据源覆盖仍不完整 |

---

## D. 重复问题清单（专项）

| # | 类型 | 位置 | 说明 |
|---|---|---|---|
| D-1 | 重复执行 | layouts 轮询 /api/sync/latest-command (1.5s) + CodingHome 轮询 command-status | 双轮询链，同一命令双重状态查询 |
| D-2 | 重复实现 | conversations/agents/workflows 三处 fetchWithRetry + SSE 解析器 | 应抽取公共 lib（历史建议未落地） |
| D-3 | 重复代码 | Layout.tsx 静态+动态双 import client | 见 P2-11 |
| D-4 | 重复功能 | Settings.tsx 的 saveSettings vs saveSecuritySettings 双通道 | 已迁移但旧分支还在 |
| D-5 | 重复组件 | 全站 15+ 文件硬编码玻璃样式 / 硬编码颜色替代 token | 见 P2-15 |
| D-6 | 双数据源 | memories 表 vs memory.json（dal.ts 双读兼容，写时只走 DB） | 兼容期残留 |
| D-7 | 双打包 | build-exe.js（@electron/packager 手工）与 electron-builder.yml（asar NSIS）并行 | files 清单漂移（P1-22） |

---

## E. 功能缺失清单

| 功能 | 当前状态 | 缺失内容 | 优先级 |
|---|---|---|---|
| AIAgentInput 语音/文件/图片 | stub（只是发文本） | 真实录音/上传/图片理解 | P2 |
| Agent 定时任务/MCP 工具 | enabled:false "规划中" | AgentSettings 已声明但未实现 | P3 |
| 工作流画布可视化 | 节点列表+连线 已实现 | 但多个根节点执行 bug（P0-1） | P0 |
| 知识库双链 | 未实现 | 双链跳转 | P3 |
| 自动生成的对话标题 | 有 | emoji 截断 surrogate pair（已记录 P2-16 旧） | P3 |
| 移动端 AI 调用 | 只能发远程命令 | 移动端无法独立配置 Provider | P3 |
| 测试 | **0 个测试文件** | shared/backend/frontend 全无 | P1 |

---

## F. UI / UX 问题清单（分类）

| 分类 | 问题 |
|---|---|
| 一致性 | 全站 alert() vs toast 混用；硬编码色/圆角/阴影绕过 token（P2-15）；confirm-dialog 按钮顺序相反（P2-16）；Streamdown 按钮被 CSS 隐藏（P2-14） |
| 布局 | Settings 1249 行 God 组件（已知债务）；Chat/CodingHome 28-29 个 useState（组件过大） |
| 交互 | 假进度条（P2-24）；停止/重新发送竞态已修但 Chat:665-669 停止按钮状态冗余 |
| 响应式 | 无自定义 media query，Toolbox grid-cols-4 无响应式前缀（历史记录仍未修） |
| 可访问性 | CommandPalette/PromptTemplateSelector 无 aria-label/activedescendant/Esc；CodeTableView 折叠 div 无键盘 |
| 美学 | 页面 A（command-center 精致）vs 页面 B（Settings/Providers 表单密集）风格落差；hover-glow 432 span 过度工程 |
| 动画 | Vault 每密码条目全 motion 动画；Layout 主题切换画布 repaint hack |

---

## G. 架构问题

| 问题 | 影响 | 推荐架构 |
|---|---|---|
| allowedDirs（用户配置工作目录）与 dataDir（应用存储）边界混用 | 删除/导入/文件工具校验互相打架（P1-5） | 统一路径权限模型：`allowedDirs ∪ {dataDir}`，校验函数集中到 lib/paths |
| 双打包脚本并行 | asar/fork 兼容性问题 + files 清单漂移 | 收敛为一套（建议 build-exe.js 保留，删除/弃用 electron-builder.yml 或反之） |
| 客户端直连 Supabase | service_role 泄漏=全库失控（P0-3） | 走后端 sync 代理 + RLS + anon key |
| conversations 模块导出 fetchWithRetry 被 agents/workflows/documents 引用 | 跨模块隐式耦合 | 抽 lib/ai-client.ts |
| sync 模块 47KB 单文件 | God Module | 拆分（config/realtime/api） |
| 设置双轨（DB providers + settings.json） | 数据一致性风险 | 全量迁移到 DB |

---

## H. 修复路线图

```
P0（3项）
├── P0-1 Workflow BFS 多根执行修复          [动态验证确认]
├── P0-2 命令白名单剔除 cmd/powershell       [安全]
└── P0-3 Mobile key 存储安全兜底             [安全]
↓
P1（24项，按序）
├── 运行时稳定性：SSE read 超时 / MCP 超时 / 工具 index 校验 / workflow abort
├── 安全：allowedDirs 严格校验 / doc preview UUID / SVG 转义 / filename 白名单
├── 数据：导入事务 / bgImages 迁移 / settings 缓存 / customPrompts 持久化
├── 平台：electron 开窗防护 / Android allowBackup / appId 统一 / builder files 对齐
├── 正确性：selfcheck cwd / agent model 空 / mobile 协议统一 / 测试补冒烟
↓
P2（31项）
├── 死代码清理（store/hover-glow/prompt 模板/动态 import）
├── UX 统一（alert→toast / 按钮顺序 / 假进度条）
├── 性能（大文件上限 / token 扫描 / chunk 拆分）
└── 平台（deploy.bat BOM / start_dev 端口 / 品牌图标）
↓
P3（15项）
├── God 组件拆分、动画优化、accessibility 完善
```

---

## 动态验证证据（本报告关键事实）

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | ✅ PASS（shared+backend+frontend） |
| `npx eslint src/` | ✅ 0 errors / ⚠️ 501 warnings |
| `npm run build` | ✅ PASS（chunk 超 500KB 警告 4 块） |
| `npm run test` | ❌ **0 test files**（vitest code 1） |
| `GET /api/health` | ✅ 200 |
| `POST /api/conversations` 无 XRW | ✅ 403 CSRF 拦截（预期） |
| `POST /api/conversations/:id/messages` | ✅ SSE 200（retry→reasoning 流 + 429 退避有效） |
| `GET /api/providers` | ✅ apiKey 全部掩码 `***encrypted***` |
| `GET /api/settings` | ⚠️ 200 但 **3.18MB**（bgImage base64） |
| `GET /api/selfcheck` | ❌ error：**缺 22 依赖（cwd 误报）** |
| `GET /api/monitoring/system/models` | ✅ 200（provider 状态实时） |
| Workflow 双根节点 run | ❌ **root2 未执行但 status=completed（P0-1 实锤）** |
| CSP/XFO/Host 校验 | ✅ 全部生效 |