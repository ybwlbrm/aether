import type { CSSProperties } from "react";
import { Brain, Globe, Repeat, Rocket, Zap, type LucideIcon } from "lucide-react";

/**
 * ComposerToolbar — 模式 / 工具开关的紧凑图标行（T18）。
 *
 * 与 Composer 同处一个表面，因此刻意压缩：无文字标签（只在 title / aria-label 里说人话），
 * 无 pill 底色、无分隔竖线；按下态只靠「主色文字 + 2px 描边」表达。
 *
 * D4 约束：零内部状态、零 effect —— 全部按下态与回调由 props 下发。
 */

const ICON_SIZE = 16;
const STROKE_INACTIVE = 1.75;
const STROKE_ACTIVE = 2;

/** 图标之间的间距（tokens.css 的 --space-1=4px 对 24px 图标行过松，收紧一半） */
const TOOL_GAP = 2;

/** normal / super 二选一的模式态 */
export interface ComposerModeState {
  readonly mode: "normal" | "super";
  readonly onModeChange: (mode: "normal" | "super") => void;
}

/** 三个独立开关的按下态与回调（成组下发，避免 props 列表超长） */
export interface ComposerTogglesState {
  readonly deepThinking: boolean;
  readonly onDeepThinkingToggle: () => void;
  readonly webSearch: boolean;
  readonly onWebSearchToggle: () => void;
  readonly loopMode: boolean;
  readonly onLoopModeToggle: () => void;
}

export interface ComposerToolbarProps {
  readonly mode: ComposerModeState;
  readonly toggles: ComposerTogglesState;
  readonly disabled?: boolean;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: TOOL_GAP,
  flexShrink: 0,
};

/** 工具按钮：无边框无底色；按下态仅换主色 + 加粗描边（安静但可辨） */
function toolStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "var(--space-6)",
    height: "var(--space-6)",
    borderRadius: "var(--radius-control)",
    border: "1px solid transparent",
    background: "transparent",
    color: active ? "var(--accent-interactive)" : "var(--text-tertiary)",
    cursor: "pointer",
  };
}

interface ToolSpec {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly Icon: LucideIcon;
  readonly active: boolean;
  readonly onToggle: () => void;
}

export function ComposerToolbar(props: ComposerToolbarProps) {
  const { mode, toggles, disabled = false } = props;
  const { deepThinking, onDeepThinkingToggle, webSearch, onWebSearchToggle, loopMode, onLoopModeToggle } = toggles;

  const tools: readonly ToolSpec[] = [
    {
      id: "mode-normal",
      label: "普通模式",
      hint: "普通模式：按指令逐步执行",
      Icon: Zap,
      active: mode.mode === "normal",
      onToggle: () => mode.onModeChange("normal"),
    },
    {
      id: "mode-super",
      label: "超级模式",
      hint: "超级模式：自主规划并多轮执行",
      Icon: Rocket,
      active: mode.mode === "super",
      onToggle: () => mode.onModeChange("super"),
    },
    {
      id: "deep-thinking",
      label: "深度思考",
      hint: "深度思考：先推理再作答",
      Icon: Brain,
      active: deepThinking,
      onToggle: onDeepThinkingToggle,
    },
    {
      id: "web-search",
      label: "联网搜索",
      hint: "联网搜索：允许检索外部资料",
      Icon: Globe,
      active: webSearch,
      onToggle: onWebSearchToggle,
    },
    {
      id: "loop-mode",
      label: "循环模式",
      hint: "循环模式：持续执行直到任务完整完成",
      Icon: Repeat,
      active: loopMode,
      onToggle: onLoopModeToggle,
    },
  ];

  return (
    <div data-slot="composer-toolbar" role="group" aria-label="输入区工具" aria-disabled={disabled} style={rowStyle}>
      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          aria-label={tool.label}
          title={tool.hint}
          aria-pressed={tool.active}
          onClick={tool.onToggle}
          disabled={disabled}
          style={toolStyle(tool.active)}
        >
          <tool.Icon
            size={ICON_SIZE}
            strokeWidth={tool.active ? STROKE_ACTIVE : STROKE_INACTIVE}
            aria-hidden="true"
          />
        </button>
      ))}
    </div>
  );
}
