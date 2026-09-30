import type { CSSProperties } from "react";
import { Mic } from "lucide-react";
import { useVoiceInput } from "../../hooks/useVoiceInput";

/**
 * VoiceButton — useVoiceInput（T11）的薄封装。
 *
 * 本文件只做两件事：把 hook 的四个入参原样下发，把 recording / supported 两个出参
 * 映射成按钮的按下态与可用态。识别、录音、STT、错误上报全部在 hook 内。
 *
 * 能力门控：浏览器既无 Web Speech 又无麦克风采集（supported=false）时，
 * 若调用方同时禁用了它，按钮就是零功能的装饰 chrome —— 此时**不产生任何 DOM**。
 */

const ICON_SIZE = 16;
const STROKE_IDLE = 1.75;
const STROKE_ACTIVE = 2;

export interface VoiceButtonProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** 输入中 / 生成中时禁用录音 */
  readonly disabled?: boolean;
  readonly onError: (message: string) => void;
}

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "var(--space-6)",
  height: "var(--space-6)",
  borderRadius: "var(--radius-control)",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--text-tertiary)",
  cursor: "pointer",
  flexShrink: 0,
};

export function VoiceButton(props: VoiceButtonProps) {
  const { value, onChange, disabled = false, onError } = props;
  const { recording, supported, toggle } = useVoiceInput({ value, onChange, onError, disabled });

  // 能力关 + 调用方已禁用 = 纯装饰，直接不渲染（零 chrome）
  if (!supported && disabled) return null;

  return (
    <button
      type="button"
      data-slot="composer-voice"
      aria-label="语音输入"
      title={recording ? "停止语音输入" : "语音输入"}
      aria-pressed={recording}
      onClick={toggle}
      disabled={disabled || !supported}
      style={{ ...buttonStyle, color: recording ? "var(--color-danger)" : "var(--text-tertiary)" }}
    >
      <Mic size={ICON_SIZE} strokeWidth={recording ? STROKE_ACTIVE : STROKE_IDLE} aria-hidden="true" />
    </button>
  );
}
