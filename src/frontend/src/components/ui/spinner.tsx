import type { CSSProperties } from "react"

export interface SpinnerProps {
  readonly size?: "sm" | "md" | "lg"
  readonly className?: string
  readonly style?: CSSProperties
}

const spinnerClasses = {
  sm: "spinner spinner-sm",
  md: "spinner",
  lg: "spinner spinner-lg",
} as const

export function Spinner({ size = "md", className = "", style }: SpinnerProps) {
  return (
    <div
      data-slot="spinner"
      data-size={size}
      role="status"
      aria-label="Loading"
      className={`${spinnerClasses[size]} ${className}`}
      style={style}
    />
  )
}
