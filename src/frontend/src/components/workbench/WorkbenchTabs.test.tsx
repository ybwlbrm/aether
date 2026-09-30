/**
 * T22 Workbench 五个 tab 的渲染契约（TDD：先 RED）。
 *
 * 五个 tab 全部是**纯展示组件**：数据经 props 传入，组件内零 hook、零 effect。
 * 因此本文件可以直接用 `renderToStaticMarkup` 驱动**每一个状态分支**
 * （empty / error / loading / truncated / 有数据），不需要 jsdom、不需要
 * testing-library、不需要 mock 模块。
 *
 * 覆盖重点是**最常被跳过的两个态**：empty 与 error —— 二者都必须给出
 * 「真实解释」（为什么空、怎么才会变有），而不是占位符或空白面板。
 *
 * allow: SIZE_OK — 这是 5 个面板的渲染契约合集（36 例）。按面板拆成 5 个文件会让
 * 同一套类型精确的夹具被复制 5 份，而拆出共享夹具文件又会把「2 个 *.test.tsx」的
 * 交付形态变成 3 个。集中一处反而让「五个 tab 的共同不变量」那组断言成立。
 */
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  MISSING_CONTENT_NOTICE,
  REPLAY_TRUNCATION_NOTICE,
  type PreviewItem,
  type TerminalLine,
  type UseWorkbenchBrowserResult,
  type UseWorkbenchCodeResult,
  type UseWorkbenchFilesResult,
  type UseWorkbenchPreviewResult,
  type UseWorkbenchTerminalResult,
  type WorkbenchCodeFile,
  type WorkbenchFileRow,
} from "../../hooks/workbench"
import { BrowserTab } from "./tabs/BrowserTab"
import { CodeTab } from "./tabs/CodeTab"
import { FilesTab } from "./tabs/FilesTab"
import { PreviewTab } from "./tabs/PreviewTab"
import { TerminalTab } from "./tabs/TerminalTab"

/** 交互回调在静态渲染里永不被调用。 */
const NOOP = (): void => undefined

/* ============================================================
   取 markup 的小工具（比整串 contains 更精确）
   ============================================================ */

/** 取出带指定 data-slot 的那个元素自身的开标签（含全部属性）。 */
function openTag(markup: string, slot: string): string {
  const at = markup.indexOf(`data-slot="${slot}"`)
  expect(at, `slot ${slot} 未渲染`).toBeGreaterThanOrEqual(0)
  const start = markup.lastIndexOf("<", at)
  const end = markup.indexOf(">", at)
  return markup.slice(start, end + 1)
}

/** 某个 data-slot 出现的次数。 */
function countSlots(markup: string, slot: string): number {
  return markup.split(`data-slot="${slot}"`).length - 1
}

/* ============================================================
   夹具（每个工厂产出一个完整、类型精确的 hook 结果形状）
   ============================================================ */

function browser(overrides: Partial<UseWorkbenchBrowserResult> = {}): UseWorkbenchBrowserResult {
  return {
    url: "",
    iframeSrc: null,
    blocked: false,
    canGoBack: false,
    canGoForward: false,
    setUrl: NOOP,
    back: NOOP,
    forward: NOOP,
    reload: NOOP,
    ...overrides,
  }
}

function codeFile(overrides: Partial<WorkbenchCodeFile> = {}): WorkbenchCodeFile {
  return {
    path: "src/app.ts",
    name: "app.ts",
    op: "read",
    at: "2026-01-01T00:00:00.000Z",
    content: "export const v = 1;",
    truncated: false,
    sourceTruncated: false,
    ...overrides,
  }
}

function codeEmpty(): UseWorkbenchCodeResult {
  return { files: [], currentFile: null, selectFile: NOOP, truncated: false, rawContent: "" }
}

function codeWith(files: readonly WorkbenchCodeFile[]): UseWorkbenchCodeResult {
  const currentFile = files.find(file => file.path === files[0]?.path) ?? null
  return {
    files,
    currentFile,
    selectFile: NOOP,
    truncated: currentFile?.truncated ?? false,
    rawContent: currentFile?.content ?? "",
  }
}

function fileRow(overrides: Partial<WorkbenchFileRow> = {}): WorkbenchFileRow {
  return {
    path: "src/app.ts",
    name: "app.ts",
    source: "tool",
    kind: "read",
    updatedAt: "2026-01-01T00:00:00.000Z",
    truncated: false,
    ...overrides,
  }
}

function files(overrides: Partial<UseWorkbenchFilesResult> = {}): UseWorkbenchFilesResult {
  return { files: [], refresh: NOOP, loading: false, error: null, ...overrides }
}

function terminalLine(overrides: Partial<TerminalLine> = {}): TerminalLine {
  return {
    key: "cmd-1",
    command: "pnpm test",
    output: "PASS 62 tests",
    success: true,
    timestamp: "14:02:11",
    duration: 812,
    source: "terminal",
    ...overrides,
  }
}

function terminal(overrides: Partial<UseWorkbenchTerminalResult> = {}): UseWorkbenchTerminalResult {
  return {
    history: [],
    execute: async () => undefined,
    running: false,
    error: null,
    clear: NOOP,
    ...overrides,
  }
}

function previewItem(overrides: Partial<PreviewItem> = {}): PreviewItem {
  return {
    id: "asset-1",
    kind: "image",
    name: "shot.png",
    url: "/api/media/file/shot.png",
    updatedAt: "2026-01-01T00:00:00.000Z",
    size: 2048,
    mimeType: "image/png",
    ...overrides,
  }
}

function preview(overrides: Partial<UseWorkbenchPreviewResult> = {}): UseWorkbenchPreviewResult {
  return { items: [], open: NOOP, current: null, loading: false, error: null, ...overrides }
}

/* ============================================================
   BrowserTab
   ============================================================ */

describe("BrowserTab：真实 iframe + 地址栏导航", () => {
  it("空态：没有地址时不渲染 iframe，给出可执行说明而不是占位符", () => {
    const markup = renderToStaticMarkup(<BrowserTab {...browser()} />)

    expect(markup).toContain('data-slot="workbench-browser"')
    expect(markup).not.toContain("<iframe")
    expect(markup).toContain('data-slot="empty-state"')
    expect(markup).toContain("尚未载入页面")
  })

  it("空态文案说明「怎么才会变有」，且不含任何预置示例站点", () => {
    const markup = renderToStaticMarkup(<BrowserTab {...browser()} />)

    expect(markup).toContain("地址栏")
    expect(markup).not.toContain("example.com")
    expect(markup).not.toContain("Browser workspace placeholder")
  })

  it("非 URL-like 输入：按搜索词提示，绝不放进 iframe", () => {
    const markup = renderToStaticMarkup(
      <BrowserTab {...browser({ url: "how to fix the build", blocked: true })} />,
    )

    expect(markup).not.toContain("<iframe")
    expect(markup).toContain('data-state="search-hint"')
    expect(markup).toContain("搜索")
  })

  it("error 态：可执行协议被拒时根节点标记 blocked，且绝不成为 iframe 的 src", () => {
    const markup = renderToStaticMarkup(
      <BrowserTab {...browser({ url: "javascript:alert(1)", blocked: true })} />,
    )

    expect(markup).toContain('data-blocked="true"')
    expect(markup).not.toContain("<iframe")
    expect(markup).not.toContain('src="javascript:')
    // 被拒的原文只作为提示回显给用户本人，不参与任何取址
    expect(markup).toContain("不是可载入的地址")
  })

  it("有地址：渲染真实 iframe，src 取自 hook 的规范化结果", () => {
    const markup = renderToStaticMarkup(
      <BrowserTab {...browser({ url: "localhost:5173", iframeSrc: "http://localhost:5173/" })} />,
    )

    expect(markup).toContain('data-slot="workbench-browser-viewport"')
    expect(markup).toContain('src="http://localhost:5173/"')
    expect(markup).toContain('data-state="ready"')
  })

  it("导航按钮的可用态跟随 canGoBack / canGoForward", () => {
    // 栈里只有当前位置：后退不可用、前进不可用
    const root = renderToStaticMarkup(<BrowserTab {...browser()} />)
    expect(openTag(root, "workbench-browser-back")).toContain("disabled")
    expect(openTag(root, "workbench-browser-forward")).toContain("disabled")

    // 有前进目标：后退仍不可用，前进可用
    const forward = renderToStaticMarkup(<BrowserTab {...browser({ canGoForward: true })} />)
    expect(openTag(forward, "workbench-browser-back")).toContain("disabled")
    expect(openTag(forward, "workbench-browser-forward")).not.toContain("disabled")

    // 有后退目标：后退可用
    const back = renderToStaticMarkup(<BrowserTab {...browser({ canGoBack: true })} />)
    expect(openTag(back, "workbench-browser-back")).not.toContain("disabled")
  })
})

/* ============================================================
   CodeTab
   ============================================================ */

describe("CodeTab：文件树 + 两条载荷路径", () => {
  it("empty 态：说明「没有活动 run」这一真实原因", () => {
    const markup = renderToStaticMarkup(<CodeTab {...codeEmpty()} />)

    expect(markup).toContain('data-slot="workbench-code"')
    expect(markup).toContain('data-slot="empty-state"')
    expect(markup).toContain("No run selected")
    expect(markup).toContain("Agent")
  })

  it("有文件：渲染树 + 完整内容，不出现降级提示", () => {
    const markup = renderToStaticMarkup(<CodeTab {...codeWith([codeFile()])} />)

    expect(markup).toContain("src/app.ts")
    expect(markup).toContain("export const v = 1;")
    expect(markup).not.toContain('data-slot="workbench-code-truncated"')
  })

  it("packed-replay：按载荷完整性分支渲染 truncated after replay 诚实提示", () => {
    const truncated = codeFile({
      content: `200 字摘要\n\n${REPLAY_TRUNCATION_NOTICE}`,
      truncated: true,
    })
    const markup = renderToStaticMarkup(<CodeTab {...codeWith([truncated])} />)

    expect(markup).toContain('data-slot="workbench-code-truncated"')
    expect(markup).toContain("truncated after replay")
    expect(markup).toContain(REPLAY_TRUNCATION_NOTICE)
  })

  it("载荷里没有内容时透出诚实缺失提示，不伪造代码", () => {
    const markup = renderToStaticMarkup(
      <CodeTab {...codeWith([codeFile({ content: MISSING_CONTENT_NOTICE, truncated: true })])} />,
    )

    expect(markup).toContain(MISSING_CONTENT_NOTICE)
    expect(markup).toContain('data-slot="workbench-code-truncated"')
  })

  it("树里每一行都带 data-path（selectFile 的真实目标）", () => {
    const markup = renderToStaticMarkup(
      <CodeTab
        {...codeWith([codeFile({ path: "src/a.ts", name: "a.ts" }), codeFile({ path: "src/b.ts", name: "b.ts" })])}
      />,
    )

    expect(countSlots(markup, "workbench-code-row")).toBe(2)
    expect(markup).toContain('data-path="src/a.ts"')
    expect(markup).toContain('data-path="src/b.ts"')
  })

  it("摘要被裁剪的行（sourceTruncated）单独标记", () => {
    const markup = renderToStaticMarkup(
      <CodeTab {...codeWith([codeFile({ sourceTruncated: true })])} />,
    )

    expect(markup).toContain('data-source-truncated="true"')
  })
})

/* ============================================================
   FilesTab
   ============================================================ */

describe("FilesTab：loading / error / empty / 列表", () => {
  it("loading 态：用 ui/loading-state 而不是自造 spinner", () => {
    const markup = renderToStaticMarkup(<FilesTab {...files({ loading: true })} />)

    expect(markup).toContain('data-slot="workbench-files"')
    expect(markup).toContain('data-slot="loading-state"')
    expect(markup).not.toContain('data-slot="empty-state"')
  })

  it("error 态：无数据时整面板 ErrorState，并透出后端原文", () => {
    const markup = renderToStaticMarkup(
      <FilesTab {...files({ error: "connect ECONNREFUSED 127.0.0.1:3000" })} />,
    )

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("connect ECONNREFUSED 127.0.0.1:3000")
    expect(markup).not.toContain('data-slot="empty-state"')
  })

  it("empty 态：说明「运行 Agent 任务会产生」而不是留空", () => {
    const markup = renderToStaticMarkup(<FilesTab {...files()} />)

    expect(markup).toContain('data-slot="empty-state"')
    expect(markup).toContain("没有文件")
    expect(markup).toContain("Agent")
  })

  it("error + 有数据：保留真实行并附带错误提示，绝不因一侧失败丢掉另一侧", () => {
    const markup = renderToStaticMarkup(
      <FilesTab {...files({ files: [fileRow()], error: "documents 500" })} />,
    )

    expect(countSlots(markup, "workbench-files-row")).toBe(1)
    expect(markup).toContain('data-slot="workbench-files-error"')
    expect(markup).toContain("documents 500")
  })

  it("有数据：渲染名称 / 类型 / 来源 / 时间四列", () => {
    const markup = renderToStaticMarkup(
      <FilesTab
        {...files({
          files: [
            fileRow({ path: "src/app.ts", name: "app.ts", kind: "write", source: "tool" }),
            fileRow({ path: "deck.pptx", name: "deck.pptx", kind: "ppt", source: "document" }),
          ],
        })}
      />,
    )

    expect(countSlots(markup, "workbench-files-row")).toBe(2)
    expect(markup).toContain("Name")
    expect(markup).toContain("Source")
    expect(markup).toContain("deck.pptx")
    expect(markup).toContain("2026-01-01 00:00")
  })

  it("未接 onOpenFile 时行不可点（不给假 affordance）", () => {
    const markup = renderToStaticMarkup(<FilesTab {...files({ files: [fileRow()] })} />)

    expect(countSlots(markup, "workbench-files-row")).toBe(1)
    expect(markup).not.toContain('data-openable="true"')
  })

  it("接了 onOpenFile 时行才是按钮，回调路径写在 data-path 上", () => {
    const markup = renderToStaticMarkup(
      <FilesTab {...files({ files: [fileRow({ path: "src/app.ts" })] })} onOpenFile={NOOP} />,
    )

    expect(openTag(markup, "workbench-files-row")).toContain("<button")
    expect(openTag(markup, "workbench-files-row")).toContain('data-path="src/app.ts"')
    expect(openTag(markup, "workbench-files-row")).toContain('data-openable="true"')
  })
})

/* ============================================================
   TerminalTab
   ============================================================ */

describe("TerminalTab：命令历史 + 执行输入", () => {
  it("empty 态：说明历史来自后端共享记录，而不是画假终端", () => {
    const markup = renderToStaticMarkup(<TerminalTab {...terminal()} />)

    expect(markup).toContain('data-slot="workbench-terminal"')
    expect(markup).toContain('data-slot="empty-state"')
    expect(markup).toContain("还没有命令记录")
    expect(markup).not.toContain("vite v6.0.0")
  })

  it("error 态：透出后端原文并保留执行入口", () => {
    const markup = renderToStaticMarkup(<TerminalTab {...terminal({ error: "命令白名单拒绝" })} />)

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("命令白名单拒绝")
    expect(markup).toContain('data-slot="workbench-terminal-form"')
  })

  it("有历史：渲染命令 / 输出 / 成功标记 / 时间", () => {
    const markup = renderToStaticMarkup(
      <TerminalTab {...terminal({ history: [terminalLine()] })} />,
    )

    expect(markup).toContain("pnpm test")
    expect(markup).toContain("PASS 62 tests")
    expect(markup).toContain('data-success="true"')
    expect(markup).toContain("14:02:11")
  })

  it("失败行按前缀推断结果标记，绝不一律当成功", () => {
    const markup = renderToStaticMarkup(
      <TerminalTab
        {...terminal({
          history: [terminalLine({ command: "rm -rf /", output: "权限不足: 已拒绝", success: false })],
        })}
      />,
    )

    expect(markup).toContain('data-success="false"')
    expect(markup).toContain("权限不足: 已拒绝")
  })

  it("本地回显（duration 为 null）不编造时长", () => {
    const markup = renderToStaticMarkup(
      <TerminalTab {...terminal({ history: [terminalLine({ key: "local-1", duration: null })] })} />,
    )

    expect(markup).toContain("本地回显")
    expect(markup).not.toContain("NaN")
  })

  it("running 态：执行中给出 ui/loading-state 并禁用重复提交", () => {
    const markup = renderToStaticMarkup(<TerminalTab {...terminal({ running: true })} />)

    expect(markup).toContain('data-slot="loading-state"')
    expect(openTag(markup, "workbench-terminal-submit")).toContain("disabled")
  })
})

/* ============================================================
   PreviewTab
   ============================================================ */

describe("PreviewTab：产物列表 + 选择预览", () => {
  it("loading 态：用 ui/loading-state", () => {
    const markup = renderToStaticMarkup(<PreviewTab {...preview({ loading: true })} />)

    expect(markup).toContain('data-slot="workbench-preview"')
    expect(markup).toContain('data-slot="loading-state"')
  })

  it("error 态：透出后端原文", () => {
    const markup = renderToStaticMarkup(<PreviewTab {...preview({ error: "media 503" })} />)

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("media 503")
  })

  it("empty 态：说明产物从哪来", () => {
    const markup = renderToStaticMarkup(<PreviewTab {...preview()} />)

    expect(markup).toContain('data-slot="empty-state"')
    expect(markup).toContain("还没有产物")
  })

  it("有列表但未选中：列出产物并提示选择，不空白", () => {
    const markup = renderToStaticMarkup(<PreviewTab {...preview({ items: [previewItem()] })} />)

    expect(markup).toContain("shot.png")
    expect(markup).toContain('data-slot="empty-state"')
  })

  it("image 产物：渲染真实 img，src 取自后端给的 url", () => {
    const markup = renderToStaticMarkup(
      <PreviewTab {...preview({ items: [previewItem()], current: previewItem() })} />,
    )

    expect(markup).toContain('data-slot="workbench-preview-view"')
    expect(markup).toContain('src="/api/media/file/shot.png"')
    expect(markup).toContain('alt="shot.png"')
  })

  it("video / audio 产物：渲染对应媒体元素", () => {
    const video = renderToStaticMarkup(
      <PreviewTab
        {...preview({
          current: previewItem({ id: "v", kind: "video", name: "clip.mp4", url: "/api/media/file/clip.mp4" }),
        })}
      />,
    )
    expect(video).toContain("<video")

    const audio = renderToStaticMarkup(
      <PreviewTab
        {...preview({
          current: previewItem({ id: "a", kind: "audio", name: "take.wav", url: "/api/media/file/take.wav" }),
        })}
      />,
    )
    expect(audio).toContain("<audio")
  })

  it("doc / ppt 产物：给 documentDownloadUrl 的打开入口", () => {
    const markup = renderToStaticMarkup(
      <PreviewTab
        {...preview({
          current: previewItem({
            id: "doc-7",
            kind: "doc",
            name: "report.docx",
            url: "/api/documents/doc-7/download",
          }),
        })}
      />,
    )

    expect(markup).toContain('href="/api/documents/doc-7/download"')
    expect(markup).toContain("report.docx")
  })

  it("媒体 url 为空串：诚实说明后端没给可加载文件，绝不替换成本地假地址", () => {
    const markup = renderToStaticMarkup(
      <PreviewTab {...preview({ current: previewItem({ url: "" }) })} />,
    )

    expect(markup).toContain("没有可加载的文件")
    expect(markup).not.toContain('src=""')
  })
})

/* ============================================================
   跨 tab 的共同不变量
   ============================================================ */

describe("五个 tab 的共同不变量", () => {
  const EMPTY_RENDERS: ReadonlyArray<readonly [string, string]> = [
    ["workbench-browser", renderToStaticMarkup(<BrowserTab {...browser()} />)],
    ["workbench-code", renderToStaticMarkup(<CodeTab {...codeEmpty()} />)],
    ["workbench-files", renderToStaticMarkup(<FilesTab {...files()} />)],
    ["workbench-terminal", renderToStaticMarkup(<TerminalTab {...terminal()} />)],
    ["workbench-preview", renderToStaticMarkup(<PreviewTab {...preview()} />)],
  ]

  it("每个 tab 空态都渲染 data-slot（外部选择器依赖）且给出 empty-state 文案", () => {
    for (const [slot, markup] of EMPTY_RENDERS) {
      expect(markup).toContain(`data-slot="${slot}"`)
      expect(markup).toContain('data-slot="empty-state"')
    }
  })

  it("空态都不抛错、不留空白面板（没有 undefined / NaN / [object Object]）", () => {
    for (const [, markup] of EMPTY_RENDERS) {
      expect(markup).not.toContain("undefined")
      expect(markup).not.toContain("NaN")
      expect(markup).not.toContain("[object Object]")
    }
  })

  it("D4：零内部状态 —— 同一组 props 渲染两次输出完全一致", () => {
    const props = files({ files: [fileRow()], loading: false })
    expect(renderToStaticMarkup(<FilesTab {...props} />)).toBe(
      renderToStaticMarkup(<FilesTab {...props} />),
    )

    const code = codeWith([codeFile()])
    expect(renderToStaticMarkup(<CodeTab {...code} />)).toBe(
      renderToStaticMarkup(<CodeTab {...code} />),
    )
  })
})
