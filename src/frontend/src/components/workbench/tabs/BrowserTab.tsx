/**
 * T22 `BrowserTab` —— 真实 iframe + 地址栏导航。
 *
 * ## 纯展示（D4）
 * 数据全部来自 `useWorkbenchBrowser` 的结果、经 props 传入；本文件零 hook、零 effect、
 * 零内部状态。因此 empty / search-hint / ready 三个分支都能用 `renderToStaticMarkup`
 * 直接断言，不需要 jsdom。
 *
 * ## 安全不变量
 * iframe 的 `src` 只可能是 props 的 `iframeSrc` —— 它由 T4 `normalizeUrl` 产生，
 * 只放行 http/https。**本组件不做任何协议判定**：`isUrlLike` 仅用于在两个空态之间
 * 选一句提示，不参与放行决策，因此可执行协议到不了 `src`。
 *
 * ## 沙箱
 * iframe 不给 `allow-same-origin`：目标站点拿到的是不透明源，读不到本应用的
 * cookie / localStorage，也改写不了父页面。
 */
import { ArrowLeft, ArrowRight, Globe, RefreshCw, Search } from "lucide-react"
import type { ReactElement } from "react"

import type { UseWorkbenchBrowserResult } from "../../../hooks/workbench"
import { isUrlLike } from "../../../lib/url"
import { EmptyState } from "../../ui/empty-state"
import { disabled, iconButton, input, panelRoot, stateFill, toolbar } from "../shared"

export type BrowserTabProps = UseWorkbenchBrowserResult

/** 三个呈现态：空地址 / 这是搜索词 / 已载入。 */
type BrowserState = "empty" | "search-hint" | "ready"

/** 协议边界：两种空态都要让用户知道线画在哪。 */
const PROTOCOL_RULE = "Browser 只放行 http/https —— javascript: / data: / file: 一律拒绝。"

export function BrowserTab({
  url,
  iframeSrc,
  blocked,
  canGoBack,
  canGoForward,
  setUrl,
  back,
  forward,
  reload,
}: BrowserTabProps): ReactElement {
  const draft = url.trim()
  // 非 URL-like 的非空输入 = 搜索词。判定只用于**选哪句提示**；
  // 放行与否早已由 normalizeUrl 在 hook 里做完。
  const state: BrowserState =
    iframeSrc !== null ? "ready" : draft !== "" && !isUrlLike(draft) ? "search-hint" : "empty"

  const backStyle = canGoBack ? iconButton : { ...iconButton, ...disabled }
  const forwardStyle = canGoForward ? iconButton : { ...iconButton, ...disabled }

  return (
    <div
      data-slot="workbench-browser"
      data-state={state}
      data-blocked={blocked || undefined}
      style={panelRoot}
    >
      {/* 地址栏 + 导航。输入受控于 hook 的草稿：地址一旦成为合法 http(s) 就立即导航。 */}
      <div style={toolbar}>
        <button
          type="button"
          data-slot="workbench-browser-back"
          onClick={back}
          disabled={!canGoBack}
          title="后退"
          aria-label="后退"
          style={backStyle}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-slot="workbench-browser-forward"
          onClick={forward}
          disabled={!canGoForward}
          title="前进"
          aria-label="前进"
          style={forwardStyle}
        >
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <input
          value={url}
          onChange={event => setUrl(event.target.value)}
          placeholder="输入网址或搜索词…"
          aria-label="Browser address"
          style={input}
        />
        <button type="button" onClick={reload} title="刷新" aria-label="刷新" style={iconButton}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {/* 视口：有安全 href 才是 iframe，否则给诚实提示 */}
      {state === "ready" && iframeSrc !== null ? (
        <iframe
          data-slot="workbench-browser-viewport"
          src={iframeSrc}
          title="Browser viewport"
          sandbox="allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          style={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            border: "none",
            background: "var(--surface-elevated)",
          }}
        />
      ) : (
        <div style={stateFill}>
          {state === "search-hint" ? (
            <EmptyState
              icon={<Search aria-hidden="true" />}
              title="这是搜索词，不是网址"
              description={`「${draft}」不是可载入的地址。${PROTOCOL_RULE} 需要联网检索时请用 Agent 的搜索工具。`}
            />
          ) : (
            <EmptyState
              icon={<Globe aria-hidden="true" />}
              title="尚未载入页面"
              description={`在上方地址栏输入网址即可载入。${PROTOCOL_RULE}`}
            />
          )}
        </div>
      )}
    </div>
  )
}
