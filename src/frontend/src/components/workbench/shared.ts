/**
 * T22 Workbench 面板的共享渲染基元。
 *
 * ## 为什么单独一层
 * 五个 tab 都要「撑满父容器 / 各自滚动 / 弱化说明 / 等宽正文」这几件事。
 * 各自写一遍就是五份可能漂移的内联样式，因此收敛到这里 —— tab 文件只留
 * 自己的结构，跨 tab 的排版基元只有这一处定义。
 *
 * ## 样式纪律（spec §16.2 / §69：安静克制）
 * 无渐变、无发光、无 shimmer；颜色**全部**走 CSS 变量（tokens.css + themes.css），
 * 组件内不出现任何字面色值；间距只取 4px 刻度（--space-*）。
 */
import type { CSSProperties } from "react"

/** 面板根：撑满父容器、列方向，滚动由具体子层负责。 */
export const panelRoot: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
}

/** 唯一负责 overflow 的层：内容再长也不撑破面板。 */
export const scrollArea: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
}

/** 状态层（loading / empty / error）居中铺满剩余空间。 */
export const stateFill: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-6)",
}

/** 顶部工具条：地址栏 / 表头上方的操作区。 */
export const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: "0 0 auto",
  padding: "var(--space-2)",
  borderBottom: "1px solid var(--border-primary)",
}

/** 底部固定条：终端输入 / 预览打开入口。 */
export const footer: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: "0 0 auto",
  padding: "var(--space-2) var(--space-3)",
  borderTop: "1px solid var(--border-primary)",
  background: "var(--surface-shell)",
}

/** 26px 小图标按钮（地址栏 / 导航 / 面板级操作）。 */
export const iconButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  padding: 0,
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  background: "var(--input-bg)",
  color: "var(--text-secondary)",
  cursor: "pointer",
  transition: "background var(--anim-duration-fast) var(--anim-ease), color var(--anim-duration-fast) var(--anim-ease)",
}

/** 弱化说明文字（空态副文案、诚实降级提示）。 */
export const hint: CSSProperties = {
  fontSize: "var(--font-size-caption)",
  lineHeight: "var(--line-height-body)",
  color: "var(--text-tertiary)",
}

/** 等宽正文：代码 / 终端 / 路径一律用它，不用无衬线。 */
export const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-caption)",
  lineHeight: "var(--line-height-relaxed)",
}

/** 元信息标签：表头与列名（大写 + 字距，spec 的 label 档）。 */
export const metaLabel: CSSProperties = {
  fontSize: "var(--font-size-label)",
  fontWeight: "var(--font-weight-medium)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  whiteSpace: "nowrap",
}

/** 输入控件：地址栏 / 终端命令行。 */
export const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: "0 var(--space-3)",
  border: "1px solid var(--input-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--input-bg)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-caption)",
  outline: "none",
}

/** 禁用态：光标与对比度一起退化，避免「看起来能点」。 */
export const disabled: CSSProperties = {
  opacity: 0.4,
  cursor: "not-allowed",
}

/**
 * ISO 时间戳 → `YYYY-MM-DD HH:mm`（UTC）。
 *
 * 刻意**不用** `toLocaleString`：那会把渲染结果绑到运行环境的 locale / 时区上，
 * 静态渲染断言会随机器漂移。不可解析时原样返回 —— 后端给了什么就显示什么，
 * 绝不替换成「刚刚」这类编造值。
 */
export function formatStamp(iso: string): string {
  if (iso === "") return "—"
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toISOString().slice(0, 16).replace("T", " ")
}

/**
 * 判别联合的穷尽性闸门。
 *
 * 闭集联合（`PreviewKind` 等）必须用 `switch` 穷尽；漏掉一个新成员时让它在这里
 * 编译失败，而不是静默落进「未知类型」的假分支。
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: 未覆盖的分支 ${JSON.stringify(value)}`)
}
