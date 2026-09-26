import { describe, expect, it } from "vitest"

import { extractImageSources, stripImageMarkdown } from "./message-bubble"

describe("conversation message bubble image helpers", () => {
  it("extracts inline image sources from both data URLs and server chat image paths", () => {
    const content = [
      "看看这两张图",
      "![image](/data/chat-images/alpha.png)",
      "![image](data:image/png;base64,QUJD)",
    ].join("\n\n")

    expect(extractImageSources(content)).toEqual([
      "/data/chat-images/alpha.png",
      "data:image/png;base64,QUJD",
    ])
  })

  it("returns no sources for plain text and non-image markdown links", () => {
    expect(extractImageSources("普通文本 + [文档](https://example.com/a.pdf)")).toEqual([])
  })

  it("strips image markdown so the bubble body renders only the prose", () => {
    const content = "描述如下\n\n![image](/data/chat-images/alpha.png)"

    expect(stripImageMarkdown(content)).toBe("描述如下")
  })
})
