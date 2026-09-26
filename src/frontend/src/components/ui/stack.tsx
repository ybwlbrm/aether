import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export const STACK_GAPS = ["1", "2", "3", "4", "5", "6", "8", "10", "12", "16"] as const
export type StackGap = (typeof STACK_GAPS)[number]
export type StackAlign = "start" | "center" | "end" | "stretch" | "baseline"
export type StackJustify = "start" | "center" | "end" | "between" | "around" | "evenly"

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  readonly direction?: "row" | "column"
  readonly gap?: StackGap
  readonly align?: StackAlign
  readonly justify?: StackJustify
  readonly wrap?: boolean
  readonly children?: ReactNode
}

export function Stack({
  direction = "column",
  gap = "4",
  align = "stretch",
  justify = "start",
  wrap = false,
  children,
  className,
  ...props
}: StackProps) {
  return (
    <div
      data-slot="stack"
      data-direction={direction}
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? "true" : undefined}
      className={cn("ui-stack", className)}
      {...props}
    >
      {children}
    </div>
  )
}
