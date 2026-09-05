# Aether · 个人 AI 指挥中心

> **本地优先的 AI 工作操作系统**：对话、智能体编排、工具箱、知识、文档、记忆一站式，AI 能力全都在你自己的电脑上运行。
>
> 所有数据保存在本地——AI 能力、数据、记忆全部属于你，隐私全权由你掌控，不上云。

![Version](https://img.shields.io/badge/版本-2.0-brightgreen) ![Tests](https://img.shields.io/badge/测试-864%2B-blue) ![License](https://img.shields.io/badge/License-MIT-orange) ![Platform](https://img.shields.io/badge/Windows/WEB/Android-✓-lightgrey)

---

## 💡 为什么选 Aether？核心亮点

| 亮点 | 说明 |
|------|------|
| 🧠 **真正的 AI 操作系统** | 不是又一个聊天机器人——用自然语言指挥一组 AI「员工」分工协作、互相交接、共同完成复杂任务 |
| 🔒 **本地优先，隐私第一** | API Key 用 AES-256-GCM 加密、钥匙交 Windows DPAPI 保护；所有数据存本地，绝不上传 |
| 🏗️ **Aether 2.0 Runtime 架构** | 全新事件驱动分层架构：Event → Run → Agent → Model/Tool/Memory，可恢复、可扩展、可回放 |
| 🤖 **11 个内置 Agent** | Sisyphus / Oracle / Librarian / Explore / Hephaestus 等，各司其职、自动编排 |
| 🛠️ **MCP + 工具箱即插即用** | 格式转换、YouTube 下载、音视频提取、聚合搜索、文档生成，插件化扩展 |
| 📊 **工程级质量** | 26 个后端模块、120+ API、**864+ 自动化测试**全绿、TypeScript 严格模式 |

---

## ✨ 这是什么

Aether 是一个把 **AI 对话、多 Agent 协作、自动化工具箱、知识管理、文档生成** 整合在一起的桌面操作系统级应用。不是又一个聊天机器人，而是让自然语言成为指挥一群 AI「员工」的方式。

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

Aether 2.0 引入了一套 **事件驱动、可恢复、可扩展的 Runtime 分层架构**。它把「功能丰富的 AI 工作台」升级成真正的「Personal AI Operating System」——每一次对话、工具调用、Agent 协作都是一次可追踪、可回放、可断线续传的「运行」。

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

| 子模块 | 文件数 | 说明 |
|--------|--------|------|
| `runtime/` | 15 | Run/Task 状态机、生命周期、取消令牌（CancellationToken）、Checkpoint |
| `events/` | 23 | EventBus / EventStore(SQLite+内存) / Replay / Sequence / Projector / SSE Transport / Chunk Packing / LegacyAdapter |
| `models/` | 15 | ModelRuntime / StreamingClient / ModelRegistry / ProviderAdapter / 用量统计 |
| `agents/` | 17 | AgentRuntime / AgentRegistry / 消息 / Handoff / Supervisor / 旧 AGENTS 迁移 |
| `tools/` | 13 | AetherTool / ToolRegistry / ToolExecutor / ToolPolicy / 超时管理 / 结果联合类型 |
| `permissions/` | 7 | Capability / PolicyEngine / ApprovalManager |
| `memory/` | 6 | MemoryStore / MemoryRuntime / MemoryRetriever（keyword+hybrid 打分） |
| `artifacts/` | 5 | ArtifactStore / ArtifactRuntime（文件产物注册） |
| `errors/` | 6 | RuntimeError 层次（Model/Tool/Retry 派生） |

> 事件协议 v2：**37 种判别联合**（run/task/agent/message/tool/token 全生命周期），统一携带 `version` + `runId` + `seq`，支持 replay 与断线续传。

### 关键能力

- ✅ **Run API**：`/api/runs` 7 端点 + `/api/runs/:runId/events?afterSeq=` 增量回放 + `/api/runs/:runId/stream` SSE 实时流（Last-Event-ID 断线恢复）
- ✅ **迁移 v10-v12**：新增 `runs` / `tasks` / `events` 表，`UNIQUE(run_id, seq)` 保证并发安全
- ✅ **旧系统无缝兼容**：legacy adapter 双向映射（activity_events ↔ events），不推倒重来，平滑过渡
- ✅ **5 大 Runtime 桥接层**：model / agent / tool / memory / artifact 生产接线，新架构真实运行

---

## 🚀 快速开始

### 环境要求

- **Node.js 18+**（推荐 20/22 LTS）
- **Windows 10/11**（桌面版）· 现代浏览器（Localhost 版）
- 可选：**JDK 21 + Android SDK**（构建移动端 APK）

### 版本 A：Localhost 版（零安装，5 分钟跑起来）

```bash
npm install      # 安装依赖
npm run build    # 构建
npm start        # 启动
```

访问 **http://127.0.0.1:3000** · 也可以直接双击 `start.bat` 一键启动

### 版本 B：EXE 桌面版

```bash
npm run build:exe   # 一键生成便携版 + NSIS 安装包
```

产物：`dist_exe/`（便携版）+ `dist_electron/`（**Aether Setup 1.0.0.exe** 安装包）

### 版本 C：Android APK

```bash
npm run build:mobile
npx cap sync android
cd android && gradlew.bat assembleRelease   # 需 JDK 21
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

> APK 签名（推荐）：`keystore.properties` 与 `*.jks` 已被 `.gitignore` 排除，**不会进入源码仓库**。

### 开发模式（热更新）

```bash
npm run dev
```

---

## 📖 从零开始的运行指南

> 第一次接触本项目？按顺序一步步来。

### 第 1 步：准备环境

| 工具 | 用途 | 下载 |
|------|------|------|
| Node.js 20+ | 运行与构建 | https://nodejs.org |
| Git | 拉取源码 | https://git-scm.com |
| （可选）JDK 21 | 构建 Android APK | https://adoptium.net |

### 第 2 步：拉取并安装

```bash
git clone https://github.com/ybwlbrm/aether.git
cd aether
npm install
```

> 国内网络较慢可切换镜像：`npm config set registry https://registry.npmmirror.com`

### 第 3 步：构建并启动

```bash
npm run build
npm start
```

访问 **http://127.0.0.1:3000**

### 第 4 步：配置你的 AI

1. 进入 **设置 → AI Provider**
2. 添加你的 AI Provider
3. 填入：名称（如 `DeepSeek`）、类型、Base URL（如 `https://api.deepseek.com`）、**你的 API Key**、模型列表
4. 保存后到「AI 对话」即可开聊

### 常见问题

| 问题 | 解决 |
|------|------|
| `npm install` 慢/失败 | 切换国内镜像（如上） |
| 页面打不开 | 检查端口 3000 是否被占用，杀进程后重试 |
| API Key 报错 | 设置 → AI Provider，确认 Key 与模型填写正确 |
| Setup 装到自定义目录出错 | 已改为动态路径解析，任意目录克隆均可用 |
| 想换语言 | 设置 → 界面 → 6 种语言切换 |
| 数据在哪里 | `data/` 目录（数据库 + 配置），备份迁移整个目录即可 |

---

## 🔐 安全设计

**安全第一** 是核心原则。

- 🗝️ **密钥安全**：API Key AES-256-GCM 加密，签名由 Windows DPAPI 系统级保护
- 🛡️ **SSRF 防护**：出站请求 URL 校验（拒绝内网 / 元数据 / 敏感重定向）
- 📂 **路径守卫**：白名单目录 + UUID 文件名，杜绝路径穿越
- ⛔ **命令白名单**：终端/数据处理 spawn + 参数校验，防注入
- 🔑 **端点认证**：敏感端点（终端执行 / 导入导出 / MCP 测试）需 Bearer Token
- 🌐 **CSP/CORS**：严格 CSP + CORS 白名单 + Host 校验（防 DNS Rebinding）
- 🏠 **数据本地化**：所有数据都在本地 `data/` 目录，随时备份迁移

---

## 🧪 测试与质量

```bash
npm test               # 全量（shared + backend + frontend）
npm run test:backend   # 后端
npm run test:frontend  # 前端
npm run typecheck      # 类型检查
npm run lint           # Lint
```

**质量基线：864+ 自动化测试全绿**（backend **795** + shared **32** + frontend **37**）+ TypeScript 严格模式 + ESLint。

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
- **新增 Runtime 逻辑放 `src/backend/src/core/`**（transport-agnostic，禁 Fastify/SSE/React 依赖）；旧系统经 adapter/bridge 渐进迁移，不推倒重来

---

## 📄 License

本项目基于 [MIT License](LICENSE) 开源。

---

## 💬 免责声明

- 本项目为**本地优先**应用，不会上传你的 API Key 与本地数据
- 项目持续迭代中，可能随版本升级出现变化
- 使用 AI 生成内容时，请遵守各 AI 服务商的使用条款