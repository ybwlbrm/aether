import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { RUN_STATUSES } from "@pacc/shared"

import {
  STATUS_PILL_STATUSES,
  STATUS_PILL_TONE_BY_STATUS,
  StatusPill,
} from "./status-pill"

describe("StatusPill", () => {
  it("maps every supported status to a semantic tone", () => {
    expect(STATUS_PILL_TONE_BY_STATUS).toEqual({
      created: "neutral",
      running: "info",
      waiting: "info",
      retry_waiting: "warning",
      retrying: "warning",
      verifying: "accent",
      completed: "success",
      failed: "danger",
      cancelled: "neutral",
      interrupted: "warning",
      budget_exceeded: "danger",
    })

    for (const status of STATUS_PILL_STATUSES) {
      const markup = renderToStaticMarkup(<StatusPill status={status} />)
      expect(markup).toContain(`data-status="${status}"`)
      expect(markup).toContain(`data-tone="${STATUS_PILL_TONE_BY_STATUS[status]}"`)
    }
  })

  it("covers every canonical run status (AEX-P0-002: no locally redefined subset)", () => {
    expect([...STATUS_PILL_STATUSES].sort()).toEqual([...RUN_STATUSES].sort())
  })
})
