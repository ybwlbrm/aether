import type { HTMLAttributes, ReactNode } from "react"

import { RUN_STATUSES } from "@pacc/shared"

import { cn } from "@/lib/utils"

/**
 * AEX-P0-002: run statuses are canonical in @pacc/shared.
 * The pill covers every one of them instead of a locally redefined 8-state subset.
 */
export const STATUS_PILL_STATUSES = RUN_STATUSES

export type StatusPillStatus = (typeof STATUS_PILL_STATUSES)[number]
export type StatusPillTone = "success" | "danger" | "info" | "warning" | "accent" | "neutral"

export const STATUS_PILL_TONE_BY_STATUS = {
  created: "neutral",
  running: "info",
  waiting: "info",
  retry_waiting: "warning",
  retrying: "warning",
  verifying: "accent",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warning",
  budget_exceeded: "danger",
} as const satisfies Record<StatusPillStatus, StatusPillTone>

export const STATUS_PILL_LABELS = {
  created: "created",
  running: "running",
  waiting: "waiting",
  retry_waiting: "retry waiting",
  retrying: "retrying",
  verifying: "verifying",
  completed: "completed",
  failed: "failed",
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
