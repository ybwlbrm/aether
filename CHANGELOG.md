# Changelog

> 注意：本机未安装 git，使用 CHANGELOG.md 追踪变更历史。

## [Unreleased]

### 2026-08-11 — Baseline & WeChat 修复增强

- **T0**: 初始化仓库基线（git 不可用，改用 CHANGELOG.md）
- 项目结构：
  - `src/` — 前端 (React 19 + Vite 6 + TypeScript + Tailwind 4) + 后端 (Fastify 5 + Drizzle ORM + sql.js)
  - `wechat-bridge/` — ACP 协议桥接器 (wechat-acp npm package)
  - `wechat_bridge.py` — 桌面版微信助手 Python 脚本
  - `wechat_bot/` — Python 微信桥接核心模块（model/parser/dedup/selffilter/queue/client/logger/dashboard）
  - `wechat-helper.mjs` — Node.js 微信辅助脚本
  - `data/` — 数据存储 (SQLite + JSON 文件)

### 2026-08-11 — WeChat 集成大修（T1-T12）

**共享类型（T1）**
- `src/shared` 新增 `WeChatUnifiedMessage` / `WeChatContact` / `WeChatControlConfig` 统一类型

**数据库（T2）**
- `wechat_messages` 表新增 `message_id`/`contact_id`/`contact_name`/`role`/`is_self`/`is_group`/`source`/`processed` 列
- 新增 `wechat_contacts` 表（id/name/ai_enabled/whitelisted）
- 守卫式迁移，旧库平滑升级无数据丢失

**Node 助手修复（T3）**
- 修复 `wechat-helper.mjs` 中 `new Promise(r=>setTimeout)` 未 await 的延迟 bug
- `parseMessages()` 重写：结构化消息 + 自身消息检测
- 新增 `--parse` CLI 模式

**后端模块化（T4-T8）**
- 拆分 `wechat/index.ts` → `routes.ts` / `config.ts` / `pipeline.ts` / `ai.ts`
- 统一 `POST /api/wechat/ingest` 接入管线：去重 / 白名单 / self-filter / 每联系人 AI 开关 / DRY RUN / NEED_OWNER / 上下文
- `ai.ts` 使用加密 provider store（`getProviderByCapability`），不再读取明文 `.wechat-config.json`
- 新增 `GET/PUT /api/wechat/control`、`PUT /api/wechat/contacts/:id`、`GET /api/wechat/stats`

**ACP 桥接修复（T9）**
- `get-qr-url.mjs` 改用包导入
- `agent.mjs` 走 `/api/wechat/ingest`，移除直接 LLM 调用与 API Key
- `desktop/stop` 改为按 PID 精准终止（不再误杀所有 python.exe）

**Python 主循环重写（T10）**
- `wechat_bridge.py` 重塑为薄协调器：窗口标题识别联系人 → 剪贴板解析 → 去重/自过滤 → 批量队列(3s窗) → ingest → 按状态回复
- 集成 `wechat_bot` 模块，控制台仪表盘 + 结构化日志
- 修复任务模板的 frozen dataclass 崩溃与 dedup 时间戳不稳定问题

**前端控制面板（T11)**
- `WeChat.tsx` 新增统计卡片（今日收到/AI回复）、全局 AI 开关、DRY RUN 开关、每联系人 AI/白名单开关
- 新增 ACP 桥接标签页（二维码登录/状态轮询/启停/日志查看）
- `client.ts` 新增 getControl/saveControl/updateContact/getWeChatStats

**验证（T12）**
- `npm run build` 全绿；后端 14 测试 + Python 73 测试全过
- 冒烟验证：DRY RUN / 去重 / self-filter / auto-reply 关闭 / 统计 全部通过

### 2026-08-11 — 修复两种桥接方法（第二轮）

**ACP 桥接修复**
- 重写 `get-qr-url.mjs`：直接调用微信 iLink HTTP API（`/ilink/bot/get_bot_qrcode`），不再依赖 `wechat-acp` 包的子路径导入（该包 exports 未暴露子路径）
- 二维码获取恢复正常 ✅

**桌面版 Python 桥接修复**
- `parser.py` 新增 `extract_contact_from_clipboard()`：从剪贴板第一行非空/非时间行提取联系人名（微信 4.0 窗口标题始终是"微信"，不可靠）
- `connect_wechat()` 重写：按 Qt 窗口类名（`Qt51514QWindowIcon`）识别主窗口，替代按标题匹配
- 主循环改为从剪贴板内容提取联系人，而非窗口标题
- `desktop/status` 改为按 PID 文件检查进程存活，替代旧的 `tasklist` 脚本名匹配（永远查不到）

### 2026-08-11 — 移除微信功能（用户要求）

由于微信官方对个人微信消息监控的限制，决定移除所有微信相关功能。
- 删除前端 WeChat 页面、侧边栏入口、命令面板入口
- 删除后端 wechat 模块（ingest pipeline、AI 服务、路由）
- 删除 Python 桥接（wechat_bridge.py、wechat_bot/）
- 删除 ACP 桥接（wechat-bridge/、agent.mjs、get-qr-url.mjs）
- 删除微信相关数据文件、登录 token
- 保留基础架构不变，以后可复用