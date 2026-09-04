"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * 共享 Input 组件（W4-6：统一 .input 样式，消除内联 input 样式重复）
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        data-slot="input"
        className={cn(
          'h-10 w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3.5 text-sm text-[var(--text-primary)]',
          'placeholder:text-[var(--input-placeholder)] outline-none transition-colors',
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
Input.displayName = 'Input';

export { Input };