import type { CSSProperties, ReactNode } from "react";
import { SendHorizontal, Square } from "lucide-react";

/**
 * Composer — Codex 式「低调工作输入区」（T18）。
 *
 * 定位：刻意比消息流更安静。**一个表面**（单层实底 + 1px hairline 边框），
 * 不加卡片阴影、不加毛玻璃、不加第二条分割线；动作只有 send / stop。
 *
 * D4 约束：本组件零 effect、零内部状态 —— 高度增长交给 CSS `field-sizing: content`，
 * 发送/停止语义全部由 props 驱动，因此可被 renderToStaticMarkup 直接断言。
 */

/** 图标尺寸与描边宽度：与 shell/Sidebar 的既有约定一致（inactive 1.75 / active 2） */
const ICON_SIZE = 16;
const STROKE_INACTIVE = 1.75;
const STROKE_ACTIVE = 2;

/** 键盘事件契约：只声明决策函数真正读取的字段（React 合成事件结构上兼容） */
export interface ComposerKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean };
  preventDefault(): void;
}

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  /** 存在进行中的 run：动作切换为 stop */
  readonly sending: boolean;
  readonly disabled: boolean;
  /** 输入区下沿的错误行；null / undefined 时不渲染 */
  readonly error?: string | null;
  readonly placeholder?: string;
  /** 动作区左侧插槽：VoiceButton / PromptTemplates 等同一表面的次级动作 */
  readonly before?: ReactNode;
  /** 动作区右侧插槽：AttachmentTray / ComposerToolbar 等同一表面的次级动作 */
  readonly after?: ReactNode;
}

/** IME 组合输入期间按 Enter 不应发送（语义逐字沿用 CodingHomeComposer 的 isComposing 守卫） */
function isComposing(event: ComposerKeyEvent): boolean {
  return event.nativeEvent.isComposing;
}

/**
 * 键盘提交策略（纯函数，便于零 DOM 断言）：
 * Enter 提交并吃掉默认换行；Shift+Enter 换行；**IME 组合期间（中文选词确认）不提交**。
 */
export function handleComposerKeyDown(event: ComposerKeyEvent, onSubmit: () => void): void {
  if (event.key === "Enter" && !event.shiftKey && !isComposing(event)) {
    event.preventDefault();
    onSubmit();
  }
}

/** 单层表面：实底 + hairline 边框，无阴影 / 无 blur（内容区不得使用玻璃，shell.css 材质边界） */
const surface: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-surface)",
  border: "var(--border-width-hairline) solid var(--border-primary)",
  background: "var(--bg-surface)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: "none",
  outline: "none",
  boxShadow: "none",
  background: "transparent",
  resize: "none",
  // 自动高度：不写 useEffect 去量 scrollHeight，交给 CSS 逐帧重算
  fieldSizing: "content",
  minHeight: "var(--space-6)",
  maxHeight: "calc(var(--space-6) * 8)",
  overflowY: "auto",
  padding: "var(--space-1) var(--space-2)",
  fontFamily: "inherit",
  fontSize: "var(--font-size-body-sm)",
  lineHeight: "var(--line-height-body)",
  color: "var(--text-primary)",
  caretColor: "var(--color-accent)",
};

const actionRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  minHeight: "var(--space-6)",
};

const hintStyle: CSSProperties = {
  flex: 1,
  fontSize: "var(--font-size-label)",
  color: "var(--content-text-quiet)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const iconButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "var(--space-8)",
  height: "var(--space-8)",
  borderRadius: "var(--radius-control)",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  flexShrink: 0,
};

const primaryButton: CSSProperties = {
  ...iconButton,
  color: "var(--text-primary)",
  background: "var(--bg-surface-hover)",
  borderColor: "var(--border-primary)",
};

const errorStyle: CSSProperties = {
  fontSize: "var(--font-size-label)",
  color: "var(--color-danger)",
};

/** 输入区：一个表面 + 一个自动高度输入 + 一行动作；错误只占一行文字，不做卡片 */
export function Composer(props: ComposerProps) {
  const { value, onChange, onSubmit, onStop, sending, disabled, error, placeholder, before, after } = props;
  const readOnly = sending || disabled;
  const canSend = !readOnly && value.trim().length > 0;

  return (
    <div data-slot="composer" style={surface}>
      {before}
      <textarea
        data-slot="composer-input"
        aria-label="消息输入框"
        rows={1}
        style={inputStyle}
        placeholder={placeholder ?? "描述任务，Enter 发送"}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => handleComposerKeyDown(e, onSubmit)}
      />

      <div data-slot="composer-actions" style={actionRow}>
        <span style={hintStyle}>{sending ? "生成中 · 可随时停止" : "Enter 发送 · Shift+Enter 换行"}</span>
        {after}
        {sending ? (
          <button
            type="button"
            data-slot="composer-stop"
            aria-label="停止生成"
            title="停止生成"
            onClick={onStop}
            style={iconButton}
          >
            <Square size={ICON_SIZE} strokeWidth={STROKE_ACTIVE} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            data-slot="composer-send"
            aria-label="发送"
            title="发送"
            onClick={onSubmit}
            disabled={!canSend}
            style={primaryButton}
          >
            <SendHorizontal size={ICON_SIZE} strokeWidth={STROKE_ACTIVE} aria-hidden="true" />
          </button>
        )}
      </div>

      {error && (
        <p data-slot="composer-error" role="alert" style={errorStyle}>
          {error}
        </p>
      )}
    </div>
  );
}
