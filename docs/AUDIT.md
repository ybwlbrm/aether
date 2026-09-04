# 系统深度审计与重构诊断书

> 审计对象：Aether (D:\PersonalAICommandCenter)
> 审计日期：2026-08-18（初始）｜2026-08-29（全维度复审）
> 审计范围：全维度（UX/A11y、UI 视觉工程、未定义边界、业务逻辑/竞态、性能/安全/代码质量、弃用/未实现专项）
> 技术栈：React 19 + Vite 6 + Fastify 5 + sql.js (SQLite) + Electron + Capacitor
>
> **2026-08-29 全维度复审修复状态（本报告）：**
> - P0 全部修复（47/47，含安全注入/穿越/SSRF/密钥、God 文件拆分、逻辑/性能回归）
> - P1 核心修复（认证层、重复逻辑归并、UI Token 主题修复、a11y、响应式）
> - 门禁：typecheck 0 / lint 0 error / build PASS / 后端 117（116 pass）/ 前端 37 全绿 / 生产冒烟+认证实测 PASS，综合 92/100（详见 docs/AUDIT-2026-09-04-final.md）
> - 完整明细见：`docs/AUDIT-2026-08-29-round1.md` 与 `docs/FIX-PLAN-2026-08-29.md`
>
> 初始审计（2026-08-18）关键结论（历史，已修复）：
> **UI 视觉精致但底层存在致命的加密密钥不一致缺陷——默认部署下所有 AI 调用 100% 返回 401，核心功能（对话/媒体生成/文档生成/Agent 编排）完全不可用；同时多处危险操作无二次确认、监控/测试连接直接使用数据库密文，系统处于"看起来能用但实际全坏"的假活状态。**

---

## 🏆 总体诊断结论

**UI 视觉精致但底层存在致命的加密密钥不一致缺陷——默认部署下所有 AI 调用 100% 返回 401，核心功能（对话/媒体生成/文档生成/Agent 编排）完全不可用；同时多处危险操作无二次确认、监控/测试连接直接使用数据库密文，系统处于"看起来能用但实际全坏"的假活状态。**

---

## 🚨 P0 级致命危机 (Critical Blockers)

### P0-1：加密密钥不一致——所有 AI 调用 401

**攻击路径/触发条件**：默认部署（未设置 `ENCRYPTION_KEY` 环境变量）下 100% 触发。

- `src/backend/src/config/index.ts:27-39`：首次启动生成随机 32 字节 hex 密钥存入 `.encryption_key` 文件（注释明确写"随机密钥文件替代确定性派生 `pacc-key-<dataDir>`"）。
- `src/backend/src/lib/provider.ts:100-103`：`getEncryptionKey()` 仍用旧的确定性派生 `process.env.ENCRYPTION_KEY || pacc-key-${dataDir}`。
- `src/backend/src/lib/crypto.ts:45-46`：解密失败时返回原值（密文 `enc:iv:tag:cipher`）。
- `src/backend/src/lib/provider.ts:114`：`apiKey: decrypt(row.apiKey, getEncryptionKey())` → 用错误密钥解密 → 返回密文。
- 后果：`getProviderById` / `getProviderByCapability` 返回的 `apiKey` 是密文，所有 AI 调用 `Authorization: Bearer enc:...` → 上游 API 401。

**修复方案**：统一加密密钥源，`provider.ts` 的 `getEncryptionKey()` 改为从 `config.encryptionKey` 读取（通过参数传入或复用 config 加载逻辑），不再自行派生。

```typescript
// src/backend/src/lib/provider.ts — 修复方案
// 删除 getEncryptionKey()，改为由调用方传入 config.encryptionKey
export function getProviderById(id: string, encryptionKey: string): ResolvedProvider | null { ... }
export function getProviderByCapability(capability, encryptionKey: string): ResolvedProvider | null { ... }
function rowToProvider(row, encryptionKey: string): ResolvedProvider {
  apiKey: decrypt(row.apiKey, encryptionKey), // 使用统一密钥
}
```

### P0-2：测试连接使用数据库密文——永远 401

- `src/backend/src/modules/providers/index.ts:205-207`：`fetch(.../models, { headers: { 'Authorization': 'Bearer ${provider.apiKey}' } })`，`provider.apiKey` 来自 `db.select()` 直接读取，是加密后的密文（`enc:...`），未经 decrypt。
- 后果：用户在 Providers 页面点"测试连接"永远显示 401，即使 API Key 完全正确。

**修复方案**：用 `decryptKey(result.apiKey, config.encryptionKey)` 解密后再调用。

```typescript
// 修复
const provider = db.select().from(providers).where(eq(providers.id, id)).get();
const plainKey = decryptKey(provider.apiKey, config.encryptionKey);
const response = await fetch(`${provider.baseUrl}/models`, {
  headers: { 'Authorization': `Bearer ${plainKey}` },
});
```

### P0-3：模型健康监控使用数据库密文——永远失败

- `src/backend/src/modules/monitoring/index.ts:84-85`：`fetch(..., { headers: { 'Authorization': 'Bearer ${p.apiKey}' } })`，`p.apiKey` 是 DB 密文。
- 后果：监控页面所有 Provider 永远显示"错误"，用户误以为所有 API Key 都失效。

**修复方案**：同 P0-2，用 `decryptKey` 解密。

### P0-4：多处危险删除无二次确认——数据丢失风险

以下删除操作直接执行，无 confirmDialog，误触即永久丢失：

| 文件 | 行号 | 操作 | 风险 |
|------|------|------|------|
| `src/frontend/src/routes/Media.tsx` | 342-350 | 删除媒体文件 | 不可恢复 |
| `src/frontend/src/routes/Knowledge.tsx` | 138-147 | 删除收藏/笔记 | 不可恢复 |
| `src/frontend/src/routes/Knowledge.tsx` | 406 | 删除 Wiki 页面 | 不可恢复 |
| `src/frontend/src/routes/Documents.tsx` | 53 | 删除文档 | 不可恢复 |
| `src/frontend/src/routes/Library.tsx` | 28-33 | 删除媒体/文档 | 不可恢复 |
| `src/frontend/src/routes/Settings.tsx` | 790-800 | 删除可访问目录 | 影响AI权限 |
| `src/frontend/src/routes/Settings.tsx` | 1046-1051 | 清除轮播图片 | 批量删除 |

**修复方案**：每个删除函数开头加 `if (!(await confirmDialog('确定删除...？此操作不可撤销。'))) return;`。

### P0-5：无 API Key 时返回 echo 假回复——误导用户

- `src/backend/src/modules/conversations/index.ts:460-463`：当没有配置 API Key 时，返回 `[No API key configured] Your message: ${content}` 作为"AI 回复"，保存到数据库并发送给前端。
- 后果：用户以为 AI 在回复，实际是 echo。对话历史被污染。

**修复方案**：改为发送明确的 error SSE 事件，不保存假回复。

```typescript
// 修复：无 API key 时发送错误事件而非 echo
if (!activeProvider?.apiKey) {
  sseSend('error', { message: '未配置 AI Provider 或 API Key。请在「AI Providers」页面配置后再试。' });
  return reply.raw.end();
}
```

### P0-6：Settings 目录管理调用错误端点——功能静默失效

- `src/frontend/src/routes/Settings.tsx:787`：调用 `api.saveSettings({ port, theme, bgImage, allowedDirs, defaultDir })`。
- `src/backend/src/modules/data/index.ts:48-49`：后端 `DANGEROUS_SETTINGS_FIELDS` 拒绝 `allowedDirs`/`defaultDir`，返回 403。
- 前端 `catch { /* ignore */ }` 吞掉错误 → UI 显示成功但后端未保存。
- 后果：用户添加/删除目录后刷新页面配置丢失，AI 文件工具权限不生效。

**修复方案**：前端改用专门的 `/api/settings/security` 端点（后端已实现，见 `data/index.ts:59-81`）。

---

## ⚠️ P1 级体验与规范债务 (UX/UI Debts)

### P1-1：长表单全部无草稿恢复

- `src/frontend/src/hooks/useAutosaveDraft.ts` 已实现（localStorage + debounce 1000ms），但**全项目零引用**。
- 受影响表单：Media 生成（10 字段）、Documents 生成（title/content）、Knowledge Wiki 编辑器、McpSettings（11 字段）、Providers 表单。
- 意外刷新/误触返回即丢失全部输入。

### P1-2：耗时操作假进度条 + 无取消机制

- `Media.tsx:270-272`：`setInterval(() => setGenProgress(prev => Math.min(prev + 5, 90)), 2000)` — 假进度，与真实生成无关。
- `Toolbox.tsx:112-114`：同样假进度 `Math.min(p + 15, 90)`。
- Media/Toolbox/Documents 生成中均无 AbortController 取消机制，用户只能干等。

### P1-3：按钮顺序不一致——破坏肌肉记忆

- `confirm-dialog.tsx:96-108`：取消在左、确认在右。
- 全站其他表单（Providers/Documents/McpSettings/Knowledge/Media）：主操作在左、取消在右。
- `Vault.tsx:317` 注释声称"保存在左"但代码实现是取消在左——注释与实现矛盾。

### P1-4：色彩对比度不达标

| 主题 | Token | 对比度 | WCAG AA 要求 |
|------|-------|--------|-------------|
| 浅色(themes.css:132) | text-secondary rgba(0,0,0,0.5) | 3.7:1 | 4.5:1 ❌ |
| 浅色(themes.css:133) | text-tertiary rgba(0,0,0,0.3) | 2.1:1 | 3:1 ❌ |
| dark-minimal.css:38 | text-secondary rgba(255,255,255,0.45) | 4.4:1 | 4.5:1 ❌ |
| dark-minimal.css:39 | text-tertiary rgba(255,255,255,0.25) | 2.0:1 | 3:1 ❌ |

### P1-5：交互热区过小

- `Vault.tsx:297` 分类按钮 ~12px 高；`Vault.tsx:347-362` 操作按钮 ~22px；`Knowledge.tsx:246/287/403-408` 删除按钮 ~14-22px。
- WCAG 2.5.5 要求 44px 触控目标。

### P1-6：模棱两可的文案

- `App.tsx:28-30`："页面出错了"+"发生未知错误"（无解决方案）。
- `Toolbox.tsx:131/167/176`："处理失败"（无具体原因）。
- `Chat.tsx:135`：`[错误] ${res.status}`（只有状态码）。

### P1-7：Z-Index 体系混乱

- `tokens.css` 定义了完整 scale（modal:1610, toast:1700, tooltip:1800）。
- `Media.tsx` 完全绕过：modal zIndex:300、toast:400（远低于 confirm-dialog 的 1600）。
- `Sidebar.tsx` 用 z-50（=50），与 modal z-50 相同。
- `select.tsx`/`tooltip.tsx` 用 z-50，通过 Portal 渲染到 body 末尾会盖住 z-50 的 modal。

### P1-8：Glassmorphism 内联 backdrop-filter 无降级

- `components.css:36-46` 有 `@supports not` 降级，但仅覆盖 CSS 类。
- JSX 内联 `backdropFilter: 'blur(8px)'`（Media.tsx:94/762/854、CommandPalette.tsx:101、Providers.tsx:281 等）不受 `@supports` 保护，不支持的浏览器上背景透明导致文字不可读。

### P1-9：Design Tokens 大量被绕过

- 颜色硬编码 `#5e9eff`/`#a78bfa`/`#34d399` 等遍布 15+ 文件。
- `rounded-[14px]` 出现在 19 个文件（恰好等于 `--radius-md` 但写成魔法值）。
- 阴影硬编码（Chat.tsx:344/417、PageHeader.tsx:29 等），无统一 elevation scale。

### P1-10：响应式缺失

- 无自定义 `@media` 查询（仅靠 Tailwind 断点）。
- `Toolbox.tsx:219` `grid-cols-4` 无响应式前缀，窄屏挤爆。
- `Knowledge.tsx:390` `grid-cols-2` 无响应式。
- 折叠屏 768-1024 无专门处理。

### P1-11：Sync 模块双轨制 + 后端配置不持久化

- `Settings.tsx:52-55` `getSupabase()` 返回 null 死代码，前端绕过后端 sync 模块直连 Supabase。
- 后端 `sync/index.ts` 150 行代码基本未被前端使用。
- `sync/index.ts:25-40` 配置存内存变量，重启丢失。

### P1-12：fetchWithRetry abort 后仍重试

- `conversations/index.ts:65-71`：AbortError 只在 `!lastError` 时直接抛出；重试过一次后用户取消会继续指数退避重试（最多 ~30s），客户端断连后 AI 请求不立即停止。

### P1-13：Chat loadMessages 竞态

- `Chat.tsx:43-57`：快速切换对话时慢请求后返回会覆盖当前对话消息列表（currentConvRef 只保护流式回调，不保护 loadMessages）。

### P1-14：agents abort 后仍保存半截回复

- `agents/index.ts:804-812`：客户端 abort 后各 fetch 抛 AbortError 被 catch 吞掉，代码继续执行保存半截 AI 回复到 DB，用户点"停止"后对话里仍写入不完整回复。

### P1-15：Knowledge/搜索知识库结果空链接

- `Search.tsx:68,74`：知识库/笔记结果 `url: ''`，`Search.tsx:227` `<a href={r.url}>` 空链接点击刷新当前页。

### P1-16：MCP 权限绕过

- `permissions/index.ts` Level 1（只读）只限制文件工具（`files.ts:124-129`），MCP 工具调用（`callMcpTool`）无权限级别检查，Level 1 下仍可调用 MCP 写工具。

### P1-17：documents AI 生成无重试

- `documents/index.ts:287-298, 325-336`：AI 生成 PPT/DOC 内容用裸 fetch，无 fetchWithRetry，429/5xx 直接失败静默降级到 fallback 内容。

### P1-18：toolbox 外部依赖硬编码路径

- `toolbox/index.ts:11-14`：`FFMPEG_PATH = 'D:\\ffmpeg\\...'`、`SOFFICE_PATH = 'C:\\Program Files\\LibreOffice\\...'`，用户机器无此路径则功能直接报错，无检测/引导安装。

### P1-19：loading/error 三态声明但未渲染

- `Documents.tsx:31-32`：声明了 loading/error state 但从未在 JSX 中渲染，加载失败时用户看到空状态"还没有文档"。
- `Projects.tsx:29-30`：同样问题。

### P1-20：无 CSP 头

- `index.html` 无 Content-Security-Policy meta 标签。

---

## 🔧 P2 级性能与安全隐患 (Code Warnings)

### P2-1：277 处 `any` 类型使用

遍布 45 文件。代表位置：`Chat.tsx:11-18`（`useState<any[]>`）、`client.ts:39-40`（`AbortSignal as any`）、`sync/index.ts` 多处、`toolbox/index.ts` 多处。

### P2-2：50 处静默 catch

`catch {}` / `catch(() => {})` 遍布 19 文件。代表位置：`Chat.tsx:32-35,82,564`、`Monitoring.tsx:28`、`SelfCheck.tsx:15`、`Settings.tsx:166,182,652,677,804,816`、`Search.tsx:51,77,109,137`。

### P2-3：Settings.tsx 1133 行——单一职责违规

63KB 单文件包含 GeneralSettings/AppearanceSettings/SyncSettings/DataManage 等多个组件，应拆分。

### P2-4：后端大依赖静态导入

- `documents/index.ts:10-11`：`pptxgenjs` + `docx` 静态导入（非懒加载）。
- `toolbox/index.ts:7-8`：`pdf-lib` + `xlsx` 静态导入。
- 影响：后端启动时间和内存占用。

### P2-5：Chat 消息列表未 memo

- `Chat.tsx` 消息列表内联渲染，未用 `React.memo`，流式更新时全列表重渲染。

### P2-6：hover-glow-button mousemove 无 rAF 节流

- `hover-glow-button.tsx:52`：`onMouseMove` 直接 setState，无 requestAnimationFrame 节流。

### P2-7：memories 表定义但未使用

- `db/schema/index.ts:64-72`：定义了 `memories` 表，但实际记忆存 JSON 文件（`dal.ts` memory.json），SQLite 表空置。

### P2-8：agents saveMemory 导入未使用

- `agents/index.ts:9`：`import { saveMemory }` 但全文件无调用（死代码）。

### P2-9：media 视频轮询无 abort

- `media/index.ts:182-200`：视频轮询 60 次 × 5s，客户端断开后轮询继续最多 5 分钟。

### P2-10：conversations 列表全表扫描

- `conversations/index.ts:110-121`：每次列表请求全表扫描所有 assistant 消息解析 toolResults 计算 tokenTotal，O(n) 性能问题。

### P2-11：数据双轨制

- `/api/chat` 系列与 `/api/conversations` 系列并存（`data/index.ts:108-128`）。
- `localStorage('chat_conversations')` 死数据（Chat.tsx 用后端 API）。

### P2-12：API Key 明文返回端点

- `providers/index.ts:180-191`：`/api/providers/:id/apikey` 返回明文 API Key，无鉴权，本机任何进程可获取。

### P2-13：supabaseKey 明文存 localStorage

- `Settings.tsx:147`：`localStorage.setItem('syncConfig', JSON.stringify({ supabaseUrl, supabaseKey, connected: true }))` — Supabase Key 明文存储。

### P2-14：未实现功能残留

- `AgentSettings.tsx:219-220`：定时任务/MCP 工具标记 `enabled: false` "规划中"。
- `Knowledge.tsx:96`：导入文件"类型 X 的文件解析将在后续版本提供"。
- PLAN.md 列出的 qmc/kgm 音乐解锁、PDF OCR、尺寸调整、双链知识库、Agent 可视化工作流图均未实现。
- 后端 `toolbox/index.ts:329-334` 有 gbk-utf8 工具但前端无入口。

### P2-15：Sidebar/CommandPalette GitHub 死链接

- `Sidebar.tsx:46`、`CommandPalette.tsx:35`：指向 `https://github.com`（通用首页，非项目仓库）。

### P2-16：自动标题 emoji 截断

- `conversations/index.ts:482`：`body.content.slice(0, 30)` 可能截断 emoji surrogate pair 导致乱码。

### P2-17：crypto.ts 明文回退

- `crypto.ts:30-33`：非 `enc:` 格式的旧数据返回明文（有 warning 但不阻断），迁移期间可接受但应限期强制加密。

---

## 💡 架构师重构方案

### 方案一：加密密钥统一（P0-1/2/3 合并修复）

```typescript
// src/backend/src/lib/provider.ts
// 删除 getEncryptionKey()，所有函数接收 encryptionKey 参数

export function getProviderById(id: string, encryptionKey: string): ResolvedProvider | null {
  const db = getDb();
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!row) return null;
  return rowToProvider(row, encryptionKey);
}

export function getProviderByCapability(
  capability: 'image' | 'video' | 'text' | 'audio',
  encryptionKey: string
): ResolvedProvider | null {
  const db = getDb();
  const all = db.select().from(providers).all().map(r => rowToProvider(r, encryptionKey));
  // ... 后续逻辑不变
}

function rowToProvider(row: any, encryptionKey: string): ResolvedProvider {
  return {
    // ...
    apiKey: decrypt(row.apiKey, encryptionKey), // 统一使用传入的密钥
    // ...
  };
}
```

所有调用方（`conversations/index.ts`、`agents/index.ts`、`media/index.ts`、`documents/index.ts`）传入 `config.encryptionKey`。

### 方案二：危险操作统一确认（P0-4 修复）

```typescript
// 在每个删除函数开头统一加确认
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';

const handleDelete = async (id: string) => {
  if (!(await confirmDialog('确定删除此文件？此操作不可撤销。'))) return;
  // ... 原删除逻辑
};
```

### 方案三：草稿恢复接入（P1-1 修复）

```typescript
// 在长表单组件中接入已有的 useAutosaveDraft
const [form, setForm, clearDraft] = useAutosaveDraft('media_gen_draft', {
  type: 'image', prompt: '', negativePrompt: '', model: '', size: '1024x1024',
});
// 表单提交成功后 clearDraft()
```

### 方案四：Z-Index 统一（P1-7 修复）

```css
/* 所有组件统一使用 tokens.css 定义的 z-index token */
/* Media.tsx modal: zIndex 300 → var(--z-modal) */
/* Media.tsx toast: zIndex 400 → var(--z-toast) */
/* Sidebar: z-50 → var(--z-fixed) */
/* select/tooltip: z-50 → var(--z-popover) */
```

### 方案五：Settings.tsx 拆分（P2-3 修复）

```
src/frontend/src/routes/settings/
├── index.tsx              (路由入口 + tab 切换)
├── GeneralSettings.tsx
├── AppearanceSettings.tsx
├── SyncSettings.tsx
└── DataManage.tsx
```

---

## 审计摘要统计

| 等级 | 数量 | 分布 |
|------|------|------|
| P0 | 6 | 后端加密(3) + 前端删除确认(1) + 后端假回复(1) + 前端端点错误(1) |
| P1 | 20 | UX(8) + UI 规范(6) + 竞态/策略(4) + 安全(2) |
| P2 | 17 | 代码质量(7) + 性能(4) + 安全(3) + 未实现(3) |
| **合计** | **43** | |

**TODO/Mock 残留**：源码内 0 处 TODO/FIXME；`data/index.ts:117-122` 已弃用端点返回 410（已处理）；`conversations/index.ts:460-463` echo 假回复（P0-5）；`agents/index.ts:9` saveMemory 死导入（P2-8）。

**弃用功能残留**：微信功能已在 CHANGELOG 确认完全移除（前端/后端/Python/ACP 全部删除），eslint 配置中 `wechat-bridge/**` ignore 规则已无对应目录（无害残留）。

**未实现功能**：AgentSettings 定时任务/MCP 工具/工作流图（标记"规划中"）；Knowledge 双链知识库；Toolbox qmc/kgm/PDF OCR/尺寸调整/GBK 前端入口。
