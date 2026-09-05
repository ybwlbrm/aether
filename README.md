# Aether — 个人 AI 指挥中心

> **本地优先的 AI 工作操作系统**：对话、搜索、知识管理、Agent 编排、工具箱，一站式个人 AI 工作台。
>
> 所有数据保存在本地，不上传云端。你可以完全掌控自己的数据。

---

## ✨ 特性一览

| 模块 | 说明 |
|------|------|
| 🏠 **控制台** | 系统仪表盘，按功能分类展示，快捷操作入口 |
| 💬 **AI 对话** | 流式聊天，多模型切换，深度思考/联网/循环模式，Agent 编排（11 个内置 Agent） |
| 🛠️ **工具箱** | 格式转换（PDF/Word/Excel/图片/音频）、编码转换、Base64、时间戳、颜色转换 |
| 🔍 **搜索引擎** | 无广告聚合搜索（DuckDuckGo/本地文件/网页），结果导出 CSV/JSON/Markdown |
| 📚 **知识管理** | 收藏夹、闪念备忘录、知识库，AI 自动标签 |
| 🤖 **Agent 工作室** | 多 Agent 协作编排、可视化工作流、MCP 工具集成、技能市场 |
| 🎨 **AI 媒体中心** | AI 生成图片/视频，画廊管理 |
| 📄 **文档生成** | AI 生成 PPT / Word 文档 |
| 📁 **项目管理** | 项目展示、脚本执行、终端 |
| 🔐 **密码库** | AES-256-GCM 加密存储（Windows DPAPI 保护主密钥） |
| 📊 **系统监控** | CPU/内存/网络实时监控、模型健康检查 |
| ⚙️ **设置中心** | 6 套主题切换、玻璃效果调节、背景轮播、AI Provider 配置、多端同步 |

---

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────┐
│                 桌面端 (Electron)                     │
│           ┌───────────────────────────┐              │
│           │   渲染进程 (React 19 UI)    │              │
│           └──────────┬────────────────┘              │
│                      │ IPC (contextBridge)           │
├──────────────────────┼──────────────────────────────┤
│         后端服务 (Fastify 5 + Node.js)                │
│  ┌─────────┐ ┌───────┐ ┌────────┐ ┌───────────────┐  │
│  │ API 路由 │ │ 工具箱 │ │ 搜索    │ │ Agent 编排     │  │
│  │ 27 模块  │ │ 转换器 │ │ 聚合    │ │ MCP 工具集成    │  │
│  └─────────┘ └───────┘ └────────┘ └───────────────┘  │
├──────────────────────┼──────────────────────────────┤
│            数据层 (sql.js + SQLite)                   │
│  settings.json · pacc.db · conversations/ · media/   │
└──────────────────────┼──────────────────────────────┘
                       │ (可选) Supabase 多端同步
                  ┌────┴────┐
                  │  移动端   │
                  │ (Android) │
                  └──────────┘
```

### 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 · Vite 6 · TypeScript · Tailwind CSS 4 · Framer Motion · Zustand |
| 后端 | Fastify 5 · Drizzle ORM · sql.js (SQLite) · Zod |
| 桌面 | Electron 43 · electron-builder (NSIS) |
| 移动 | Capacitor 8 · Supabase Realtime |
| 安全 | AES-256-GCM · Windows DPAPI · SSRF 防护 · 命令白名单 · 路径守卫 |

---

## 🚀 快速开始

### 环境要求

- **Node.js 18+**（推荐 20/22 LTS）
- **Windows 10/11**（桌面版）/ 现代浏览器（Localhost 版）
- 可选：JDK 21 + Android SDK（构建移动端 APK）

### 版本 A：Localhost 版（浏览器访问）

```bash
# 1. 安装依赖
npm install

# 2. 构建
npm run build

# 3. 启动
npm start
```

打开浏览器访问 **http://127.0.0.1:3000**

> 也可以直接双击 `start.bat` 一键启动。

### 版本 B：EXE 桌面版

```bash
# 一键打包（含 NSIS 安装包）
npm run build:exe
```

产物位于：
- `dist_exe/` — 便携版（`启动应用.bat` 启动）
- `dist_electron/` — NSIS 安装包（`Aether Setup 1.0.0.exe`）

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

> **APK 签名（可选但推荐）**：
> 不配置签名也能构建（产出 unsigned APK，仅用于自测）。若要正式安装分发：
>
> ```bash
> # 1. 生成 keystore（一次性）
> keytool -genkeypair -v -keystore android/aether-release.jks \
>   -alias aether -keyalg RSA -keysize 2048 -validity 10000 \
>   -storepass "YourPassword" -keypass "YourPassword" \
>   -dname "CN=Aether, OU=Personal, O=Aether, L=Beijing, ST=Beijing, C=CN"
>
> # 2. 创建 android/keystore.properties（内容如下）
> ```
> `android/keystore.properties`：
> ```properties
> storeFile=D:/path/to/your/aether-release.jks
> storePassword=YourPassword
> keyAlias=aether
> keyPassword=YourPassword
> ```
> ⚠️ `keystore.properties` 和 `*.jks` 已被 `.gitignore` 排除，**切勿提交到仓库**。

### 开发模式（热更新）

```bash
npm run dev
```

---

## 🧑‍💻 从零开始（新手向导）

> 如果你是第一次接触本项目，按这个顺序操作即可。

### 第 1 步：准备环境

| 工具 | 用途 | 下载 |
|------|------|------|
| Node.js 20+ | 运行/构建 | https://nodejs.org |
| Git | 拉取代码 | https://git-scm.com |
| （可选）JDK 21 | 打包 Android APK | https://adoptium.net |

### 第 2 步：拉取并安装

```bash
git clone https://github.com/ybwlbrm/aether.git
cd aether
npm install
```

> 网络慢的国内用户可设镜像：`npm config set registry https://registry.npmmirror.com`

### 第 3 步：启动

```bash
npm run build
npm start
```

浏览器打开 **http://127.0.0.1:3000**

> Windows 用户也可直接双击 `start.bat`。

### 第 4 步：配置 AI

1. 打开 **设置 → AI Provider**
2. 点击「添加 AI Provider」
3. 填入：名称（如 `DeepSeek`）、类型、Base URL（如 `https://api.deepseek.com`）、**你的 API Key**、模型列表
4. 保存后回到「AI 对话」即可使用

### 常见问题

| 问题 | 解决 |
|------|------|
| `npm install` 慢/失败 | 切换国内镜像（见上文） |
| 启动后页面打不开 | 检查端口 3000 是否被占用，杀进程后重试 |
| 忘记 API Key 在哪配 | 设置 → AI Provider（不是 .env！Key 走 UI 加密存储） |
| 打包 Setup 时输出目录不对 | 已修复为动态路径，任何目录 clone 均可打包 |
| 想换主题 | 设置 → 外观，6 套主题可选 |
| 数据存在哪 | `data/` 目录（数据库 + 配置），备份整个目录即可迁移 |

---

## ⚙️ 配置

### AI Provider

启动后在 **设置 → AI Provider** 中添加：

1. 点击「添加 AI Provider」
2. 填写名称、类型（OpenAI/Anthropic/DeepSeek/Google/自定义）、Base URL、API Key、模型列表
3. 保存后即可在对话中使用

> API Key 使用 **AES-256-GCM 加密存储**，主密钥由 **Windows DPAPI** 保护，不落盘明文。

### 环境变量（可选）

复制 `.env.example` 为 `.env`（**不要提交 `.env` 到仓库**）：

```ini
PORT=3000
HOST=127.0.0.1
# AI Provider Keys（也可以在 UI 中配置）
# OPENAI_API_KEY=sk-...
# DEEPSEEK_API_KEY=...
# 移动端同步（可选）
# SUPABASE_URL=...
# SUPABASE_KEY=...
```

---

## 📁 项目结构

```
PersonalAICommandCenter/
├── src/
│   ├── shared/          # 共享类型/协议（TypeScript + Zod）
│   ├── backend/         # Fastify 后端（27 模块 + lib 基础设施）
│   │   └── src/
│   │       ├── modules/ # 业务模块（conversations/agents/search/toolbox...）
│   │       ├── lib/     # 共享库（crypto/keystore/path-guard/safe-fetch...）
│   │       └── db/      # sql.js + Drizzle + 迁移
│   ├── frontend/        # React 前端（22 路由）
│   │   └── src/
│   │       ├── routes/  # 页面路由
│   │       ├── components/ # UI 组件（ui/ai-elements/activity）
│   │       ├── hooks/   # 共享 hooks
│   │       └── store/   # Zustand 状态
│   └── mobile/          # Capacitor 移动端
├── electron/            # 桌面壳（main.js / preload.js / builder 配置）
├── build/               # 打包脚本（build-exe.js / bundle-backend.js）
├── android/             # Android 工程
├── docs/                # 架构文档与审计报告
└── data/                # ⚠️ 本地数据（不入库，gitignore）
```

---

## 🛡️ 安全设计

本项目遵循**安全优先**的设计原则：

- 🔐 **密钥安全**：API Key AES-256-GCM 加密 + Windows DPAPI 保护主密钥，不落盘明文
- 🛡️ **SSRF 防护**：所有出站请求经过 URL 校验（拦截私网/云元数据/恶意重定向）
- 🔒 **路径守卫**：文件访问白名单 + UUID 文件名重建，防路径穿越
- 🚫 **命令白名单**：终端/工作流命令执行走 spawn+白名单，防命令注入
- 🔑 **本地认证**：敏感端点（终端执行/数据导入导出/MCP 测试）需 Bearer Token
- 🌐 **CSP/CORS**：严格内容安全策略 + CORS 白名单 + Host 校验防 DNS Rebinding
- 📦 **数据本地化**：所有数据存储在本地 `data/` 目录，可随时导出迁移

---

## 🧪 测试

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

质量门禁：**162 项自动化测试** + TypeScript 严格检查 + ESLint。

---

## 🤝 贡献

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feat/xxx`）
3. 提交修改（遵循项目代码风格）
4. 发起 Pull Request

### 开发规范

- TypeScript 严格模式，禁止 `any` 逃逸
- 单引号、分号、2 空格缩进
- 所有数据操作走 lib/dal 层
- 出站请求必须经 lib/safe-fetch
- 文件访问必须经 lib/path-guard

---

## 📄 许可

本项目基于 [MIT License](LICENSE) 开源。

---

## ⚠️ 免责声明

- 本项目为**本地优先**应用，请妥善保管你的 API Key 与本地数据
- 项目处于积极开发阶段，功能可能随版本调整
- 使用 AI 生成内容时请遵守各 AI 服务商的使用条款
