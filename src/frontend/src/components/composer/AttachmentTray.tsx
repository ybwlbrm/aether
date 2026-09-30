import type { CSSProperties } from "react";
import { X } from "lucide-react";
import type { Attachment } from "../../hooks/useStreamSend";

/**
 * AttachmentTray — useAttachments（T12）输出的只读渲染。
 *
 * 数据契约即 hook 的 `attachments` + `remove(index)`：本组件不持有附件，
 * 也不接触隐藏 file input（那是 hook 的 inputProps / openPicker 的事）。
 *
 * 门控：能力关（enabled=false）时**不产生任何 DOM**；能力开但无附件时同样不渲染 ——
 * 空的托盘只是多一层边框，属于 chrome。
 */

const ICON_SIZE = 12;

/** 单个附件 chip 的宽度上限（tokens.css 尚无对应尺寸，用命名常量收敛，同 Sidebar 做法） */
const CHIP_MAX_WIDTH = 200;

export interface AttachmentTrayProps {
  readonly items: readonly Attachment[];
  readonly onRemove: (index: number) => void;
  /** 附件能力开关；关闭时零 DOM */
  readonly enabled?: boolean;
  readonly disabled?: boolean;
}

const trayStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-1)",
  padding: "var(--space-1) var(--space-2)",
};

const chipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  maxWidth: CHIP_MAX_WIDTH,
  padding: "2px var(--space-1)",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border-primary)",
  background: "var(--bg-elevated)",
};

const thumbStyle: CSSProperties = {
  width: "var(--space-6)",
  height: "var(--space-6)",
  borderRadius: "var(--radius-xs)",
  objectFit: "cover",
  flexShrink: 0,
};

const removeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-tertiary)",
  cursor: "pointer",
  flexShrink: 0,
};

/** 非图片附件用扩展名徽标占位（不额外拉一次图片请求） */
function extensionOf(name: string): string {
  return name.split(".").pop()?.toUpperCase() ?? "?";
}

export function AttachmentTray(props: AttachmentTrayProps) {
  const { items, onRemove, enabled = true, disabled = false } = props;
  if (!enabled || items.length === 0) return null;

  return (
    <div data-slot="composer-attachments" style={trayStyle}>
      {items.map((item, index) => {
        const isImage = item.dataUrl.startsWith("data:image/");
        return (
          <div key={`${item.name}-${index}`} style={chipStyle} title={item.name}>
            {isImage ? (
              <img src={item.dataUrl} alt="" style={thumbStyle} />
            ) : (
              <span
                aria-hidden="true"
                style={{
                  ...thumbStyle,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "var(--font-size-label)",
                  fontWeight: "var(--font-weight-semibold)",
                  background: "var(--bg-surface-hover)",
                  color: "var(--content-text-quiet)",
                }}
              >
                {extensionOf(item.name)}
              </span>
            )}
            <span
              style={{
                fontSize: "var(--font-size-label)",
                color: "var(--content-text-quiet)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.name}
            </span>
            <button
              type="button"
              aria-label={`移除附件 ${item.name}`}
              title={`移除附件 ${item.name}`}
              onClick={() => onRemove(index)}
              disabled={disabled}
              style={removeStyle}
            >
              <X size={ICON_SIZE} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
