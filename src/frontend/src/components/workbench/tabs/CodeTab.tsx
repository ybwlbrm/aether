/**
 * T22 `CodeTab` —— 工具事件投影出的文件树 + 内容。
 *
 * ## 纯展示（D4）
 * 数据来自 `useWorkbenchCode` 的结果、经 props 传入；本文件零 hook、零 effect、
 * 零内部状态（选中态由 hook 持有）。
 *
 * ## 两条载荷路径必须分开渲染
 * `useWorkbenchCode` 按 T9 `hasFullToolPayload` 分流：
 *   ① 完整载荷 → `content` 是全文，`truncated` 为 false
 *   ② packed-replay → `content` 只有 200 字摘要 + 截断提示，`truncated` 为 true
 * 本组件据 `currentFile.truncated` 走两个**不同的**分支：降级路径顶部挂一条显式的
 * `truncated after replay` 提示，绝不把 200 字摘要排版成「看起来完整的文件」。
 */
import { FileCode2, FileWarning, FolderTree } from "lucide-react"
import type { CSSProperties, ReactElement } from "react"

import type { UseWorkbenchCodeResult, WorkbenchCodeFile } from "../../../hooks/workbench"
import { EmptyState } from "../../ui/empty-state"
import { hint, metaLabel, mono, panelRoot, scrollArea, stateFill } from "../shared"

export type CodeTabProps = UseWorkbenchCodeResult

/** 降级横幅：一句话说明「为什么短」，关键词与 T21 的 REPLAY_TRUNCATION_NOTICE 对齐。 */
const TRUNCATED_BANNER = "内容不完整：packed-replay 回放只给了工具摘要（truncated after replay）"

/** 工具操作 → 树里的单字母标记（read/write/edit/delete/mkdir/list）。 */
const OP_MARKS: Readonly<Record<WorkbenchCodeFile["op"], string>> = {
  read: "R",
  write: "W",
  edit: "E",
  delete: "D",
  mkdir: "M",
  list: "L",
}

/** 目录深度 → 缩进（按 / 与 \ 切段，最多 6 层，再深也不无限缩进）。 */
function depthOf(path: string): number {
  return Math.min(path.split(/[\\/]/).length - 1, 6)
}

const treeStyle: CSSProperties = {
  flex: "0 0 42%",
  minWidth: 0,
  borderRight: "1px solid var(--border-primary)",
  display: "flex",
  flexDirection: "column",
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  height: 24,
  padding: "0 var(--space-3)",
  border: "none",
  borderBottom: "1px solid var(--border-subtle)",
  background: "transparent",
  textAlign: "left",
  cursor: "pointer",
  color: "var(--text-secondary)",
}

export function CodeTab({ files, currentFile, selectFile, rawContent }: CodeTabProps): ReactElement {
  if (files.length === 0) {
    return (
      <div data-slot="workbench-code" style={panelRoot}>
        <div style={stateFill}>
          <EmptyState
            icon={<FolderTree aria-hidden="true" />}
            title="No run selected · 没有活动 run"
            description="当前会话还没有可投影的工具事件。运行一次 Agent 任务（read / write / edit 工具）后，这里会按路径列出它真正读写过的文件。"
          />
        </div>
      </div>
    )
  }

  return (
    <div data-slot="workbench-code" style={{ ...panelRoot, flexDirection: "row" }}>
      {/* 左：文件树 */}
      <div style={treeStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            flex: "0 0 auto",
            height: 28,
            padding: "0 var(--space-3)",
            borderBottom: "1px solid var(--border-primary)",
            background: "var(--surface-shell)",
          }}
        >
          <FolderTree size={13} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
          <span style={metaLabel}>Files</span>
          <span style={{ ...hint, marginLeft: "auto" }}>{files.length}</span>
        </div>
        <div style={scrollArea}>
          {files.map(file => {
            const active = file.path === currentFile?.path
            return (
              <button
                key={file.path}
                type="button"
                data-slot="workbench-code-row"
                data-path={file.path}
                data-op={file.op}
                data-active={active || undefined}
                data-source-truncated={file.sourceTruncated || undefined}
                onClick={() => selectFile(file.path)}
                title={file.path}
                style={{
                  ...rowStyle,
                  paddingLeft: `calc(var(--space-3) + ${depthOf(file.path)} * var(--space-2))`,
                  background: active ? "var(--sidebar-item-active)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                <span style={{ ...metaLabel, color: "var(--text-tertiary)" }}>
                  {OP_MARKS[file.op]}
                </span>
                <span
                  style={{
                    ...mono,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {file.name}
                </span>
                {file.truncated ? (
                  <FileWarning
                    size={12}
                    aria-label="内容不完整"
                    style={{ flex: "0 0 auto", color: "var(--color-warning)" }}
                  />
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      {/* 右：内容 */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            flex: "0 0 auto",
            height: 28,
            padding: "0 var(--space-3)",
            borderBottom: "1px solid var(--border-primary)",
            background: "var(--surface-shell)",
          }}
        >
          <FileCode2 size={13} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
          <span
            style={{
              ...mono,
              color: "var(--text-primary)",
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {currentFile?.path ?? ""}
          </span>
        </div>

        {currentFile?.truncated === true ? (
          <p
            data-slot="workbench-code-truncated"
            role="status"
            style={{
              ...hint,
              flex: "0 0 auto",
              margin: 0,
              padding: "var(--space-2) var(--space-3)",
              borderBottom: "1px solid var(--border-subtle)",
              background: "var(--color-warning-subtle)",
              color: "var(--text-secondary)",
            }}
          >
            {TRUNCATED_BANNER}
          </p>
        ) : null}

        <pre
          data-slot="workbench-code-content"
          style={{
            ...mono,
            flex: 1,
            minHeight: 0,
            margin: 0,
            padding: "var(--space-3)",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-primary)",
            background: "var(--surface-content)",
          }}
        >
          {rawContent}
        </pre>
      </div>
    </div>
  )
}
