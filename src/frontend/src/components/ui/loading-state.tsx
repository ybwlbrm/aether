import type { HTMLAttributes, ReactNode } from "react"

import { Spinner } from "./spinner"
import { cn } from "@/lib/utils"

export interface LoadingStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly label?: ReactNode
  readonly description?: ReactNode
  readonly size?: "sm" | "md" | "lg"
}

export function LoadingState({
  label = "Loading",
  description,
  size = "md",
  className,
  ...props
}: LoadingStateProps) {
  return (
    <div
      {...props}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-slot="loading-state"
      className={cn("ui-loading-state", className)}
    >
      <Spinner size={size} />
      <div data-slot="loading-state-copy" className="ui-state-copy">
        <div data-slot="loading-state-label" className="ui-state-title">
          {label}
        </div>
        {description ? (
          <div data-slot="loading-state-description" className="ui-state-description">
            {description}
          </div>
        ) : null}
      </div>
    </div>
  )
}
