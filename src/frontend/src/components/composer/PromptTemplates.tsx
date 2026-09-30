import type { CSSProperties } from "react";
import { Bookmark } from "lucide-react";
import { PromptTemplateSelector } from "../PromptTemplateSelector";

/**
 * PromptTemplates — 既有 PromptTemplateSelector 的受控外壳。
 *
 * 既有选择器自带 `open` 自门控、portal 与全部 CRUD 状态（254 行，本任务一行不动）。
 * 本组件只补两件事：一个与 Composer 同表面的低调触发按钮，以及能力门控。
 *
 * 门控：能力关（enabled=false）时**不产生任何 DOM**（连触发按钮也不留）。
 */

const ICON_SIZE = 16;
const STROKE_INACTIVE = 1.75;
const STROKE_ACTIVE = 2;

export interface PromptTemplatesProps {
  /** 受控开合：外壳不持有状态，由调用方持有 */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (content: string) => void;
  /** 当前输入：交给既有选择器的「保存当前输入为模板」 */
  readonly currentInput?: string;
  /** 能力开关；关闭时零 DOM */
  readonly enabled?: boolean;
  readonly disabled?: boolean;
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

export function PromptTemplates(props: PromptTemplatesProps) {
  const { open, onOpenChange, onSelect, currentInput = "", enabled = true, disabled = false } = props;
  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        data-slot="composer-templates"
        aria-label="提示词模板"
        title="提示词模板"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        disabled={disabled}
        style={{ ...buttonStyle, color: open ? "var(--accent-interactive)" : "var(--text-tertiary)" }}
      >
        <Bookmark size={ICON_SIZE} strokeWidth={open ? STROKE_ACTIVE : STROKE_INACTIVE} aria-hidden="true" />
      </button>
      {/* 懒挂载：未打开时根本不 new 选择器 —— 它的 mount effect 会去后端拉模板列表 */}
      {open && (
        <PromptTemplateSelector open={open} onClose={() => onOpenChange(false)} onSelect={onSelect} currentInput={currentInput} />
      )}
    </>
  );
}
