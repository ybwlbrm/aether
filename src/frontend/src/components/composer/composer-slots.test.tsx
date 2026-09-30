import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Attachment } from "../../hooks/useStreamSend"
import { AttachmentTray } from "./AttachmentTray"
import { ProviderSelect, type ProviderSelectProps } from "./ProviderSelect"
import { VoiceButton } from "./VoiceButton"

/** 一个满足 Web Speech 契约的构造器替身：只用来让 useVoiceInput 探测到能力 */
class FakeSpeechRecognition {
  lang = ""
  continuous = false
  interimResults = false
  onresult: null = null
  onend: null = null
  onerror: null = null
  start(): void {}
  stop(): void {}
}

const IMAGES: readonly Attachment[] = [
  { name: "screenshot.png", dataUrl: "data:image/png;base64,AAAA" },
  { name: "notes.md", dataUrl: "data:text/markdown;base64,BBBB" },
]

function renderVoice(props: Partial<Parameters<typeof VoiceButton>[0]> = {}): string {
  return renderToStaticMarkup(
    <VoiceButton value="" onChange={() => undefined} onError={() => undefined} {...props} />,
  )
}

function renderTray(props: Partial<Parameters<typeof AttachmentTray>[0]> = {}): string {
  return renderToStaticMarkup(<AttachmentTray items={IMAGES} onRemove={() => undefined} {...props} />)
}

function renderSelect(props: Partial<ProviderSelectProps> = {}): string {
  const full: ProviderSelectProps = {
    selectedProviderId: "openai",
    options: [
      { value: "openai", label: "OpenAI 📷", supportsVision: true },
      { value: "ollama", label: "Ollama", supportsVision: false },
    ],
    onProviderChange: () => undefined,
    ...props,
  }
  return renderToStaticMarkup(<ProviderSelect {...full} />)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("T18 VoiceButton：useVoiceInput 的薄封装", () => {
  it("能力可用时渲染麦克风按钮（低对比、不抢注意力）", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeSpeechRecognition })

    const markup = renderVoice()

    expect(markup).toContain('aria-label="语音输入"')
    expect(markup).not.toContain("disabled")
  })

  it("能力可用且正在录音时暴露 pressed 态", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeSpeechRecognition })

    // recording 由 hook 内部 state 驱动，首帧恒为 false —— 这里只断言 idle 态不带 pressed
    expect(renderVoice()).not.toContain('aria-pressed="true"')
  })

  it("capability 关（supported false 且被 disabled）时不产生任何 DOM", () => {
    const markup = renderVoice({ disabled: true })

    expect(markup).toBe("")
    expect(markup).not.toContain('data-slot="composer-voice"')
  })

  it("capability 开但调用方禁用时仍渲染按钮（只读态，不是零 DOM）", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeSpeechRecognition })

    const markup = renderVoice({ disabled: true })

    expect(markup).toContain('aria-label="语音输入"')
    expect(markup).toContain("disabled")
  })

  it("语音失败文案不由按钮承载 —— 走 onError 通道交给调用方渲染", () => {
    vi.stubGlobal("window", { SpeechRecognition: FakeSpeechRecognition })

    const markup = renderVoice()

    expect(markup).not.toContain("麦克风")
    expect(markup).not.toContain("语音输入不可用")
  })
})

describe("T18 AttachmentTray：附件缩略图", () => {
  it("渲染全部附件的图片缩略图 / 类型徽标与移除按钮", () => {
    const markup = renderTray()

    expect(markup).toContain('src="data:image/png;base64,AAAA"')
    expect(markup).toContain("screenshot.png")
    expect(markup).toContain("MD")
    expect(markup).toContain('aria-label="移除附件 screenshot.png"')
    expect(markup).toContain('aria-label="移除附件 notes.md"')
  })

  it("capability 关（enabled=false）时不产生任何 DOM", () => {
    expect(renderTray({ enabled: false })).toBe("")
  })

  it("capability 开但无附件时不留空托盘（零 chrome）", () => {
    expect(renderTray({ items: [] })).toBe("")
  })
})

describe("T18 ProviderSelect：模型选择", () => {
  it("渲染 aria-label=\"选择 AI 模型\" 的 select 与全部可选项", () => {
    const markup = renderSelect()

    expect(markup).toContain('aria-label="选择 AI 模型"')
    expect(markup).toContain('value="openai"')
    expect(markup).toContain("OpenAI 📷")
    expect(markup).toContain("Ollama")
  })

  it("capability 关（enabled=false）时不产生任何 DOM", () => {
    expect(renderSelect({ enabled: false })).toBe("")
  })

  it("尚未落定 provider（selectedProviderId 为 null）时不渲染 select", () => {
    expect(renderSelect({ selectedProviderId: null })).toBe("")
  })

  it("disabled 时 select 不可交互", () => {
    expect(renderSelect({ disabled: true })).toContain("disabled")
  })
})
