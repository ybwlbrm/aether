# Aether

> 个人 AI 指挥中心 — 一个属于你的个人 AI 工作操作系统

## 版本说明

### 版本 A：Localhost 版（浏览器访问）

一键启动，通过浏览器访问。

**使用方式：**
```
双击 start.bat
```
或
```
npm run build && npm start
```

启动后打开浏览器访问：**http://127.0.0.1:3000**

### 版本 B：EXE 桌面版（独立窗口）

打包为独立的 Windows 桌面应用程序。

**使用方式：**
```
双击 Aether.exe
```

## 功能模块

| 模块 | 说明 | 状态 |
|------|------|------|
| 🔧 控制台 | 系统仪表盘，按功能分类展示 | ✅ |
| 💬 AI 对话 | 流式聊天界面，支持多模型切换 | ✅ |
| 🛠️ 工具箱 | 格式转换、PDF操作、音频处理 | ✅ |
| 🔍 搜索引擎 | 无广告，聚合 DuckDuckGo/本地/网页多源搜索 | ✅ |
| 📚 知识管理 | 收藏夹、闪念备忘录、知识库 | ✅ |
| 🤖 Agent 编排 | 多Agent协作与智能分析 | ✅ |
| 🎨 媒体中心 | AI 图片/视频/音频生成 | ✅ |
| 📄 文档生成 | AI 生成 PPT 和 Word 文档 | ✅ |
| 📁 项目管理 | 项目展示、脚本执行 | ✅ |
| 📊 媒体库 | 已生成的文件管理 | ✅ |
| 🎨 UI 主题 | 6套主题可切换（Liquid Glass/shadcn/Geist等） | ✅ |
| ⚙️ 设置 | 主题切换、AI Provider、外观配置 | ✅ |

## 技术架构

```
Frontend: React 19 + Vite 6 + TypeScript + Tailwind CSS 4 + Framer Motion
Backend:  Fastify 5 + Drizzle ORM + sql.js (SQLite)
Desktop:  Electron (可选，仅 EXE 版需要)
```

## 开发指南

```bash
# 安装依赖
npm install

# 构建共享模块
npm run build -w src/shared

# 开发模式（前端热更新）
npm run dev

# 构建生产版本
npm run build

# 启动服务
npm start

# 打包 EXE 桌面版
npm run build:exe
```

## 数据存储

所有数据保存在本地 SQLite 数据库中：
- **Localhost 版**: `./data/pacc.db`
- **EXE 版**: `%USERPROFILE%\Documents\AICommandCenter\pacc.db`

## 系统要求

- Node.js 18+（仅 Localhost 版需要）
- Windows 10/11（EXE 版）
- 现代浏览器（Chrome/Edge 推荐）