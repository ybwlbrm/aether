import type { CSSProperties } from "react";
import type { ProviderSelectOption } from "../../hooks/useProviderSelection";

/**
 * ProviderSelect — 模型选择（T13 useProviderSelection 的输出渲染）。
 *
 * 数据契约即 hook 的 `selectedModel` / `textProviders` 经 `toSelectOptions` 推导出的
 * `ProviderSelectOption[]`；本组件只渲染 <select> 并把选择回传，不碰控制器。
 *
 * 门控：能力关（enabled=false）或 provider 尚未落定（selectedProviderId 为 null）时
 * **不产生任何 DOM** —— 与 ComposerToolbar 里的模型选择器同源，但在这里独立成组件，
 * 以便新壳层按需挂载。
 */

export interface ProviderSelectProps {
  readonly selectedProviderId: string | null;
  readonly options: readonly ProviderSelectOption[];
  readonly onProviderChange: (providerId: string) => void;
  /** 能力开关；关闭时零 DOM */
  readonly enabled?: boolean;
  readonly disabled?: boolean;
}

/** 模型名 + 📷 标记所需宽度（沿用既有 ComposerToolbar 选择器的上限，tokens 尚无对应尺寸） */
const SELECT_MAX_WIDTH = 140;

const selectStyle: CSSProperties = {
  maxWidth: SELECT_MAX_WIDTH,
  padding: "2px var(--space-1)",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border-primary)",
  background: "var(--bg-surface)",
  color: "var(--text-secondary)",
  fontFamily: "inherit",
  fontSize: "var(--font-size-label)",
  fontWeight: "var(--font-weight-medium)",
  cursor: "pointer",
};

export function ProviderSelect(props: ProviderSelectProps) {
  const { selectedProviderId, options, onProviderChange, enabled = true, disabled = false } = props;
  if (!enabled || selectedProviderId === null) return null;

  return (
    <select
      data-slot="composer-provider"
      aria-label="选择 AI 模型"
      title="选择 AI 模型（支持多模态的模型可分析图片）"
      value={selectedProviderId}
      disabled={disabled}
      onChange={(e) => onProviderChange(e.target.value)}
      style={selectStyle}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
