# AI 全能工作台 — 完整计划

> **2026-08-29 全维度审计修复状态（W6-2 文档同步）：**
> - 第一轮全维度审计完成，完整报告见 `docs/AUDIT-2026-08-29-round1.md`，修复计划见 `docs/FIX-PLAN-2026-08-29.md`
> - P0 全部修复（47/47）；P1 核心修复（认证层/去重/UI Token/a11y/响应式）；门禁全绿（typecheck 0 / build PASS / 后端 117 测试 / 前端 37 测试）
> - 后续轮次按计划持续推进至收敛

## 产品定位

一个本地优先的 AI 桌面工作台，集成 AI 对话、工具箱、搜索引擎、知识管理、Agent 编排于一体。
单用户，全部用 API Key，不跑本地模型，不上架应用商店。

---

## 功能架构

```
AI 全能工作台
├── 🏠 控制台（仪表盘首页）
│   ├── 按功能分类展示（工作区 / 工具 / AI / 系统）
│   ├── 系统状态栏（服务状态、Provider 数量）
│   └── 快捷操作入口
│
├── 💬 AI 对话
│   ├── 多模型聊天（已有）
│   ├── Agent 编排（11个Agent，已有）
│   └── 对话历史管理
│
├── 🛠️ 工具箱
│   ├── 格式转换
│   │   ├── 图片 → PDF（多张合并）
│   │   ├── DOCX → PDF
│   │   ├── Excel → PDF
│   │   ├── PDF → 图片
│   │   ├── PDF → DOCX（文字提取）
│   │   └── PDF → Excel（表格提取）
│   ├── 音频转换
│   │   ├── MP3 / WAV / FLAC / OGG 互转
│   │   └── 批量转换
│   ├── 音乐解锁
│   │   ├── ncm → mp3/flac
│   │   ├── qmc → mp3/flac
│   │   └── kgm → mp3/flac
│   ├── PDF 操作
│   │   ├── PDF 合并
│   │   ├── PDF 压缩
│   │   ├── PDF 加水印
│   │   └── PDF OCR（文字识别）
│   ├── 图片处理
│   │   ├── 图片压缩
│   │   ├── 格式转换（png/jpg/webp）
│   │   └── 尺寸调整
│   └── 小工具
│       ├── 编码转换（GBK ↔ UTF-8）
│       ├── Base64 编解码
│       ├── 时间戳转换
│       └── 颜色格式转换（HEX ↔ RGB ↔ HSL）
│
├── 🔍 搜索引擎（无广告、聚合多源）
│   ├── 搜索源
│   │   ├── DuckDuckGo（免费，无需 API Key）
│   │   ├── Google（需 API Key，可选）
│   │   ├── Brave Search（需 API Key，可选）
│   │   ├── Bing（需 API Key，可选）
│   │   └── 自定义搜索源（RSS / 网站）
│   ├── 本地文件搜索
│   │   ├── 全文搜索（FTS5）
│   │   ├── 语义搜索（向量嵌入，通过 API）
│   │   └── 文件类型过滤
│   ├── 网页抓取
│   │   ├── Playwright 抓取
│   │   ├── 正文提取（Readability）
│   │   └── Markdown 转换
│   ├── 搜索结果管理
│   │   ├── 结果去重
│   │   ├── 按相关性排序
│   │   ├── 按来源筛选
│   │   └── 搜索历史
│   └── 数据导出
│       ├── CSV 导出
│       ├── JSON 导出
│       ├── Markdown 导出
│       └── 导出范围选择（全部/选定）
│
├── 📚 知识管理
│   ├── 收藏夹管理
│   │   ├── 网页链接收藏
│   │   ├── AI 自动标签
│   │   ├── 正文抓取 + 全文保存
│   │   └── 分类管理
│   ├── 闪念备忘录
│   │   ├── 快速记录
│   │   ├── 标签分类
│   │   ├── 日历回看
│   │   └── 全文搜索
│   ├── 双链知识库
│   │   ├── Markdown 笔记
│   │   ├── 双向链接
│   │   ├── 标签图谱
│   │   └── 全文搜索
│   ├── 团队 Wiki / SOP
│   │   ├── 分层文档
│   │   ├── 模板管理
│   │   └── 全文搜索
│   └── Markdown 编辑器
│       ├── 实时预览
│       ├── 语法高亮
│       ├── Mermaid 图表
│       └── 导出 PDF/HTML
│
├── 🤖 Agent 工作室
│   ├── Agent 能力包系统
│   ├── 工作流编排（可视化）
│   ├── MCP 工具集成
│   ├── Browser-Use
│   ├── 定时任务
│   └── 长期记忆系统
│
├── 🔐 密码库
│   ├── AES-256-GCM 加密存储
│   ├── 密码分类管理
│   ├── 搜索
│   └── 导出
│
├── 📁 文件管理
│   ├── 本地文件浏览
│   ├── 文件搜索
│   └── 数据导出（全平台）
│       ├── 设置导出
│       ├── 对话历史导出
│       ├── 知识库导出
│       └── 搜索结果导出
│
├── 🎨 AI 媒体中心（已有）
├── 📄 文档生成（已有）
├── 📊 项目管理（已有）
│
└── ⚙️ 设置
    ├── UI 主题切换（8 套主题）
    ├── AI Provider 配置
    ├── 玻璃效果调节
    └── 背景轮播设置
```

---

## 参考项目索引

### 综合参考（整体架构）

| 项目 | GitHub | Stars | 参考价值 |
|------|--------|-------|---------|
| **1052 OS** | https://github.com/1052666/1052-OS | 1k+ | 整体架构最接近，Web 应用，本地优先，工具+搜索+Agent+社交通道 |
| **OpenHuman** | https://github.com/tinyhumansai/OpenHuman | 36k+ | 持久记忆+工作流编排+深度研究，本地优先，参考工作流图和记忆系统 |
| **OpenAgent** | https://github.com/the-open-agent/openagent | 5.5k | 单二进制 AI 助手，RAG + browser-use + MCP，参考 Agent 编排 |
| **Kun** | https://github.com/KunAgent/Kun | 3k+ | 本地优先 AI Agent 工作台，GUI+TUI，代码/写作/设计/研究/自动化 |
| **Octop** | https://github.com/TencentCloud/Octop | 1k+ | 腾讯开源，多Agent + 社交通道（飞书/钉钉/QQ/微信） |

### 工具箱

| 项目 | GitHub | Stars | 参考价值 |
|------|--------|-------|---------|
| **Stirling PDF** | https://github.com/Stirling-Tools/Stirling-PDF | 47k+ | PDF 工具箱（合并/压缩/签名/OCR/转图片），本地运行 |
| **firecrawl/anydoc** | https://github.com/firecrawl/anydoc | 10k+/week | 文档转Markdown，Word/PPT/Excel/PDF 本地转换 |
| **genspark-ai/genoffice** | https://github.com/genspark-ai/genoffice | 2k+/week | AI 原生桌面 Office 套件，覆盖文档/表格/演示/PDF |

### 搜索引擎

| 项目 | GitHub | Stars | 参考价值 |
|------|--------|-------|---------|
| **小遥搜索** | https://github.com/dtsola/xiaoyaosearch | 1k+ | 本地文件 AI 搜索，多模态（文字/语音/图片），BGE-M3 嵌入 |
| **Constella** | https://github.com/Constella-OS/constella-desktop | — | 桌面命令中心，索引本地文件，构建私有知识图谱 |

### 知识管理

| 项目 | GitHub | Stars | 参考价值 |
|------|--------|-------|---------|
| **Linkwarden** | https://github.com/linkwarden/linkwarden | — | 收藏夹 + AI 阅读收件箱，网页链接收藏自动归档 |
| **Karakeep** | https://github.com/karakeep-app/karakeep | — | Bookmark Everything，链接/图片/笔记全收藏，AI 自动标签 |
| **Memos** | https://github.com/usememos/memos | — | 闪念备忘录，快速记录想法，日历回看，全文搜索 |
| **Logseq** | https://github.com/logseq/logseq | — | 双链知识库，笔记/双向链接/标签图谱/复习清单 |
| **AFFiNE** | https://github.com/toeverything/AFFiNE | — | 白板+知识库混合空间，文档+白板整理关系 |
| **Outline** | https://github.com/outline/outline | — | 团队 Wiki / SOP 中心，分层文档，权限搜索 |
| **AppFlowy** | https://github.com/AppFlowy-IO/AppFlowy | — | 本地 Notion 式工作台，项目/文档/任务/数据库 |
| **BookStack** | https://github.com/BookStackApp/BookStack | — | 私人手册站，分层手册，公开分享 |

### Agent 编排器

| 项目 | GitHub | Stars | 参考价值 |
|------|--------|-------|---------|
| **oikOS** | https://github.com/oikos-os/oikOS | — | 51个MCP工具，7层隐私中间件，Rooms 空间隔离 |
| **OneBrain** | https://github.com/onebrain-ai/onebrain | — | 31个技能，4层记忆系统，跨AI工具的持久化方案 |
| **MyAgents** | https://github.com/hacklyc/myagents | — | Tauri 桌面端 Agent 工作台，多标签页/工作区/文件树/终端 |
| **SelfAgent** | https://github.com/oezercet/SelfAgent | — | 19个内置工具，WhatsApp 式聊天界面，多模型支持 |

### 其他功能

| 项目 | GitHub | Stars | 参考价值 |
|------|--------|-------|---------|
| **Immich** | https://github.com/immich-app/immich | — | 私人相册 + AI 搜索，照片自动标签 |
| **Actual Budget** | https://github.com/actualbudget/actual | — | 个人财务/订阅管理，账单导入，支出图表 |
| **Uptime Kuma** | https://github.com/louislam/uptime-kuma | — | 服务健康监控，URL 监控，故障报警 |
| **Mealie** | https://github.com/mealie-recipes/mealie | — | 食谱管理，菜谱拆解，购物清单 |
| **Aether** | https://github.com/mikevalstar/aether | — | 基于 Obsidian 的个人仪表盘 + AI Agent 平台 |

### UI 设计参考

| 项目 | 链接 | 说明 |
|------|------|------|
| **21st.dev** | https://21st.dev | 12,000+ React 组件，多套 UI 风格 |
| **shadcn/ui** | https://ui.shadcn.com | 最流行的 React 组件库 |
| **Geist** | https://geist.vercel.app | Vercel 设计系统，极简风格 |
| **Aceternity UI** | https://ui.aceternity.com | 炫酷动效组件 |
| **Magic UI** | https://magicui.design | 渐变光效组件 |

---

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│                   Electron 壳层                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ 主进程        │  │ 渲染进程      │  │ 托盘/通知   │  │
│  │ (main.js)    │  │ (React UI)   │  │ (Tray)     │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┘  │
│         │                 │                          │
│         └────────┬────────┘                          │
│                  │ IPC (contextBridge)                │
├──────────────────┴──────────────────────────────────┤
│  后端服务 (Fastify + Node.js)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │
│  │ API 路由  │ │ 工具模块  │ │ 搜索引擎 │ │ Agent  │  │
│  │          │ │          │ │          │ │ 编排   │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │
│  │ 知识管理  │ │ 密码库   │ │ 导出模块  │ │ 用户   │  │
│  │          │ │          │ │          │ │ 系统   │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘  │
├──────────────────────────────────────────────────────┤
│  数据层                                              │
│  ┌────────────────────────────────────────────────┐  │
│  │  SQLite (pacc.db) + JSON 文件 (配置/记忆)       │  │
│  │  数据目录: ./data/                              │  │
│  │  ├── settings.json    (配置)                    │  │
│  │  ├── pacc.db          (SQLite 数据库)            │  │
│  │  ├── conversations/   (对话历史)                 │  │
│  │  ├── documents/       (文档文件)                 │  │
│  │  ├── media/           (媒体文件)                 │  │
│  │  ├── backgrounds/     (背景图片)                 │  │
│  │  └── export/          (导出文件)                 │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## 依赖安装

```bash
# 工具箱
npm install pdf-lib xlsx sharp pdfjs-dist

# 音频转换
npm install ffmpeg-static

# 搜索引擎
npm install cheerio @mozilla/readability

# 知识管理
npm install marked dompurify
```

---

## 实施阶段

### 阶段一：UI 改造 + 多主题系统（3-4天）

| 任务 | 参考项目 | 优先级 |
|------|---------|--------|
| 控制台重新排版，按功能分类展示 | 21st.dev、shadcn/ui | P0 |
| 侧边栏重新分组（工作区/工具/AI/资源/系统） | — | P0 |
| 多主题 CSS 系统（6-8套主题） | 21st.dev、Geist、Aceternity UI | P1 |
| 设置页主题选择器，主题预览+切换 | — | P1 |

### 阶段二：工具箱（3-4天）

| 任务 | 参考项目 | 优先级 |
|------|---------|--------|
| 工具箱页面 UI（拖拽上传+格式选择+进度） | Stirling PDF | P0 |
| 格式转换引擎（pdf-lib + xlsx） | firecrawl/anydoc | P0 |
| 音频转换（ffmpeg-static） | 雷达推荐 | P1 |
| 音乐解锁（纯JS解密） | 雷达推荐 | P1 |
| 图片处理（sharp） | — | P2 |
| 小工具（编码转换/Base64等） | — | P2 |

### 阶段三：搜索引擎（4-5天）

| 任务 | 参考项目 | 优先级 |
|------|---------|--------|
| 搜索引擎页面 UI（搜索框+结果+筛选） | 小遥搜索、1052 OS | P0 |
| DuckDuckGo 搜索源（免费，无需API Key） | — | P0 |
| 网页抓取+正文提取（Playwright + Readability） | 1052 OS、OpenAgent | P0 |
| 本地文件搜索（FTS5） | 小遥搜索、Constella | P1 |
| 多搜索源聚合（Google/Brave/Bing可选） | 1052 OS | P1 |
| 搜索结果导出（CSV/JSON/Markdown） | — | P1 |
| 搜索源管理（增删改搜索源） | 1052 OS | P2 |

### 阶段四：知识管理（3-4天）

| 任务 | 参考项目 | 优先级 |
|------|---------|--------|
| 收藏夹管理（链接收藏+AI标签） | Linkwarden、Karakeep | P0 |
| 闪念备忘录（快速记录+搜索） | Memos | P1 |
| Markdown 编辑器（预览+编辑） | — | P1 |
| 双链知识库（笔记+双向链接） | Logseq | P2 |
| 团队 Wiki（SOP管理） | Outline、BookStack | P2 |

### 阶段五：Agent 工作室（3-4天）

| 任务 | 参考项目 | 优先级 |
|------|---------|--------|
| 能力包系统（按需加载工具包） | 1052 OS | P0 |
| MCP 工具集成 | oikOS、OpenAgent | P1 |
| 定时任务（Cron调度） | 1052 OS | P1 |
| 工作流图（可视化编排） | OpenHuman | P2 |
| 长期记忆（分层记忆管理） | OneBrain | P2 |

### 阶段六：数据导出 + 其他（2-3天）

| 任务 | 参考项目 | 优先级 |
|------|---------|--------|
| 数据导出功能（全平台导出） | — | P0 |
| 密码库（AES加密存储） | — | P1 |
| 私人相册（照片管理） | Immich | P2 |

---

## 设计原则

1. **单用户，本地优先** — 所有数据存储在本地，不依赖云端
2. **全部用 API Key** — 不跑本地模型，搜索和 AI 都走 API
3. **多套 UI 主题** — 可在设置中切换不同视觉风格
4. **数据可导出** — 所有数据支持导出，不锁定
5. **搜索引擎无广告** — 聚合多个搜索源，不展示广告
6. **模块化架构** — 每个功能独立模块，可独立开发

---

## 文件结构

```
D:\PersonalAICommandCenter\
├── PLAN.md                         # 本文件
├── src/
│   ├── backend/
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── toolbox/        # 工具箱模块（新建）
│   │       │   ├── search/         # 搜索引擎模块（新建）
│   │       │   ├── knowledge/      # 知识管理模块（新建）
│   │       │   ├── export/         # 导出模块（新建）
│   │       │   └── ...
│   │       └── lib/
│   │           └── converter/      # 转换引擎（新建）
│   └── frontend/
│       └── src/
│           ├── routes/
│           │   ├── CommandCenter.tsx  # 控制台（已改造）
│           │   ├── Toolbox.tsx       # 工具箱（新建）
│           │   ├── Search.tsx        # 搜索引擎（新建）
│           │   ├── Knowledge.tsx     # 知识管理（新建）
│           │   └── ...
│           ├── components/
│           │   └── Sidebar.tsx       # 侧边栏（已更新）
│           └── styles/
│               └── themes/           # 多主题 CSS（新建）
│                   ├── liquid-glass.css
│                   ├── shadcn.css
│                   ├── geist.css
│                   └── ...
```

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08 | 初始版本，AI 对话 + 媒体生成 + 文档生成 |
| v2.0 | 2026-08 | 控制台改造 + 侧边栏更新 + PLAN.md |
| v2.1 | 2026-08 | 工具箱 + 搜索引擎 + 知识管理（规划中） |