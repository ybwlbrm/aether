import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders } from '../api/client';

// ============================================================
// Web Speech API —— 结构化类型，避免 any（契约源头在本文件）
// ============================================================

export interface SpeechAlternativeLike {
  readonly transcript: string
}

export interface SpeechResultLike {
  readonly isFinal: boolean
  readonly 0: SpeechAlternativeLike
}

export interface SpeechEventLike {
  readonly resultIndex: number
  readonly results: ArrayLike<SpeechResultLike>
}

export interface SpeechErrorEventLike {
  readonly error: string
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: SpeechErrorEventLike) => void) | null
  start(): void
  stop(): void
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionCtor
  webkitSpeechRecognition?: SpeechRecognitionCtor
}

// ── 语音不可用时的系统失败文案（由页面渲染为失败卡片，绝不写入输入框）────────
export const VOICE_UNSUPPORTED_MESSAGE = '语音输入不可用，需要麦克风权限。'
export const VOICE_MIC_DENIED_MESSAGE = '麦克风访问被拒绝。'

/** 语音识别不可恢复的错误码：用户主动停止 / 无声音，静默处理 */
const QUIET_SPEECH_ERRORS: ReadonlySet<string> = new Set(['no-speech', 'aborted'])

/** Web Speech 的构造器（标准 / webkit 前缀），两者皆无即不可用 */
function resolveSpeechCtor(): SpeechRecognitionCtor | undefined {
  const host = window as unknown as SpeechRecognitionWindow
  return host.SpeechRecognition ?? host.webkitSpeechRecognition
}

/** MediaRecorder 回退路径的前提：浏览器暴露了麦克风采集能力 */
function canRecordAudio(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

/** 可用性探测：Web Speech 与 MediaRecorder 两条路径都不可用时为 false */
export function isVoiceInputSupported(): boolean {
  if (typeof window === 'undefined') return false
  return resolveSpeechCtor() !== undefined || canRecordAudio()
}

/**
 * 合并一次识别事件里从 resultIndex 起的结果。
 * 已确认（isFinal）文本优先，其后拼接未确认的中间结果 —— 供输入框实时显示。
 */
export function mergeSpeechTranscript(
  event: SpeechEventLike,
  confirmedBefore: string,
): string {
  let interim = ''
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i]
    if (result.isFinal) confirmedBefore += result[0].transcript
    else interim += result[0].transcript
  }
  return (confirmedBefore + interim).trim()
}

/** STT 请求体：录音 blob 的 dataURL 原样作为 `audio` 字段提交 */
export function buildSttRequestBody(dataUrl: string): string {
  return JSON.stringify({ audio: dataUrl })
}

/** 识别结果并入输入框：已有内容时以空格分隔 */
export function appendTranscript(previous: string, text: string): string {
  return previous ? `${previous} ${text}` : text
}

export interface UseVoiceInputOptions {
  /** 当前输入框内容（STT 结果按此刻的真实值追加，等价于原实现的函数式更新） */
  readonly value: string
  /** 写入输入框（Web Speech 覆盖显示；STT 结果追加在其后） */
  readonly onChange: (next: string) => void
  /** 不可恢复的语音失败 —— 页面渲染为失败卡片，绝不伪装成输入内容 */
  readonly onError: (message: string) => void
  /** 输入中 / 生成中时禁用录音 */
  readonly disabled?: boolean
}

export interface UseVoiceInputReturn {
  readonly recording: boolean
  readonly supported: boolean
  readonly toggle: () => void
  readonly error: string | null
}

/**
 * 语音输入：双路径 —— Web Speech（实时中文转写）优先，
 * 不可用时回退 MediaRecorder → 后端 STT。
 * 卸载时释放识别器与麦克风流（防设备占用泄漏）。
 */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputReturn {
  const { onChange, onError, disabled } = options
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  // 事件回调跨越异步边界（识别事件 / STT 响应）时才读这些值 —— 用 ref 保持稳定引用，
  // 避免为了一次转写重建识别器
  const latestRef = useRef({ value: options.value, onChange, onError })
  latestRef.current = { value: options.value, onChange, onError }

  // P1 修复：卸载时停止识别/录音，释放麦克风流与浏览器资源
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop() } catch { /* ignore */ }
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop()
        }
      } catch { /* ignore */ }
      recognitionRef.current = null
      mediaRecorderRef.current = null
    }
  }, [])

  const reportError = useCallback((message: string) => {
    setError(message)
    latestRef.current.onError(message)
  }, [])

  /** 回退路径：录音 → dataURL → POST /api/conversations/stt → 追加识别文本 */
  const startRecorder = useCallback(() => {
    if (!canRecordAudio()) { reportError(VOICE_UNSUPPORTED_MESSAGE); return }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const recorder = new MediaRecorder(stream)
      audioChunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        setRecording(false)
        if (audioChunksRef.current.length === 0) return
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        const reader = new FileReader()
        reader.onload = async () => {
          const base64 = typeof reader.result === 'string' ? reader.result : ''
          try {
            const res = await fetch('/api/conversations/stt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...authHeaders() },
              body: buildSttRequestBody(base64),
            });
            if (res.ok) {
              const { text } = (await res.json()) as { text?: string }
              if (text) latestRef.current.onChange(appendTranscript(latestRef.current.value, text))
            }
          } catch { /* 网络失败：保持输入框不变 */ }
        }
        reader.readAsDataURL(audioBlob)
      }
      recorder.start()
      mediaRecorderRef.current = recorder
      setRecording(true)
    }).catch(() => reportError(VOICE_MIC_DENIED_MESSAGE))
  }, [reportError])

  /** 主路径：Web Speech 实时转写（已确认片段固化，后续结果只追加新确认段） */
  const startRecognition = useCallback((Ctor: SpeechRecognitionCtor) => {
    const recognition = new Ctor()
    // 中文 + 连续模式 + 实时中间结果
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    let finalTranscript = ''
    recognition.onresult = (event: SpeechEventLike) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) finalTranscript += result[0].transcript
        else interim += result[0].transcript
      }
      // 实时更新输入框：已确认文本 + 中间识别文本
      const display = (finalTranscript + interim).trim()
      if (display) latestRef.current.onChange(display)
    }
    recognition.onend = () => { setRecording(false) }
    recognition.onerror = (event: SpeechErrorEventLike) => {
      setRecording(false)
      if (!QUIET_SPEECH_ERRORS.has(event.error)) {
        console.warn('语音识别错误:', event.error)
      }
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
      setRecording(true)
    } catch { setRecording(false) }
  }, [])

  const toggle = useCallback(() => {
    if (recording) {
      if (recognitionRef.current) recognitionRef.current.stop()
      else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop()
      setRecording(false)
      return
    }
    if (disabled) return
    setError(null)
    const Ctor = resolveSpeechCtor()
    if (Ctor) { startRecognition(Ctor); return }
    startRecorder()
  }, [recording, disabled, startRecognition, startRecorder])

  return { recording, supported: isVoiceInputSupported(), toggle, error }
}
