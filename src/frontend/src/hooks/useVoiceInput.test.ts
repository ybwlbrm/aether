import { describe, expect, it, vi } from "vitest"

import {
  appendTranscript,
  buildSttRequestBody,
  isVoiceInputSupported,
  mergeSpeechTranscript,
  VOICE_MIC_DENIED_MESSAGE,
  VOICE_UNSUPPORTED_MESSAGE,
  type SpeechEventLike,
  type SpeechResultLike,
} from "./useVoiceInput"

function result(isFinal: boolean, transcript: string): SpeechResultLike {
  return { isFinal, 0: { transcript } } as SpeechResultLike
}

function speechEvent(from: number, ...results: readonly SpeechResultLike[]): SpeechEventLike {
  return { resultIndex: from, results }
}

/** node 测试环境无 window / navigator.mediaDevices，两条路径都不可用 */
function withoutVoiceApis(): void {
  vi.stubGlobal("window", {})
  vi.stubGlobal("navigator", {})
}

describe("useVoiceInput 的识别文本合并", () => {
  it("把已确认片段与中间结果按顺序拼成输入框显示文本", () => {
    // Given: 一次结果事件里先一段已确认、后一段中间结果
    const event = speechEvent(0, result(true, "帮我写"), result(false, "一个函数"))

    // When
    const display = mergeSpeechTranscript(event, "")

    // Then: 已确认在前、中间结果在后，且去掉首尾空白
    expect(display).toBe("帮我写一个函数")
  })

  it("保留上一次已确认的文本并只追加本次新增的确认段", () => {
    // Given: 上一次已确认「部署预发」，本次事件从 resultIndex 1 开始（前一段是同一段历史的旧副本）
    const event = speechEvent(1, result(true, "部署预发"), result(true, "环境"), result(false, "谢谢"))

    // When
    const display = mergeSpeechTranscript(event, "部署预发")

    // Then
    expect(display).toBe("部署预发环境谢谢")
  })

  it("忽略 resultIndex 之前的历史结果（不重复累加已固化文本）", () => {
    // Given: 结果数组里 0/1 是同一段历史文本的旧副本，事件只从 2 开始
    const event = speechEvent(2, result(true, "历史"), result(true, "历史"), result(true, "最新"))

    // When
    const display = mergeSpeechTranscript(event, "历史")

    // Then: 前两段被跳过，避免转写文本翻倍
    expect(display).toBe("历史最新")
  })

  it("空转写事件不会把输入框写成空串", () => {
    // Given: 结果既不确认也无中间文本
    const event = speechEvent(0, result(false, ""))

    // When
    const display = mergeSpeechTranscript(event, "")

    // Then: 返回空串，调用方据此跳过 onChange
    expect(display).toBe("")
  })
})

describe("useVoiceInput 的 STT 请求与文本合并", () => {
  it("把录音 dataURL 原样组装成 audio 字段", () => {
    // Given: FileReader 产出的 dataURL
    const dataUrl = "data:audio/webm;base64,QUJD"

    // When
    const body = buildSttRequestBody(dataUrl)

    // Then: 请求体恰好是 { audio }，不含其它字段
    expect(JSON.parse(body)).toEqual({ audio: dataUrl })
  })

  it("空输入时识别结果成为全部内容，非空时以空格分隔追加", () => {
    expect(appendTranscript("", "写个单测")).toBe("写个单测")
    expect(appendTranscript("部署预发环境", "写个单测")).toBe("部署预发环境 写个单测")
  })
})

describe("useVoiceInput 的可用性探测", () => {
  it("两条语音路径都不存在时判定为不可用", () => {
    withoutVoiceApis()

    expect(isVoiceInputSupported()).toBe(false)
    expect(VOICE_UNSUPPORTED_MESSAGE).toContain("麦克风权限")
    expect(VOICE_MIC_DENIED_MESSAGE).toBe("麦克风访问被拒绝。")
  })

  it("仅暴露 webkitSpeechRecognition 也算支持", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: class {} })
    vi.stubGlobal("navigator", {})

    expect(isVoiceInputSupported()).toBe(true)
  })

  it("没有 Web Speech 但能录音时同样算支持（回退路径）", () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => undefined } })

    expect(isVoiceInputSupported()).toBe(true)
  })
})
