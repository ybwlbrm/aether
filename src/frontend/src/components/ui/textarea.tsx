"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * 共享 Textarea 组件（W4-6：统一提示词/笔记输入，消除内联 styles 重复）
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        data-slot="textarea"
        className={cn(
          'min-h-[64px] w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3.5 py-2.5 text-sm text-[var(--text-primary)]',
          'placeholder:text-[var(--input-placeholder)] outline-none transition-colors resize-y',
          'focus-visible:border-[var(--input-border-focus)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };