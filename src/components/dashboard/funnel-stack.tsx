import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

export interface FunnelStage {
  key: string
  label: string
  value: string
  /** Secondary line, e.g. "11% dos que pediram". */
  hint?: string
  icon: ComponentType<{ className?: string }>
}

// Top-edge width (% of the container) of each band. The shape is a
// fixed taper on purpose, not value-proportional: the stages are not
// strictly nested any more (a customer who ordered may have been
// created before the period — migration 082), so proportional widths
// could invert the funnel. The numbers carry the real information.
const TOP_WIDTHS = [100, 86, 72, 58]
const BOTTOM_WIDTH = 46
const TONES = ['bg-primary/25', 'bg-primary/20', 'bg-primary/15', 'bg-primary/10']

/** Stacked, tapering funnel — one centered trapezoid per stage. */
export function FunnelStack({ stages }: { stages: FunnelStage[] }) {
  return (
    <div className="flex flex-col items-center gap-1" role="list">
      {stages.map((stage, i) => {
        const top = TOP_WIDTHS[i] ?? TOP_WIDTHS[TOP_WIDTHS.length - 1]
        const bottom = TOP_WIDTHS[i + 1] ?? BOTTOM_WIDTH
        // The band is `top`% wide; clip its bottom edge in to `bottom`%
        // of the container (relative to its own width).
        const inset = ((1 - bottom / top) / 2) * 100
        const Icon = stage.icon
        return (
          <div
            key={stage.key}
            role="listitem"
            className={cn('relative flex h-24 items-center justify-center', TONES[i] ?? TONES[3])}
            style={{
              width: `${top}%`,
              clipPath: `polygon(0 0, 100% 0, ${100 - inset}% 100%, ${inset}% 100%)`,
            }}
          >
            <div className="flex flex-col items-center px-4 text-center">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                {stage.label}
              </span>
              <span className="mt-1 text-2xl leading-none font-bold tabular-nums text-foreground">
                {stage.value}
              </span>
              {stage.hint ? (
                <span className="mt-1 text-xs text-muted-foreground">{stage.hint}</span>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
