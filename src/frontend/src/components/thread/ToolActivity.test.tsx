import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { AgentEventEnvelope } from "@pacc/shared"
import { hasFullToolPayload, projectToolActivity, type ToolActivityEntry } from "../../store/projections"
import { ToolActivity, formatToolDuration, type ToolActivityItem } from "./ToolActivity"

function envelope(partial: Partial<AgentEventEnvelope> & { eventType: string }): AgentEventEnvelope {
  return {
    eventId: `e-${partial.seq ?? 0}`,
    sessionId: "s-1",
    taskId: "t-1",
    agentId: "main",
    agentType: "conversation",
    timestamp: "2026-08-24T00:00:00Z",
    seq: partial.seq ?? 0,
    ...partial,
  } as AgentEventEnvelope
}

/** 完整工具事件链：tool.started → tool.completed（带 inputDetail / outputDetail） */
const FULL_TOOL_CHAIN: readonly AgentEventEnvelope[] = [
  envelope({
    eventType: "tool.started",
    seq: 1,
    eventId: "tool-1",
    timestamp: "2026-08-24T00:00:01Z",
    tool: {
      toolName: "read_file",
      toolInput: "src/alpha.ts",
      inputDetail: { path: "src/alpha.ts", encoding: "utf-8" },
    },
  }),
  envelope({
    eventType: "tool.completed",
    seq: 2,
    eventId: "tool-2",
    parentEventId: "tool-1",
    timestamp: "2026-08-24T00:00:03Z",
    tool: {
      toolName: "read_file",
      toolInput: "src/alpha.ts",
      toolOutput: "ok",
      outputDetail: { bytes: 2048, lines: 61 },
    },
  }),
]

/** packed 回放形态：后端只回放 payload.content，tool 载荷全丢 */
const PACKED_TOOL_CHAIN: readonly AgentEventEnvelope[] = [
  envelope({ eventType: "tool.started", seq: 1, eventId: "p1", content: "read_file src/alpha.ts" }),
  envelope({ eventType: "tool.completed", seq: 2, eventId: "p2", parentEventId: "p1", content: "ok" }),
]

function firstEntry(events: readonly AgentEventEnvelope[]): ToolActivityEntry {
  const entries = projectToolActivity([...events])
  const entry = entries[0]
  if (entry === undefined) throw new Error("fixture 未投影出工具活动条目")
  return entry
}

/** 锚点帧（tool.started）的 inputDetail */
function inputDetailOf(events: readonly AgentEventEnvelope[]): unknown {
  return events[0]?.tool?.inputDetail
}

/** 末帧（tool.completed/error）的 outputDetail */
function outputDetailOf(events: readonly AgentEventEnvelope[]): unknown {
  return events[events.length - 1]?.tool?.outputDetail
}

function itemOf(
  events: readonly AgentEventEnvelope[],
  overrides: Partial<ToolActivityItem> = {},
): ToolActivityItem {
  return {
    entry: firstEntry(events),
    inputDetail: inputDetailOf(events),
    outputDetail: outputDetailOf(events),
    hasFullToolPayload: hasFullToolPayload([...events]),
    defaultExpanded: false,
    ...overrides,
  }
}

function render(item: ToolActivityItem): string {
  const { entry, ...rest } = item
  return renderToStaticMarkup(<ToolActivity entry={entry} {...rest} />)
}

describe("ToolActivity：折叠一行 / 展开 JSON（defaultExpanded 是 prop 不是 state）", () => {
  it("折叠态是一行：label + target + duration + 状态点，不含 outputDetail", () => {
    const markup = render(itemOf(FULL_TOOL_CHAIN))

    expect(markup).toContain('data-slot="thread-tool-activity"')
    expect(markup).toContain('data-status="completed"')
    expect(markup).toContain("Read")
    expect(markup).toContain("src/alpha.ts")
    expect(markup).toContain("2.0s")
    expect(markup).toContain('aria-expanded="false"')
    // 折叠态绝不把完整载荷写进 markup
    expect(markup).not.toContain("outputDetail")
    expect(markup).not.toContain("&quot;bytes&quot;: 2048")
    expect(markup).not.toContain('data-slot="thread-tool-detail"')
  })

  it("展开态渲染 inputDetail / outputDetail 的 JSON", () => {
    const markup = render(itemOf(FULL_TOOL_CHAIN, { defaultExpanded: true }))

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('data-slot="thread-tool-detail"')
    expect(markup).toContain("outputDetail")
    expect(markup).toContain("&quot;bytes&quot;: 2048")
    expect(markup).toContain("inputDetail")
    expect(markup).toContain("&quot;encoding&quot;: &quot;utf-8&quot;")
  })

  it("hasFullToolPayload 为 false（packed 回放）时渲染显式降级提示，绝不伪造完整文件", () => {
    expect(hasFullToolPayload([...PACKED_TOOL_CHAIN])).toBe(false)
    const item = itemOf(PACKED_TOOL_CHAIN, { defaultExpanded: true })
    const markup = render(item)

    expect(markup).toContain('data-slot="thread-tool-detail-unavailable"')
    expect(markup).toContain("detail unavailable after replay")
    expect(markup).not.toContain("outputDetail")
    expect(markup).not.toContain("inputDetail")
  })

  it("toolName / target 缺失时用诚实占位，不留空白行", () => {
    const entry: ToolActivityEntry = {
      eventId: "e-x",
      toolName: "mcp.unknown_probe",
      label: "MCP",
      kind: "other",
      target: "",
      status: "running",
      startedAt: "2026-08-24T00:00:01Z",
      hasDetail: false,
    }
    const markup = renderToStaticMarkup(
      <ToolActivity entry={entry} hasFullToolPayload={false} defaultExpanded={false} />,
    )

    expect(markup).toContain("MCP")
    expect(markup).toContain('data-status="running"')
    expect(markup).toContain("未知目标")
  })

  it("进行中（无 endedAt）不编造时长", () => {
    const running = firstEntry([
      envelope({
        eventType: "tool.started",
        seq: 1,
        eventId: "tool-1",
        timestamp: "2026-08-24T00:00:01Z",
        tool: { toolName: "grep", toolInput: "TODO" },
      }),
    ])
    const markup = renderToStaticMarkup(
      <ToolActivity entry={running} hasFullToolPayload defaultExpanded={false} />,
    )

    expect(markup).toContain('data-status="running"')
    expect(markup).not.toContain("NaN")
    expect(markup).not.toContain("0.0s")
  })

  it("toggle 意图经 onToggle 冒泡（展开状态由外部持有）", () => {
    let toggles = 0
    const markup = renderToStaticMarkup(
      <ToolActivity
        entry={firstEntry(FULL_TOOL_CHAIN)}
        inputDetail={inputDetailOf(FULL_TOOL_CHAIN)}
        outputDetail={outputDetailOf(FULL_TOOL_CHAIN)}
        hasFullToolPayload
        defaultExpanded={false}
        onToggle={() => { toggles += 1 }}
      />,
    )

    expect(markup).toContain('aria-expanded="false"')
    expect(toggles).toBe(0)
  })
})

describe("formatToolDuration", () => {
  it("按毫秒差格式化到 0.1s 精度", () => {
    expect(formatToolDuration("2026-08-24T00:00:00Z", "2026-08-24T00:00:00.5Z")).toBe("0.5s")
    expect(formatToolDuration("2026-08-24T00:00:00Z", "2026-08-24T00:01:03Z")).toBe("63.0s")
  })

  it("时间戳不可解析时返回 null（调用方不得显示假时长）", () => {
    expect(formatToolDuration("not-a-date", "2026-08-24T00:00:00Z")).toBeNull()
  })
})
