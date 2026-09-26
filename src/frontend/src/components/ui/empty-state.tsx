import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly icon?: ReactNode
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly action?: ReactNode
}

export function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div data-slot="empty-state" className={cn("ui-empty-state glass-card", className)} {...props}>
      <div data-slot="empty-state-content" className="ui-state-content">
        {icon ? (
          <div data-slot="empty-state-icon" className="ui-state-icon" aria-hidden="true">
            {icon}
          </div>
        ) : null}
        <div data-slot="empty-state-title" className="ui-state-title">
          {title}
        </div>
        {description ? (
          <div data-slot="empty-state-description" className="ui-state-description">
            {description}
          </div>
        ) : null}
        {action ? <div data-slot="empty-state-action">{action}</div> : null}
      </div>
    </div>
  )
}
