# 全面对齐 DeepSeek Harness 更改计划

> 参考源码：deepseek-harness-master/packages/client/
> 涉及：AI 对话输入/输出的所有 UI 组件

---

## 一、ActivityStream（工具行）— 参考 ToolRow.tsx + ToolRow.module.css

| 当前 | 目标 | 参考源码 |
|------|------|----------|
| `Read · path` 纯文字 | `[title] · [summary]` 14px/24px | ToolRow.tsx L34-80 |
| 无动画 | 运行中光带扫过 2.6s | ToolRow.module.css L14-38 |
| 无状态标记 | `data-state="running"` / `"ok"` / `"error"` | ToolRow.module.css L18 |
| 文件路径纯文字 | 下划线 + hover 可点击 | ToolRow.module.css L102-126 |
| 2px 圆点 `·` margin 8px | 2x2px 圆点 border-radius 1px | ToolRow.module.css L67-74 |
| 已完成 | ☑️ 已实现 | — |

## 二、Reasoning（思考）— 参考 ReasoningRow.tsx

| 当前 | 目标 | 参考源码 |
|------|------|----------|
| ThinkingIndicator 输入框上方独立条 | 消息流内可折叠 Think 行 | ReasoningRow.tsx L27-65 |
| `keep diving...` 蓝色文字 | `Think` 图标 + 摘要灰色文字 | ReasoningRow.tsx L49 |
| 展开显示完整内容 | 折叠显示最新行，展开显示全文 | ReasoningRow.tsx L30 |
| 无动画 | `useThrottledVisualUpdate` 平滑滚动 | ReasoningRow.tsx L31-38 |
| `data-variant` 属性 | 无 | ReasoningRow.tsx L41 |

## 三、用户消息 — 参考 MessageItem.tsx UserStyleBubble

| 当前 | 目标 | 参考源码 |
|------|------|----------|
| 透明背景纯文字 | 右对齐气泡，有背景色，圆角 | MessageItem.tsx L216-249 |
| 无时间戳 | 带 time + clock + copy 按钮 | MessageItem.tsx L291-302 |
| 无引用标记 | 支持 @引用 + 文件引用 chip | MessageItem.tsx L156-213 |

## 四、输入框 — 参考 InputBar.tsx + InputBar.module.css

| 当前 | 目标 | 参考源码 |
|------|------|----------|
| `.input` 类玻璃效果 | 圆角 22px，border l2，box-shadow | InputBar.module.css L55-58 |
| 无 pending 动画 | 8px 脉冲圆点 `input-pending` 1s | InputBar.module.css L171-182 |
| 无装饰层 | backdrop 装饰层 + 透明 textarea | InputBar.module.css L140-199 |

## 五、动画 — 参考 ToolRow.module.css + InputBar.module.css

| 动画 | 目标 | 参考 |
|------|------|------|
| 工具运行 | 光带扫过 2.6s ease-out infinite | `dsh-tool-row-sweep` |
| 输入 pending | 脉冲 1s ease-in-out infinite alternate | `input-pending` |
| 状态切换 | `data-state` + `data-streaming` 驱动 CSS | ToolRow.module.css L18 |

## 六、实施顺序

```
Wave 1: ActivityStream 动画 + 样式对齐（已完成）
Wave 2: 用户消息气泡 UserStyleBubble（MessageItem.tsx 参考）
Wave 3: 输入框 InputBar 样式对齐（22px 圆角 + pending 动画）
Wave 4: Reasoning 行改为消息流内 Think 折叠行
Wave 5: 全量测试 + 构建验证
```

确认后开始改？