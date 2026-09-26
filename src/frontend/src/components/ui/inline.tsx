import type { HTMLAttributes, ReactNode } from "react"

import type { StackAlign, StackGap, StackJustify } from "./stack"
import { cn } from "@/lib/utils"

export type InlineGap = StackGap
export type InlineAlign = StackAlign
export type InlineJustify = StackJustify

export interface InlineProps extends HTMLAttributes<HTMLDivElement> {
  readonly gap?: InlineGap
  readonly align?: InlineAlign
  readonly justify?: InlineJustify
  readonly wrap?: boolean
  readonly children?: ReactNode
}

export function Inline({
  gap = "2",
  align = "center",
  justify = "start",
  wrap = true,
  children,
  className,
  ...props
}: InlineProps) {
  return (
    <div
      data-slot="inline"
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? "true" : undefined}
      className={cn("ui-inline", className)}
      {...props}
    >
      {children}
    </div>
  )
}
