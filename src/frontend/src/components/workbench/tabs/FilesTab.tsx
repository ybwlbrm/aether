/**
 * T22 `FilesTab` —— 工具投影 ∪ 媒体 ∪ 文档的合并文件表。
 *
 * ## 纯展示（D4）
 * 数据来自 `useWorkbenchFiles` 的结果、经 props 传入；本文件零 hook、零 effect、
 * 零内部状态。
 *
 * ## 四态的优先级是有讲究的
 * 合并源用的是 `Promise.allSettled`：**一侧失败不该吞掉另一侧的真实数据**。
 * 因此 error 只在「一个文件都没有」时接管整块面板；只要还有行，就退成一条
 * 行内错误条，行照常渲染。
 *
 * ## 可点性不做假
 * `onOpenFile` 缺省时行是静态 `div`（不给假 affordance）；接上才升级为
 * `button` + `data-openable`。
 */
import { FolderOpen, RefreshCw, TriangleAlert } from "lucide-react"
import type { CSSProperties, ReactElement } from "react"

import type { UseWorkbenchFilesResult, WorkbenchFileRow } from "../../../hooks/workbench"
import { EmptyState } from "../../ui/empty-state"
import { ErrorState } from "../../ui/error-state"
import { LoadingState } from "../../ui/loading-state"
import { formatStamp, iconButton, metaLabel, mono, panelRoot, scrollArea, stateFill } from "../shared"

export interface FilesTabProps extends UseWorkbenchFilesResult {
  /** 行点击回调（切到 Code tab 等）；缺省时行不可点。 */
  readonly onOpenFile?: (path: string) => void
}

const GRID = "minmax(0, 1fr) 84px 84px 116px"

const headStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: GRID,
  gap: "var(--space-3)",
  alignItems: "center",
  height: 30,
  padding: "0 var(--space-3)",
  borderBottom: "1px solid var(--border-primary)",
  background: "var(--surface-shell)",
}

const cellStyle: CSSProperties = {
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  color: "var(--text-tertiary)",
}

const nameStyle: CSSProperties = { ...mono, color: "var(--text-primary)" }

const rowBase: CSSProperties = {
  display: "grid",
  gridTemplateColumns: GRID,
  gap: "var(--space-3)",
  alignItems: "center",
  width: "100%",
  height: 30,
  padding: "0 var(--space-3)",
  border: "none",
  borderBottom: "1px solid var(--border-subtle)",
  background: "transparent",
  textAlign: "left",
  fontSize: "var(--font-size-caption)",
}

/** 行的四个单元格：名称 / 类型 / 来源 / 更新时间。 */
function cells(row: WorkbenchFileRow): ReactElement {
  return (
    <>
      <span style={nameStyle} title={row.path}>
        {row.name}
        {row.truncated ? (
          <TriangleAlert
            size={11}
            aria-label="结果摘要被截断"
            style={{ marginLeft: 4, color: "var(--color-warning)", verticalAlign: "-1px" }}
          />
        ) : null}
      </span>
      <span style={cellStyle}>{row.kind}</span>
      <span style={cellStyle}>{row.source}</span>
      <span style={cellStyle}>{formatStamp(row.updatedAt)}</span>
    </>
  )
}

export function FilesTab({ files, refresh, loading, error, onOpenFile }: FilesTabProps): ReactElement {
  // 根节点的状态标记：一处判定，供外部选择器与测试用
  const state =
    loading
      ? "loading"
      : files.length === 0
        ? error === null
          ? "empty"
          : "error"
        : error === null
          ? "ready"
          : "partial"

  return (
    <div data-slot="workbench-files" data-state={state} style={panelRoot}>
      {/* 表头：列名用 metaLabel 档，不自造字号 */}
      <div style={headStyle}>
        <span style={metaLabel}>Name</span>
        <span style={metaLabel}>Type</span>
        <span style={metaLabel}>Source</span>
        <span style={metaLabel}>Updated</span>
      </div>

      {loading ? (
        <div style={stateFill}>
          <LoadingState size="sm" label="读取文件列表" description="合并工具事件、媒体资产与文档三个来源。" />
        </div>
      ) : error !== null && files.length === 0 ? (
        <div style={stateFill}>
          <ErrorState
            title="文件列表读取失败"
            description={error}
            action={
              <button type="button" onClick={refresh} style={iconButton} title="重试" aria-label="重试">
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            }
          />
        </div>
      ) : files.length === 0 ? (
        <div style={stateFill}>
          <EmptyState
            icon={<FolderOpen aria-hidden="true" />}
            title="没有文件"
            description="当前会话还没有文件。运行 Agent 任务（read / write / edit 工具）或产出文档 / 媒体后，这里会按路径列出它们。"
          />
        </div>
      ) : (
        <>
          {error !== null ? (
            <p
              data-slot="workbench-files-error"
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
              部分来源读取失败，其余照常显示：{error}
            </p>
          ) : null}
          <div style={scrollArea}>
            {files.map(row =>
              onOpenFile === undefined ? (
                <div
                  key={row.path}
                  data-slot="workbench-files-row"
                  data-path={row.path}
                  style={rowBase}
                >
                  {cells(row)}
                </div>
              ) : (
                <button
                  key={row.path}
                  type="button"
                  data-slot="workbench-files-row"
                  data-path={row.path}
                  data-openable="true"
                  onClick={() => onOpenFile(row.path)}
                  title={`打开 ${row.path}`}
                  style={{ ...rowBase, cursor: "pointer", color: "var(--text-secondary)" }}
                >
                  {cells(row)}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </div>
  )
}
