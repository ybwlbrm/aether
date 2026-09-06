# Aether · 个人 AI 指挥中心

> **本地优先的 AI 工作操作系统**：对话、智能体编排、工具箱、知识、文档、记忆一站式，AI 能力全都在你自己的电脑上运行。

![Version](https://img.shields.io/badge/版本-2.2.0-brightgreen) ![Tests](https://img.shields.io/badge/测试-978%2B-blue) ![License](https://img.shields.io/badge/License-MIT-orange) ![Platform](https://img.shields.io/badge/Windows%20%2F%20WEB%20%2F%20Android-✓-lightgrey)

---

## 目录

- [这是什么](#这是什么)
- [核心亮点](#核心亮点)
- [三种使用方式](#三种使用方式)
- [功能模块](#功能模块)
- [Aether 2.0 Runtime 架构](#aether-20-runtime-架构)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
  - [版本 A：Localhost 版（零安装）](#版本-alocalhost-版零安装)
  - [版本 B：EXE 桌面版](#版本-bexe-桌面版)
  - [版本 C：Android APK](#版本-candroid-apk)
- [配置 AI Provider](#配置-ai-provider)
- [配置 Supabase 云同步（可选）](#配置-supabase-云同步可选)
- [数据存储](#数据存储)
- [安全设计](#安全设计)
- [隐私与联网说明](#隐私与联网说明)
- [开发指南](#开发指南)
- [测试](#测试)
- [构建与打包](#构建与打包)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [贡献](#贡献)
- [License](#license)
- [免责声明](#免责声明)

---

## 这是什么

Aether 是一个把 **AI 对话、多 Agent 协作、自动化工具箱、知识管理、文档生成** 整合在一起的桌面操作系统级应用。

它不是又一个聊天机器人，而是让 **自然语言成为指挥一群 AI「员工」的方式**——你下达任务，多个 AI Agent 分工协作、互相交接、共同完成复杂工作。

| 形态 | 说明 |
|------|------|
| **桌面版（Windows EXE）** | 独立窗口应用，完整功能，数据全在本机 |
| **网页版（Localhost）** | 浏览器访问 `http://127.0.0.1:3000`，零安装 |
| **Android APK** | 远程控制 / 同步客户端：在外查看对话、发指令、批准工具调用 |

> **关键定位**：桌面版是**真正的执行引擎**（运行 AI、调用工具、执行工作流）；Android 是**远程控制与同步客户端**（观察与遥控）；Supabase 只是可选的**同步中继**（认证 + Realtime + 远程命令队列），不承载 AI 执行。

---

## 核心亮点

| 亮点 | 说明 |
|------|------|
| 🧠 **真正的 AI 操作系统** | 用自然语言指挥一组 AI「员工」分工协作、互相交接、共同完成复杂任务 |
| 🏗️ **Aether 2.0 Runtime 架构** | 全新事件驱动分层架构：Event → Run → Agent → Model / Tool / Memory，可恢复、可扩展、可回放 |
| 🤖 **多内置 Agent** | Sisyphus / Oracle / Librarian / Explore / Hephaestus 等，各司其职、自动编排、支持相互交接（Handoff） |
| 🛠️ **MCP + 工具箱即插即用** | 格式转换、PDF/Word/Excel 处理、YouTube 下载、音视频提取、聚合搜索、文档生成，插件化扩展 |
| 🔄 **断线续传** | SSE 实时流 + `afterSeq` 增量回放 + `Last-Event-ID` 重连，不丢、不重 |
| 📱 **Android 远程控制** | 手机实时查看 Run/Agent/Tool 执行过程、接收审批请求、发送远程命令 |
| 🔒 **本地优先，隐私第一** | API Key 用 AES-256-GCM 加密、钥匙交 Windows DPAPI 保护；数据默认存本地 |
| 📊 **工程级质量** | 26 个后端模块、120+ API、**978+ 自动化测试**全绿、TypeScript 严格模式 |

---

## 三种使用方式

| 版本 | 适合场景 | 数据位置 | 联网 |
|------|----------|----------|------|
| **A. Localhost 网页版** | 快速体验、开发调试 | `./data/` | AI 接口 / Web 搜索 |
| **B. EXE 桌面版** | 日常主力使用 | `%USERPROFILE%\Documents\AICommandCenter\` | AI 接口 / Web 搜索 |
| **C. Android APK** | 外出远程控制电脑 | Supabase 云端（可选） | 需要网络 |

---

## 功能模块

| 模块 | 说明 |
|------|------|
| 🔧 控制台 | 系统仪表盘，按功能分类展示，CPU/内存/磁盘实时监控 |
| 💬 AI 对话 | 流式聊天，模型切换、深度思考 / 联网 / 循环模式，多 Agent 编排 |
| 🧠 Agent 协作 | 多 Agent 分工执行：规划 / 编写 / 审查 / 检索 / 图片分析，MCP 工具即插即用 |
| ⚙️ 工具箱 | 格式转换（PDF/Word/Excel/图片/音视频）、YouTube 下载、音视频提取，内置 ffmpeg/yt-dlp |
| 🔍 聚合搜索 | 无注册多路搜索（DuckDuckGo / 本地文件 / 网页），结果导出 CSV / JSON / Markdown |
| 📚 知识库 | 收藏夹、便签、Wiki 页面，AI 自动打标签、按需检索 |
| 🤖 AI 媒体 | AI 生成 / 编辑图片、视频、音频 |
| 📄 文档生成 | AI 一键生成 PPT / Word 文档 |
| 🛡️ 安全中心 | API Key AES-256-GCM 加密存储，钥匙由 Windows DPAPI 保护，SSRF 防护，路径越界拦截，命令白名单 |
| 📱 移动端 | 会话列表、聊天、新指令、Run 监控、Activity 流、审批、通知、同步状态 |
| 🎨 UI 主题 | 多套主题可切换（Liquid Glass / shadcn / Geist 等），深色 / 浅色模式 |

---

## Aether 2.0 Runtime 架构

Aether 2.0 引入了**事件驱动、可恢复、可扩展的 Runtime 分层架构**——每一次对话、工具调用、Agent 协作都是一次可追踪、可回放、可断线续传的「运行」。

```
┌─────────────────────────┐
│       AETHER UI         │  React 19 · 活动流投影 · Run 监控
└────────────┬────────────┘
             │  标准化 Event（SSE / afterSeq 断线续传）
┌────────────▼────────────┐
│     EVENT RUNTIME       │  EventBus / EventStore(SQLite)
│  Replay / Sequence      │  37 种判别联合事件 · chunk 打包 · 幽灵行过滤
└────────────┬────────────┘
┌────────────▼────────────┐
│      RUN RUNTIME        │  createRun/start/pause/resume/cancel
│  Checkpoint / Resume    │  runs/tasks 状态机 · Crash Recovery · token 统计
└────────────┬────────────┘
┌────────────▼────────────┐
│     AGENT RUNTIME       │  Planner / Worker / Supervisor
│  Handoff / Blackboard   │  AgentRegistry · 预算限制 · 按 Agent 隔离思考
└──────┬──────────┬───────┘
       │          │
┌──────▼──────┐ ┌─▼──────────┐ ┌─────────────┐
│MODEL RUNTIME│ │TOOL RUNTIME│ │MEMORY RUNTIME│
│Provider适配 │ │ToolRegistry│ │4层记忆+检索 │
│API Key 解密 │ │Capability  │ │回退/衰减    │
└──────┬──────┘ └─┬──────────┘ └─────────────┘
       └──────────┼────────────────┘
┌─────────────────▼─────────────────┐
│   RESOURCE / SECURITY 层          │
│  FS / Network / OS / Approval    │
│  PolicyEngine · 审批 · 命令白名单 │
└───────────────────────────────────┘
```

### 核心 Runtime 组件（`src/backend/src/core/`）

| 子模块 | 说明 |
|--------|------|
| `runtime/` | Run/Task 状态机、生命周期、取消令牌（CancellationToken）、Checkpoint、Crash Recovery |
| `events/` | EventBus / EventStore(SQLite) / Replay / Sequence / Projector / SSE Transport / Chunk Packing |
| `models/` | ModelRuntime / StreamingClient / ModelRegistry / ProviderAdapter / 用量统计 |
| `agents/` | AgentRuntime / AgentRegistry / 消息 / Handoff / Supervisor |
| `tools/` | AetherTool / ToolRegistry / ToolExecutor / 超时管理 / 结果联合类型 |
| `permissions/` | Capability / PolicyEngine / ApprovalManager |
| `memory/` | MemoryStore / MemoryRuntime / MemoryRetriever（keyword + hybrid 打分） |
| `artifacts/` | ArtifactStore / ArtifactRuntime（文件产物注册） |
| `errors/` | RuntimeError 层次（Model / Tool / Retry 派生） |

### 关键能力

- ✅ **Run API**：`/api/runs` 生命周期端点 + `/api/runs/:runId/events?afterSeq=` 增量回放 + `/api/runs/:runId/stream` SSE 实时流（Last-Event-ID 断线恢复）
- ✅ **Crash Recovery**：`POST /api/runs/recover` 自动把崩溃遗留的 running/waiting Run 标记为 interrupted
- ✅ **Event 收敛**：packed 行按**逻辑 seq** 回放（`afterSeq=150` 只返回 151+）；`__seq_claim` 幽灵行在所有读取路径过滤
- ✅ **模型调用收敛**：业务层统一经 `ModelRuntime → ProviderAdapter → HTTP`；Workflow 节点同样接入
- ✅ **API Key 安全**：AES-256-GCM 加密存储，运行时解密，绝不进入 Event / 日志 / 前端
- ✅ **旧系统兼容**：legacy adapter 双向映射（activity_events ↔ events），平滑过渡

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 · Vite 6 · TypeScript · Tailwind CSS 4 · Framer Motion · Zustand |
| 后端 | Fastify 5 · Drizzle ORM · sql.js (SQLite) · Zod |
| 桌面 | Electron 43 · electron-builder（NSIS 安装包） |
| 移动 | Capacitor 8 · Supabase（可选同步） |
| 安全 | AES-256-GCM + Windows DPAPI · SSRF 防护 · 路径守卫 · 命令白名单 |
| Runtime | 事件分发 · Run 生命周期 · Agent 编排 · 模型/工具/记忆统一运行时 |

---

## 快速开始

### 环境要求

- **Node.js 18+**（推荐 20/22 LTS）
- **Windows 10/11**（桌面版）· 现代浏览器（网页版）
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

产物：

| 产物 | 位置 | 说明 |
|------|------|------|
| 便携版 | `dist_exe/` | 免安装，双击 `启动应用.bat` |
| 安装包 | `dist_electron/Aether Setup 2.2.0.exe` | 一键安装，桌面/开始菜单快捷方式 |

### 版本 C：Android APK

```bash
npm run build:apk   # 需 JDK 21 + Android SDK
```

产物：`android/app/build/outputs/apk/release/app-release.apk`，手机侧载安装（设置中需允许未知来源）。

> APK 签名（推荐）：`keystore.properties` 与 `*.jks` 已被 `.gitignore` 排除，**不会进入源码仓库**。

---

## 配置 AI Provider

1. 进入 **设置 → AI Provider**
2. 添加你的 AI Provider
3. 填入：名称（如 `DeepSeek`）、类型、Base URL（如 `https://api.deepseek.com`）、**你的 API Key**、模型列表
4. 保存后到「AI 对话」即可开聊

支持任意 **OpenAI 兼容** 接口的 Provider（DeepSeek / OpenAI / 通义 / Moonshot / 本地 Ollama 等）。

---

## 配置 Supabase 云同步（可选）

> Supabase 同步是**可选功能**，仅当你需要 Android 远程控制时启用。

1. 在 Supabase 控制台创建项目
2. 在 **SQL Editor** 依次执行部署脚本（在 `docs/sql/` 目录）：
   - `supabase-schema.sql` — 建表（devices / conversations_sync / messages_sync / remote_commands 等）
   - `supabase-fix-rls.sql` — 行级安全策略（RLS）
3. 桌面端 **设置 → 同步**：填入 Supabase URL 与 Key
4. Android 端：**邮箱 + 密码登录**（Supabase Auth），登录后即可与桌面端联动

> **安全提醒**：移动端只使用 anon key + Auth 登录；Service Role Key 仅由桌面端后端（本机服务端）持有，绝不进入手机客户端。

---

## 数据存储

所有数据默认保存在本地 SQLite 数据库中：

| 版本 | 数据库位置 |
|------|-----------|
| Localhost 版 | `./data/pacc.db` |
| EXE 版 | `%USERPROFILE%\Documents\AICommandCenter\pacc.db` |

备份迁移：直接备份整个 `data/` 目录即可。

---

## 安全设计

**安全第一** 是核心原则。

- 🗝️ **密钥安全**：API Key AES-256-GCM 加密存储，签名由 Windows DPAPI 系统级保护；运行时解密，不进入 Event / 日志 / 前端
- 🛡️ **SSRF 防护**：出站请求 URL 校验（拒绝内网 / 元数据 / 敏感重定向）
- 📂 **路径守卫**：白名单目录 + UUID 文件名，杜绝路径穿越
- ⛔ **命令白名单**：终端/数据处理 spawn + 参数校验，防注入
- 🔑 **端点认证**：敏感端点（终端执行 / 导入导出 / MCP 测试）需 Bearer Token
- 🌐 **CSP / CORS**：严格 CSP + CORS 白名单 + Host 校验（防 DNS Rebinding）
- 📱 **移动端安全**：anon key + Supabase Auth（无 service_role 暴露）、RLS 行级隔离、远程命令幂等键、私有存储桶 + 签名 URL
- 🏠 **数据本地化**：所有数据默认在本地 `data/` 目录，随时备份迁移

---

## 隐私与联网说明

> ⚠️ **重要**：本项目是「本地优先」，不是「绝不上网」。请知悉以下联网行为：

| 场景 | 联网行为 |
|------|----------|
| AI Provider | 对话/生成时会连接你配置的大模型 API（如 DeepSeek/OpenAI） |
| Web 搜索 | 使用聚合搜索功能时会访问搜索引擎 |
| YouTube 下载 | 会连接 YouTube 服务 |
| Supabase 同步（可选） | 启用后对话/命令数据会经 Supabase 中转（Android 远程控制依赖此通道） |
| 默认状态 | 不启用 Supabase 时，数据完全留在本机 |

---

## 开发指南

```bash
# 安装依赖
npm install

# 构建共享模块
npm run build -w src/shared

# 开发模式（前后端热更新）
npm run dev

# 仅后端 / 仅前端
npm run dev:backend
npm run dev:frontend

# 构建生产版本
npm run build

# 启动服务
npm start

# 类型检查
npm run typecheck

# Lint
npm run lint
```

---

## 测试

```bash
npm test               # 全量（shared + backend + frontend）
npm run test:backend   # 后端
npm run test:frontend  # 前端
npm run typecheck      # 类型检查
npm run lint           # Lint
```

**质量基线：978+ 自动化测试全绿**（backend 978 + shared 32 + frontend 58）+ TypeScript 严格模式 + ESLint。

覆盖范围：Event 协议 / Run 状态机 / Packed Replay / Ghost Claim / Model 解密 / FK 级联删除 / SSE 错误传播 / Activity 投影 / Workflow 执行 / 前端 race 守卫 等。

---

## 构建与打包

| 命令 | 产物 |
|------|------|
| `npm run build` | shared + backend + frontend 编译产物 |
| `npm run build:mobile` | mobile 前端构建 |
| `npm run build:apk` | Android APK（需 JDK 21 + Android SDK） |
| `npm run build:exe` | 便携版（`dist_exe/`）+ NSIS 安装包（`dist_electron/`） |

---

## 项目结构

```
├── src/
│   ├── shared/          # 共享类型/协议（AgentEvent、错误体系、配置 schema）
│   ├── backend/         # Fastify 后端
│   │   └── src/
│   │       ├── core/    # Runtime 核心（runtime/events/models/agents/tools/permissions/memory/artifacts/errors）
│   │       ├── modules/ # 业务模块（runs/conversations/providers/agents/workflows/sync/...）
│   │       ├── db/      # Drizzle schema + sql.js 迁移（v1-v13）
│   │       ├── lib/     # 基础库（provider/crypto/event-bus/safe-fetch/path-guard/...）
│   │       └── plugins/ # Fastify 插件（错误处理/CSRF/CORS）
│   ├── frontend/        # React 19 前端（活动流/对话/工具箱/知识/设置）
│   └── mobile/          # Android 移动端（Capacitor + Supabase）
├── android/             # Android 原生工程（Gradle）
├── electron/            # Electron 主进程（启动/托盘/健康检查/恢复）
├── build/               # 打包脚本（bundle-backend / build-exe）
├── docs/
│   ├── audit/           # 审计报告（Baseline / Findings / FixPlan / FINAL×4）
│   ├── sql/             # Supabase 部署脚本（schema + RLS）
│   └── SYNC_MANIFEST.md # 自用版 ↔ 开源版同步清单
└── package.json         # workspace 根
```

---

## 常见问题

| 问题 | 解决 |
|------|------|
| `npm install` 慢/失败 | 切换国内镜像：`npm config set registry https://registry.npmmirror.com` |
| 页面打不开 | 检查端口 3000 是否被占用，杀进程后重试 |
| API Key 报错 | 设置 → AI Provider，确认 Key 与模型填写正确 |
| APK 构建报 "无效的源发行版" | 设置 `JAVA_HOME` 为 JDK 21：`$env:JAVA_HOME="C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot"` |
| Setup 装到自定义目录出错 | 已改为动态路径解析，任意目录克隆均可用 |
| 想换语言 | 设置 → 界面 → 多语言切换 |
| 数据在哪里 | `data/` 目录（数据库 + 配置），备份迁移整个目录即可 |
| 手机连不上电脑 | 确认 Supabase 项目已执行 `docs/sql/` 两个脚本，且两端登录同一账号 |

---

## 贡献

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

## License

本项目基于 [MIT License](LICENSE) 开源。

---

## 免责声明

- 本项目为**本地优先**应用，默认不会上传你的 API Key 与本地数据
- AI Provider（大模型 API）与 Web 搜索为联网功能；启用 Supabase 云同步后，对话/命令数据会经 Supabase 中转（Android 远程控制依赖此通道），请按需启用
- 项目持续迭代中，可能随版本升级出现变化
- 使用 AI 生成内容时，请遵守各 AI 服务商的使用条款
