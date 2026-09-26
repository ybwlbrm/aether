import { CircleAlert } from "lucide-react"
import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  readonly title?: ReactNode
  readonly description?: ReactNode
  readonly action?: ReactNode
  readonly icon?: ReactNode
}

export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  icon = <CircleAlert aria-hidden="true" />,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      {...props}
      role="alert"
      data-slot="error-state"
      className={cn("ui-error-state", className)}
    >
      <div data-slot="error-state-icon" className="ui-state-icon ui-error-state-icon" aria-hidden="true">
        {icon}
      </div>
      <div data-slot="error-state-copy" className="ui-state-copy">
        <div data-slot="error-state-title" className="ui-state-title">
          {title}
        </div>
        {description ? (
          <div data-slot="error-state-description" className="ui-state-description">
            {description}
          </div>
        ) : null}
        {action ? <div data-slot="error-state-action">{action}</div> : null}
      </div>
    </div>
  )
}
