# Aether · 个人 AI 指挥中心

> **本地优先的 AI 工作操作系统**：对话、智能体编排、工具箱、知识、文档、记忆一站式，AI 功能全都在你自己的电脑上跑。
>
> 所有数据保存在本地，不上云。真正的隐私全权由你掌控——AI 能力、数据、记忆全部属于你。

---

## ✨ 这是什么

Aether 是一个把 **AI 对话、多 Agent 协作、自动化工具箱、知识管理、文档生成** 整合在一起的桌面操作系统级应用。它不是又一个聊天机器人，而是一个让你用自然语言指挥一组 AI「员工」分工协作的工作平台。

| 模块 | 说明 |
|------|------|
| 💬 **AI 对话** | 流式对话，模型切换、深度思考 / 联网 / 循环模式，多 Agent 编排（11 个内置 Agent） |
| 🧠 **Agent 协作** | 多 Agent 分工执行：规划 / 编写 / 审查 / 检索 / 图片分析；MCP 工具即插即用 |
| ⚙️ **工具箱** | 格式转换（PDF/Word/Excel/图片/音视频）、YouTube 下载、音视频提取，内置 ffmpeg/yt-dlp |
| 🔍 **聚合搜索** | 无注册多路搜索（DuckDuckGo / 本地文件 / 网页），结果导出 CSV / JSON / Markdown |
| 📚 **知识库** | 收藏夹、便签、Wiki 页面，AI 自动打标签、按需检索 |
| 🤖 **AI 媒体** | AI 生成 / 编辑图片、视频、音频 |
| 📄 **文档生成** | AI 一键生成 PPT / Word 文档 |
| 🛡️ **安全中心** | API Key AES-256-GCM 加密存储，钥匙由 Windows DPAPI 保护，SSRF 防护，路径越界拦截，命令白名单 |
| 📊 **系统监护** | CPU / 内存 / 磁盘实时监控、模型用量统计 |
| 🔄 **多端同步** | 6 种语言切换，Android APK，可选 Supabase 云端同步 |

---

## 🏗️ 核心架构（Aether 2.0 Runtime）

Aether 2.0 引入了一套 **事件驱动、可恢复、可扩展的 Runtime 分层架构**。它把「功能丰富的 AI 工作台」升级成真正的「Personal AI Operating System」。

```
┌─────────────────────────┐
│       AETHER UI         │  React 19 · 20 路由 · 活动流投影
└────────────┬────────────┘
             │  标准化 Event（SSE / afterSeq 断线续传）
┌────────────▼────────────┐
│     EVENT RUNTIME       │  EventBus / EventStore(SQLite)
│  Replay / Sequence      │  37 种判别联合事件 · chunk 打包
└────────────┬────────────┘
┌────────────▼────────────┐
│      RUN RUNTIME        │  createRun/start/pause/resume/cancel
│  Checkpoint / Resume    │  runs/tasks 状态机 · token 统计
└────────────┬────────────┘
┌────────────▼────────────┐
│     AGENT RUNTIME       │  Planner / Worker / Supervisor
│  Handoff / Blackboard   │  AgentRegistry · 预算限制
└──────┬──────────┬───────┘
       │          │
┌──────▼──────┐ ┌─▼──────────┐ ┌─────────────┐
│MODEL RUNTIME│ │TOOL RUNTIME│ │MEMORY RUNTIME│
│Provider适配 │ │ToolRegistry│ │4层记忆+检索 │
│OpenAI兼容   │ │Capability  │ │回退/衰减    │
└──────┬──────┘ └─┬──────────┘ └─────────────┘
       └──────────┼────────────────┘
┌─────────────────▼─────────────────┐
│   RESOURCE / SECURITY 层          │
│  FS / Network / OS / Approval    │
└───────────────────────────────────┘
```

### 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 · Vite 6 · TypeScript · Tailwind CSS 4 · Framer Motion · Zustand |
| 后端 | Fastify 5 · Drizzle ORM · sql.js (SQLite) · Zod |
| 桌面 | Electron 43 · electron-builder（NSIS 安装包） |
| 移动 | Capacitor 8 · Supabase Realtime（可选同步） |
| 安全 | AES-256-GCM + Windows DPAPI · SSRF 防护 · 路径守卫 · 命令白名单 |
| Runtime | 事件分发 · Run 生命周期 · Agent 编排 · 模型/工具/记忆统一运行时 |

### Aether 2.0 新增核心（`src/backend/src/core/`）

| 子模块 | 内容 | 文件数 |
|--------|------|--------|
| `runtime/` | Run/Task 状态机、生命周期、取消令牌、Checkpoint | 15 |
| `events/` | EventBus / EventStore(SQLite+内存) / Replay / Sequence / Projector / SSE Transport / Chunk Packing / LegacyAdapter | 23 |
| `models/` | ModelRuntime / StreamingClient / ModelRegistry / ProviderAdapter / 用量统计 | 15 |
| `agents/` | AgentRuntime / AgentRegistry / 消息 / Handoff / Supervisor / 旧 AGENTS 迁移 | 17 |
| `tools/` | AetherTool / ToolRegistry / ToolExecutor / ToolPolicy / 超时 / 结果联合类型 | 13 |
| `permissions/` | Capability / PolicyEngine / ApprovalManager | 7 |
| `memory/` | MemoryStore / MemoryRuntime / MemoryRetriever（keyword+hybrid 打分） | 6 |
| `artifacts/` | ArtifactStore / ArtifactRuntime（文件产物注册） | 5 |
| `errors/` | RuntimeError 层次（Model/Tool/Retry 派生） | 6 |

> 事件协议 v2：37 种判别联合（run/task/agent/message/tool/token 全生命周期），统一携带 `version` + `runId` + `seq`，支持 replay 与断线续传。

### 关键能力速览

- ✅ **Run API**：`/api/runs` 7 端点 + `/api/runs/:runId/events?afterSeq=` 增量回放 + `/api/runs/:runId/stream` SSE 实时流（支持 Last-Event-ID 断线恢复）
- ✅ **迁移 v10-v12**：`runs` / `tasks` / `events` 三表，`UNIQUE(run_id, seq)` 保证并发安全
- ✅ **旧系统兼容**：legacy adapter 双向映射（activity_events ↔ events），不推倒重来
- ✅ **26 个后端模块、120+ API 端点、864+ 自动化测试**

---

## 🚀 快速开始

### 环境要求

- **Node.js 18+**（推荐 20/22 LTS）
- **Windows 10/11**（桌面版）/ 现代浏览器（Localhost 版）
- 可选：**JDK 21 + Android SDK**（用于构建移动端 APK）

### 版本 A：Localhost 版（零安装）

```bash
# 1. 安装依赖
npm install

# 2. 构建
npm run build

# 3. 启动
npm start
```

访问 **http://127.0.0.1:3000**

> 也可以直接双击 `start.bat` 一键启动。

### 版本 B：EXE 桌面版

```bash
# 一键生成便携版 + NSIS 安装包
npm run build:exe
```

产物位于：
- `dist_exe/` → 便携版（`启动应用.bat`）
- `dist_electron/` → NSIS 安装包（`Aether Setup 1.0.0.exe`）

### 版本 C：Android APK

```bash
# 1. 构建移动端前端
npm run build:mobile

# 2. 同步 Capacitor
npx cap sync android

# 3. 构建 APK（需 JDK 21 + Android SDK）
cd android
gradlew.bat assembleRelease   # Windows
./gradlew assembleRelease     # macOS / Linux
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

> **APK 签名（可选，推荐）**：未签名 APK 可直接安装自测；正式分发建议签名。
> ```bash
> keytool -genkeypair -v -keystore android/aether-release.jks \
>   -alias aether -keyalg RSA -keysize 2048 -validity 10000
> ```
> `keystore.properties` 与 `*.jks` 已被 `.gitignore` 排除，**不会进入源码仓库**。

### 开发模式（热更新）

```bash
npm run dev
```

---

## 📖 从零开始的运行指南

> 如果你是第一次接触本项目，按下面的顺序一步步来。

### 第 1 步：准备环境

| 工具 | 用途 | 下载 |
|------|------|------|
| Node.js 20+ | 运行与构建 | https://nodejs.org |
| Git | 拉取源码 | https://git-scm.com |
| （可选）JDK 21 | Android APK | https://adoptium.net |

### 第 2 步：拉取并安装

```bash
git clone https://github.com/ybwlbrm/aether.git
cd aether
npm install
```

> 国内网络较慢可切换镜像源：`npm config set registry https://registry.npmmirror.com`

### 第 3 步：构建并启动

```bash
npm run build
npm start
```

访问 **http://127.0.0.1:3000**

> Windows 用户也可以直接双击 `start.bat`。

### 第 4 步：配置 AI

1. 进入 **设置 → AI Provider**
2. 添加你的 AI Provider
3. 填入：名称（例如 `DeepSeek`）、类型、Base URL（如 `https://api.deepseek.com`）、**你的 API Key**、模型列表
4. 保存后到「AI 对话」即可使用

### 常见问题

| 问题 | 解决 |
|------|------|
| `npm install` 慢/失败 | 切换到国内镜像（如上） |
| 启动后页面打不开 | 检查端口 3000 是否被占用，杀掉进程后重试 |
| 输入 API Key 报错 | 前往 设置 → AI Provider，确认 Key 与模型填写正确 |
| Setup 安装到自定义目录后出错 | 已改为动态路径解析，任意目录克隆均可用 |
| 想换语言 | 设置 → 界面 → 6 种语言切换 |
| 数据在哪里 | `data/` 目录（数据库 + 配置），备份迁移整个目录即可 |

---

## 🔐 安全设计

**安全第一** 是本项目的核心原则。

- 🗝️ **密钥安全**：API Key 使用 AES-256-GCM 加密存储，签名在 Windows DPAPI 中由系统保护
- 🛡️ **SSRF 防护**：所有出站请求经过 URL 校验（拒绝内网 / 元数据 / 重定向至敏感地址）
- 📂 **路径守卫**：文件访问基于白名单目录 + UUID 文件名，杜绝路径穿越
- ⛔ **命令白名单**：终端 / 数据处理执行时 spawn + 参数校验，防注入
- 🔑 **端点认证**：敏感端点（终端执行 / 数据导入导出 / MCP 测试）受 Bearer Token 保护
- 🌐 **CSP/CORS**：严格内容安全策略 + CORS 白名单 + Host 校验（防 DNS Rebinding）
- 🏠 **数据本地化**：所有数据存储在本地 `data/` 目录，随时可备份迁移

---

## 🧪 测试与质量

```bash
# 全量测试（shared + backend + frontend）
npm test

# 分端测试
npm run test:backend
npm run test:frontend

# 类型检查
npm run typecheck

# Lint
npm run lint
```

当前质量基线：**864+ 自动化测试**（backend **795** + shared **32** + frontend **37**）+ TypeScript 严格模式 + ESLint。

---

## 🤝 贡献

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/xxx`
3. 提交修改，遵循项目规范
4. 发起 Pull Request

### 代码规范

- TypeScript 严格模式，禁止 `any` 滥用
- 无分号、2 空格缩进
- 业务数据访问统一走 `lib/dal`
- 出站请求必须经 `lib/safe-fetch`
- 文件访问必须经 `lib/path-guard`
- **新增 Runtime 逻辑放在 `src/backend/src/core/`**（transport-agnostic，禁 Fastify/SSE/React 依赖）；旧系统经 adapter/bridge 渐进迁移，不推倒重来

---

## 📄 License

本项目基于 [MIT License](LICENSE) 开源。

---

## 💬 免责声明

- 本项目为**本地优先**应用，不会上传你的 API Key 与本地数据
- 项目持续迭代中，可能随版本升级出现变化
- 使用 AI 生成内容时，请遵守各 AI 服务商的使用条款