/**
 * T22 `PreviewTab` —— 文档 / 媒体产物的列表与预览。
 *
 * ## 纯展示（D4）
 * 数据来自 `useWorkbenchPreview` 的结果、经 props 传入；本文件零 hook、零 effect、
 * 零内部状态（选中项由 hook 持有）。
 *
 * ## 取址不做假
 * 文档的地址来自 `api.documentDownloadUrl(id)`（T21 已拼好 `/api/documents/<id>/download`）；
 * 媒体的 `url` **可能为空串** —— 那表示后端 `path` 为空，没有可加载文件。
 * 此时渲染诚实提示，**绝不**拿一个本地拼出来的假地址顶上。
 *
 * ## kind 是闭集联合
 * `PreviewKind = 'ppt' | 'doc' | 'image' | 'video' | 'audio'`，用 `switch` 穷尽，
 * 漏掉新成员会在 `assertNever` 处编译失败，而不是落进「未知类型」的假分支。
 */
import { Eye, FileDown, MousePointerClick } from "lucide-react"
import type { CSSProperties, ReactElement } from "react"

import type { PreviewItem, UseWorkbenchPreviewResult } from "../../../hooks/workbench"
import { EmptyState } from "../../ui/empty-state"
import { ErrorState } from "../../ui/error-state"
import { LoadingState } from "../../ui/loading-state"
import { assertNever, footer, formatStamp, iconButton, mono, panelRoot, scrollArea, stateFill } from "../shared"

export type PreviewTabProps = UseWorkbenchPreviewResult

const listStyle: CSSProperties = {
  flex: "0 0 44%",
  minWidth: 0,
  borderRight: "1px solid var(--border-primary)",
  display: "flex",
  flexDirection: "column",
}

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  height: 30,
  padding: "0 var(--space-3)",
  border: "none",
  borderBottom: "1px solid var(--border-subtle)",
  background: "transparent",
  textAlign: "left",
  fontSize: "var(--font-size-caption)",
  color: "var(--text-secondary)",
  cursor: "pointer",
}

/** 按 kind 穷尽渲染预览主体。 */
function PreviewBody({ item }: { readonly item: PreviewItem }): ReactElement {
  if (item.url === "") {
    return (
      <div style={stateFill}>
        <EmptyState
          title="没有可加载的文件"
          description={`「${item.name}」在后端没有可用的文件路径（url 为空），因此不渲染任何预览地址。`}
        />
      </div>
    )
  }

  const frame: CSSProperties = {
    flex: 1,
    minHeight: 0,
    width: "100%",
    border: "none",
    background: "var(--surface-elevated)",
  }

  switch (item.kind) {
    case "image":
      return <img data-slot="workbench-preview-media" src={item.url} alt={item.name} style={frame} />
    case "video":
      return <video data-slot="workbench-preview-media" src={item.url} controls style={frame} />
    case "audio":
      return <audio data-slot="workbench-preview-media" src={item.url} controls style={frame} />
    case "doc":
    case "ppt":
      return (
        <div style={{ ...stateFill, flexDirection: "column", gap: "var(--space-3)" }}>
          <FileDown size={24} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
          <span style={{ ...mono, color: "var(--text-primary)" }}>{item.name}</span>
          <a
            data-slot="workbench-preview-open"
            href={item.url}
            target="_blank"
            rel="noreferrer"
            style={{ ...iconButton, width: "auto", padding: "0 var(--space-3)", textDecoration: "none" }}
          >
            打开（{item.kind === "ppt" ? "PPTX" : "文档"}）
          </a>
        </div>
      )
    default:
      return assertNever(item.kind, "PreviewTab 预览分支")
  }
}

export function PreviewTab({ items, open, current, loading, error }: PreviewTabProps): ReactElement {
  // 根节点的状态标记：loading > 已选中 > 空/错 > 列表浏览中
  const state =
    loading
      ? "loading"
      : current !== null
        ? "previewing"
        : items.length === 0
          ? error === null
            ? "empty"
            : "error"
          : "browsing"

  if (loading) {
    return (
      <div data-slot="workbench-preview" data-state={state} style={panelRoot}>
        <div style={stateFill}>
          <LoadingState size="sm" label="读取产物" description="合并媒体资产与文档两个来源。" />
        </div>
      </div>
    )
  }

  if (error !== null && items.length === 0 && current === null) {
    return (
      <div data-slot="workbench-preview" data-state={state} style={panelRoot}>
        <div style={stateFill}>
          <ErrorState title="产物读取失败" description={error} />
        </div>
      </div>
    )
  }

  if (items.length === 0 && current === null) {
    return (
      <div data-slot="workbench-preview" data-state={state} style={panelRoot}>
        <div style={stateFill}>
          <EmptyState
            icon={<Eye aria-hidden="true" />}
            title="还没有产物"
            description="生成文档（PPT / Word）或媒体（图片 / 视频 / 音频）之后，这里会列出它们并支持预览。"
          />
        </div>
      </div>
    )
  }

  return (
    <div data-slot="workbench-preview" data-state={state} style={{ ...panelRoot, flexDirection: "row" }}>
      {/* 左：产物列表 */}
      <div style={listStyle}>
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
          <MousePointerClick size={13} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
          <span style={{ fontSize: "var(--font-size-label)", color: "var(--text-tertiary)" }}>
            {items.length}
          </span>
        </div>
        <div style={scrollArea}>
          {items.map(item => {
            const active = item.id === current?.id
            return (
              <button
                key={item.id}
                type="button"
                data-slot="workbench-preview-row"
                data-id={item.id}
                data-kind={item.kind}
                data-active={active || undefined}
                onClick={() => open(item.id)}
                title={item.name}
                style={{
                  ...itemStyle,
                  background: active ? "var(--sidebar-item-active)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                <span style={{ ...mono, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.name}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    flex: "0 0 auto",
                    fontSize: "var(--font-size-label)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  {formatStamp(item.updatedAt)}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 右：预览主体 */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
        {current === null ? (
          <div style={stateFill}>
            <EmptyState
              icon={<MousePointerClick aria-hidden="true" />}
              title="选择一个产物以预览"
              description="左侧列表里的每一项都来自后端真实的媒体 / 文档记录；选中后这里按类型渲染。"
            />
          </div>
        ) : (
          <>
            <div data-slot="workbench-preview-view" style={{ display: "flex", flex: 1, minHeight: 0 }}>
              <PreviewBody item={current} />
            </div>
            <div style={footer}>
              <span style={{ ...mono, color: "var(--text-primary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {current.name}
              </span>
              <span style={{ marginLeft: "auto", fontSize: "var(--font-size-label)", color: "var(--text-tertiary)" }}>
                {current.mimeType === "" ? current.kind : current.mimeType}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
