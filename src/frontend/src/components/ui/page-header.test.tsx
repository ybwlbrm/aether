import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PageHeader } from "./page-header"

describe("PageHeader", () => {
  it("renders title, description, and actions in the shared structure", () => {
    const markup = renderToStaticMarkup(
      <PageHeader
        title="Aether"
        description="Command center"
        actions={<button type="button">Refresh</button>}
      />,
    )

    expect(markup).toContain('data-slot="page-header"')
    expect(markup).toContain('data-slot="page-header-title"')
    expect(markup).toContain("Aether")
    expect(markup).toContain('data-slot="page-header-description"')
    expect(markup).toContain("Command center")
    expect(markup).toContain('data-slot="page-header-actions"')
    expect(markup).toContain("Refresh")
  })
})
