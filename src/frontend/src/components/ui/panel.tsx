import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: "default" | "subtle" | "accent"
  readonly children?: ReactNode
}

export function Panel({ tone = "default", children, className, ...props }: PanelProps) {
  return (
    <div data-slot="panel" data-tone={tone} className={cn("ui-panel", className)} {...props}>
      {children}
    </div>
  )
}
