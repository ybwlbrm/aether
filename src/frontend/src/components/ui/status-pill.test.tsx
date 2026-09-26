import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  STATUS_PILL_STATUSES,
  STATUS_PILL_TONE_BY_STATUS,
  StatusPill,
} from "./status-pill"

describe("StatusPill", () => {
  it("maps every supported status to a semantic tone", () => {
    expect(STATUS_PILL_TONE_BY_STATUS).toEqual({
      completed: "success",
      failed: "danger",
      running: "info",
      retrying: "warning",
      verifying: "accent",
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
})
