import { useId } from "react"
import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title?: ReactNode
  readonly description?: ReactNode
  readonly actions?: ReactNode
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: SectionProps) {
  const titleId = useId()
  const hasHeader = Boolean(title || description || actions)

  return (
    <section
      data-slot="section"
      className={cn("ui-section", className)}
      aria-labelledby={title ? titleId : undefined}
      {...props}
    >
      {hasHeader ? (
        <div data-slot="section-header" className="ui-section-header">
          <div data-slot="section-heading" className="ui-section-heading">
            {title ? (
              <h2 id={titleId} data-slot="section-title" className="ui-section-title">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p data-slot="section-description" className="ui-section-description">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div data-slot="section-actions" className="ui-section-actions">
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      <div data-slot="section-content" className="ui-section-content">
        {children}
      </div>
    </section>
  )
}
