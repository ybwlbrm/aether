# DeepSeek Harness 对照更改计划书

> 参考：deepseek-harness-master/packages/client/
> 对照桌面截图 IMG_20260824_215942.jpg 发现的问题

---

## 问题 1：文件路径和表格背景黑色

**截图现象**：文件路径底下有黑色背景，代码表格右上角有复制/下载/全屏按钮，背景也是黑色。

**对照 DeepSeek 源码**：
- `AssistantMarkdown.tsx` 使用 `MarkdownText` 组件渲染 markdown，**无背景**
- `ToolRow.module.css` 的 `.summary` 和 `.fileLink` 都是 **纯文字，无背景色**
- 代码块在 DeepSeek 中通过 `MarkdownText` 渲染，背景由 CSS 变量控制，可透明

**需要改**：
1. `CodeTableView.tsx` — 所有容器的 `background` 改为 `transparent`
2. `OpenCodeBlock.tsx` — 传递到 CodeTableView 时确保无背景
3. Streamdown 的代码块渲染 — 检查是否有 `pre`/`code` 标签的默认深色背景

---

## 问题 2：思考过程在输入框上方，没在对话流里

**截图现象**：`keep diving...` 在输入框上方，但思考过程应该出现在对话里。

**对照 DeepSeek 源码**：
- `ReasoningRow.tsx` — 思考是 `Think` 可折叠行，**在消息流内**，不是独立条
- `AssistantMarkdown.tsx` — `reasoning` 块渲染为 `ReasoningRow`，在 `text` 块之间
- `ChatView.tsx` — 整个对话是**单一滚动节点流**，思考行在助理消息里

**需要改**：
1. 移除 `ThinkingIndicator`（输入框上方的 `keep diving...`）
2. 思考内容通过 `agent.reasoning.delta` 事件进入 `ActivityStream`，作为 `ThinkLine` 显示
3. `ThinkLine` 应渲染为可折叠行（参考 `ReasoningRow.tsx`）

---

## 问题 3：输出不是流式的，一下子蹦出来

**截图现象**：工具过程没有逐步输出，是一下子出现的。

**对照 DeepSeek 源码**：
- `ToolCallTree.tsx` → `GenericToolCard.tsx` → `ToolRow.tsx` — 工具是**实时渲染**的
- 每个 `tool-call` 块在消息流中作为独立工具行渲染
- 工具行有 `data-state="running"` 状态，运行中显示光带动画
- 工具结果完成后状态变为 `ok`

**需要改**：
1. 确保事件是实时追加到 store 的（`appendEvent` 已在 `streamClient` 中实现）
2. `ActivityStream` 在消息流中实时渲染（每次事件到达都触发重渲染）
3. 工具行在 `running` 状态时显示光带动画，完成后变为 `ok`

---

## 问题 4："✓ 完成" 输出两次

**截图现象**：`✓ 完成` 在用户消息上方出现一次，在最下面又出现一次。

**对照 DeepSeek 源码**：
- DeepSeek 中 `✓ 完成` 只出现一次，在任务结束时
- `AssistantMarkdown.tsx` 不渲染 `tool-call` 块，由 ChatView 通过工具树渲染
- 完成标记由 `TurnTailNodeView` 渲染，只在 turn 结束时一次

**需要改**：
1. `ActivityStream` 中的 `DoneLine` 确保只渲染一次（`hasDone` 标记已实现）
2. 检查是否在消息渲染和 ActivityStream 中同时出现了完成标记
3. 消息气泡中的 `✓ 完成` 文本应从消息内容中移除（由 ActivityStream 统一显示）

---

## 问题 5：没有累计 token 显示

**截图现象**：没有显示总共消耗的 token 数量。

**对照 DeepSeek 源码**：
- `TurnTailNodeView.tsx` 在 turn 底部显示 token 用量和统计信息
- `StatsLine.tsx` 渲染统计行：`LLM 11m43s · 工具调用 37m59s | 首 tok 平均 1.2s · 168 tok/s | 缓存命中 97% | 输入 6.8M tok · 输出 101K tok`

**需要改**：
1. 在消息流底部（或 ActivityStream 尾部）添加 token 统计行
2. 从 `token` 事件中读取 `total_tokens` 数据
3. 格式参考 DeepSeek：`LLM Ns · 工具调用 Ns | 输入 N tok · 输出 N tok`

---

## 问题 6：输入框没有 glass 效果，不能调节

**截图现象**：输入框没有玻璃效果，不能调节透明度和开关。

**对照 DeepSeek 源码**：
- `InputBar.module.css` — 输入框是 `border-radius: 22px`，`border: 1px`，`box-shadow`
- 背景使用 `--dsw-specific-input-major` 变量（可随主题切换）
- 透明度通过 CSS 变量控制，不是直接 opacity

**需要改**：
1. 输入框当前使用 `.input` CSS 类，已有玻璃效果（backdropFilter）
2. 在设置页面添加玻璃效果开关和透明度滑块
3. 玻璃效果通过 CSS 变量控制：`--glass-blur-radius`、`--glass-opacity`

---

## 实施优先级

| 优先级 | 问题 | 工作量 | 参考 DeepSeek 源码 |
|---|---|---|---|
| P0 | 重复输出 ✓ 完成 | Quick | `TurnTailNodeView.tsx` |
| P0 | 文件路径/表格背景黑色 | Quick | `MarkdownText`、`ToolRow.module.css` |
| P1 | 思考过程在对话流里 | Medium | `ReasoningRow.tsx`、`AssistantMarkdown.tsx` |
| P1 | 流式输出过程 | Medium | `ToolCallTree.tsx`、`ToolRow.tsx` |
| P2 | Token 累计显示 | Quick | `TurnTailNodeView.tsx`、`StatsLine.tsx` |
| P2 | 输入框 glass 调节 | Medium | `InputBar.module.css` |

---

## 确认后开始实施

以上 6 个问题，每一个都对照了 DeepSeek Harness 源码。确认后我开始按 P0→P1→P2 顺序改。