import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly actions?: ReactNode
  readonly action?: ReactNode
  readonly icon?: ReactNode
}

export function PageHeader({
  title,
  description,
  actions,
  action,
  icon,
  className,
  ...props
}: PageHeaderProps) {
  const actionContent = actions ?? action

  return (
    <header data-slot="page-header" className={cn("ui-page-header", className)} {...props}>
      <div data-slot="page-header-main" className="ui-page-header-main">
        {icon ? (
          <div data-slot="page-header-icon" className="ui-page-header-icon" aria-hidden="true">
            {icon}
          </div>
        ) : null}
        <div data-slot="page-header-copy" className="ui-page-header-copy">
          <h1 data-slot="page-header-title" className="ui-page-header-title">
            {title}
          </h1>
          {description ? (
            <p data-slot="page-header-description" className="ui-page-header-description">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actionContent ? (
        <div data-slot="page-header-actions" className="ui-page-header-actions">
          {actionContent}
        </div>
      ) : null}
    </header>
  )
}
