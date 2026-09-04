# Aether — 开发计划

## 技术栈 (P2-9: 已更新为实际使用)
- **Frontend**: React 19 + Vite 6 + TypeScript + Tailwind CSS 4 + Framer Motion + Zustand
- **Backend**: Node.js + Fastify v5 + Drizzle ORM + sql.js (SQLite WASM)
- **AI**: Vercel AI SDK v7 (多 Provider 统一层)
- **文档生成**: pptxgenjs + docx
- **MCP**: @modelcontextprotocol/sdk v1.30

## 项目结构
```
D:\PersonalAICommandCenter\
├─ package.json              # 根 npm workspaces
├─ tsconfig.base.json        # 共享 TS 配置
├─ .gitignore
├─ .env.example
├─ docs\                     # 文档
├─ src\
│  ├─ shared\                # 共享类型 + schema
│  ├─ backend\               # Fastify 服务端
│  └─ frontend\              # Vite React 前端
```

## 开发阶段

### Phase 1: 核心框架与基础设施
- [x] 1.1 Monorepo 脚手架
- [ ] 1.2 共享合约包
- [ ] 1.3 后端 App 骨架
- [ ] 1.4 数据库层
- [ ] 1.5 API 文档
- [ ] 1.6 前端 Shell
- [ ] 1.7 质量门禁

### Phase 2: AI Provider 中心 + 统一 AI 层 + Agent 核心
- [ ] 2.1 Provider CRUD + 安全存储
- [ ] 2.2 统一 AI 工厂
- [ ] 2.3 管理页面 + 连接测试
- [ ] 2.4 流式聊天
- [ ] 2.5 记忆系统
- [ ] 2.6 工具系统
- [ ] 2.7 Agent 运行时
- [ ] 2.8 MCP 集成

### Phase 3: 媒体/文档/项目/版本管理
- [ ] 3.1 媒体 API
- [ ] 3.2 媒体中心 UI
- [ ] 3.3 PPT 生成管线
- [ ] 3.4 DOC 生成管线
- [ ] 3.5 文档 UI
- [ ] 3.6 项目展示
- [ ] 3.7 版本管理
- [ ] 3.8 展示 UI

### Phase 4: 工作流 + 微信桥接 + 打包
- [ ] 4.1 工作流引擎
- [ ] 4.2 示例工作流
- [ ] 4.3 工作流 UI
- [ ] 4.4 Web 工具
- [ ] 4.5 微信桥接
- [ ] 4.6 打包发布