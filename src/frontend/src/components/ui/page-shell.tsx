import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface PageShellProps extends Omit<HTMLAttributes<HTMLDivElement>, "content"> {
  readonly header?: ReactNode
  readonly content?: ReactNode
  readonly contentClassName?: string
}

export function PageShell({
  header,
  content,
  children,
  className,
  contentClassName,
  ...props
}: PageShellProps) {
  return (
    <div data-slot="page-shell" className={cn("ui-page-shell", className)} {...props}>
      {header ? <div data-slot="page-shell-header">{header}</div> : null}
      <div data-slot="page-shell-content" className={cn("ui-page-shell-content", contentClassName)}>
        {content ?? children}
      </div>
    </div>
  )
}
