/**
 * T22 `TerminalTab` —— 后端共享命令历史 + 执行入口。
 *
 * ## 纯展示（D4）
 * 数据来自 `useWorkbenchTerminal` 的结果、经 props 传入；本文件零 hook、零 effect、
 * **零内部 state**。命令输入因此用**非受控 input + FormData** 提交：提交动作本身
 * 就是唯一需要的真相来源，不额外复制一份到 state。
 *
 * ## 诚实性
 * - `duration === null`（本地回显，服务端未计时）显示「本地回显」，**不编造时长**。
 * - `success` 来自 T21 `inferTerminalSuccess`（按后端三个失败前缀推断，execute 的
 *   响应体只有 `{ output }`）。失败行显式标 `data-success="false"`，不美化。
 * - `clear()` 只清本面板视图，不动后端共享的 100 条历史 —— 空态文案明说这一点。
 */
import { TerminalSquare, Trash2 } from "lucide-react"
import type { CSSProperties, FormEvent, ReactElement } from "react"

import type { TerminalLine, UseWorkbenchTerminalResult } from "../../../hooks/workbench"
import { EmptyState } from "../../ui/empty-state"
import { ErrorState } from "../../ui/error-state"
import { LoadingState } from "../../ui/loading-state"
import { footer, hint, iconButton, input, metaLabel, mono, panelRoot, scrollArea, stateFill } from "../shared"

export type TerminalTabProps = UseWorkbenchTerminalResult

const lineStyle: CSSProperties = {
  display: "block",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--text-secondary)",
}

const metaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
}

/** 单条历史：命令行 + 元信息（时间 / 时长 / 来源）+ 输出。 */
function HistoryLine({ line }: { readonly line: TerminalLine }): ReactElement {
  return (
    <div data-slot="workbench-terminal-line" data-success={line.success} data-source={line.source}>
      <span
        style={{
          ...mono,
          color: "var(--text-primary)",
          fontWeight: "var(--font-weight-medium)",
        }}
      >
        {`$ ${line.command}`}
      </span>
      <span style={{ ...metaRowStyle, ...hint }}>
        <span>{line.timestamp}</span>
        <span>{line.duration === null ? "本地回显" : `${line.duration}ms`}</span>
        <span>{line.source}</span>
        {!line.success ? (
          <span style={{ color: "var(--color-danger)" }}>失败（按输出前缀推断）</span>
        ) : null}
      </span>
      <span style={lineStyle}>{line.output}</span>
    </div>
  )
}

export function TerminalTab({
  history,
  execute,
  running,
  error,
  clear,
}: TerminalTabProps): ReactElement {
  /** 提交即执行：非受控 input 的值只在 submit 那一刻被读一次。 */
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const command = new FormData(event.currentTarget).get("command")
    event.currentTarget.reset()
    if (typeof command === "string") void execute(command)
  }

  return (
    <div
      data-slot="workbench-terminal"
      data-state={running ? "running" : error !== null ? "error" : history.length === 0 ? "empty" : "ready"}
      style={{ ...panelRoot, background: "var(--bg-base)" }}
    >
      {error !== null ? (
        // 读历史失败且一条都没有 → 整面板 ErrorState；有历史则退成顶部错误条，不遮住真实数据
        history.length === 0 ? (
          <div style={stateFill}>
            <ErrorState title="终端请求失败" description={error} />
          </div>
        ) : (
          <p
            data-slot="workbench-terminal-error"
            role="alert"
            style={{
              margin: 0,
              padding: "var(--space-2) var(--space-3)",
              borderBottom: "1px solid var(--border-subtle)",
              background: "var(--color-danger-subtle)",
              fontSize: "var(--font-size-caption)",
              color: "var(--text-secondary)",
            }}
          >
            读取历史失败，以下为本地已知的记录：{error}
          </p>
        )
      ) : history.length === 0 ? (
        <div style={stateFill}>
          <EmptyState
            icon={<TerminalSquare aria-hidden="true" />}
            title="还没有命令记录"
            description="在下方输入命令并执行。历史读自后端共享的最近 100 条记录（与 Agent 共用）——「清屏」只清本视图，不动后端。"
          />
        </div>
      ) : (
        <div style={{ ...scrollArea, padding: "var(--space-3)", ...mono }}>
          {history.map(line => (
            <HistoryLine key={line.key} line={line} />
          ))}
        </div>
      )}

      {/* 执行入口：running 时禁用重复提交，并给出 ui/loading-state */}
      <form data-slot="workbench-terminal-form" onSubmit={onSubmit} style={{ ...footer, flexWrap: "wrap" }}>
        <span style={{ ...metaLabel, color: "var(--text-tertiary)" }}>$</span>
        <input
          name="command"
          defaultValue=""
          placeholder="输入要执行的命令…"
          aria-label="Terminal command"
          autoComplete="off"
          spellCheck={false}
          style={input}
        />
        {running ? <LoadingState size="sm" label="执行中" /> : null}
        <button
          type="submit"
          data-slot="workbench-terminal-submit"
          disabled={running}
          style={
            running
              ? { ...iconButton, opacity: 0.4, cursor: "not-allowed" }
              : iconButton
          }
        >
          执行
        </button>
        <button
          type="button"
          onClick={clear}
          title="清屏（只清本视图）"
          aria-label="清屏"
          style={iconButton}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </form>
    </div>
  )
}
