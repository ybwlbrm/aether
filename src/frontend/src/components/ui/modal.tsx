"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"

/**
 * 共享 Modal 组件（W4-6：统一 Project/Media/Workflows 的弹层，含焦点陷阱与 Esc 关闭）
 */
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /** 弹层宽度限制（默认 560px） */
  maxWidth?: number;
}

export function Modal({ open, onClose, title, children, footer, className, maxWidth = 560 }: ModalProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const previousFocus = React.useRef<HTMLElement | null>(null);

  // Esc 关闭 + 焦点陷阱（Tab 循环）——W4-7 焦点陷阱
  React.useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    // 聚焦首个可聚焦元素
    requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
      first?.focus();
    });
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      data-slot="modal-backdrop"
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--bg-overlay)] p-4"
      style={{ backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        data-slot="modal"
        className={cn('glass-card pointer-events-auto flex max-h-[90vh] w-full flex-col overflow-hidden', className)}
        style={{ maxWidth, borderRadius: 'var(--card-radius)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-[var(--card-border)] px-5 py-3.5">
            <div style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]"
              onClick={onClose}
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--card-border)] px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}