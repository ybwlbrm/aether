import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export const STATUS_PILL_STATUSES = [
  "completed",
  "failed",
  "running",
  "retrying",
  "verifying",
  "cancelled",
  "interrupted",
  "budget_exceeded",
] as const

export type StatusPillStatus = (typeof STATUS_PILL_STATUSES)[number]
export type StatusPillTone = "success" | "danger" | "info" | "warning" | "accent" | "neutral"

export const STATUS_PILL_TONE_BY_STATUS = {
  completed: "success",
  failed: "danger",
  running: "info",
  retrying: "warning",
  verifying: "accent",
  cancelled: "neutral",
  interrupted: "warning",
  budget_exceeded: "danger",
} as const satisfies Record<StatusPillStatus, StatusPillTone>

export const STATUS_PILL_LABELS = {
  completed: "completed",
  failed: "failed",
  running: "running",
  retrying: "retrying",
  verifying: "verifying",
  cancelled: "cancelled",
  interrupted: "interrupted",
  budget_exceeded: "budget exceeded",
} as const satisfies Record<StatusPillStatus, string>

export interface StatusPillProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly status: StatusPillStatus
  readonly label?: ReactNode
  readonly icon?: ReactNode
}

export function StatusPill({ status, label, icon, className, ...props }: StatusPillProps) {
  const tone = STATUS_PILL_TONE_BY_STATUS[status]
  const content = label ?? STATUS_PILL_LABELS[status]

  return (
    <span
      {...props}
      role="status"
      data-slot="status-pill"
      data-status={status}
      data-tone={tone}
      className={cn("ui-status-pill", className)}
    >
      {icon ? (
        <span data-slot="status-pill-icon" className="ui-status-pill-icon" aria-hidden="true">
          {icon}
        </span>
      ) : (
        <span data-slot="status-pill-dot" className="ui-status-pill-dot" aria-hidden="true" />
      )}
      <span data-slot="status-pill-label">{content}</span>
    </span>
  )
}
