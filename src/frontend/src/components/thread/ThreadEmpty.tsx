/**
 * ThreadEmpty —— 会话空态（T17）。
 *
 * 视觉契约（frontend-design check #1 / redesign-skill「无卡片堆叠」）：
 * 左对齐、sentence case、一行提示语。**不是**居中 hero —— 居中会把用户的注意力
 * 从 composer 拉走，而空态的全部职责只是告诉用户"往哪打字"。
 * 因此这里没有图标、没有标题梯级、没有卡片边框，只有一条与消息正文同左缘的提示。
 */

export interface ThreadEmptyProps {
  /** 提示语（sentence case，默认中文短句） */
  readonly hint?: string
  /** 附加说明（可选，同样左对齐） */
  readonly detail?: string
}

const DEFAULT_HINT = "描述你的任务，Agent 会在这个会话里展开工具调用与审批。"

export function ThreadEmpty({ hint = DEFAULT_HINT, detail }: ThreadEmptyProps) {
  return (
    <div
      data-slot="thread-empty"
      data-align="start"
      className="flex flex-col items-start gap-2 px-4 py-8 text-left"
    >
      <p className="m-0 max-w-[68ch] text-sm leading-relaxed text-[var(--text-secondary)]">{hint}</p>
      {detail === undefined ? null : (
        <p className="m-0 max-w-[68ch] text-xs leading-relaxed text-[var(--text-tertiary)]">{detail}</p>
      )}
    </div>
  )
}
