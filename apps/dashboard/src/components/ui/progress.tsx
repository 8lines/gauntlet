"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      value={value}
      {...props}
    >
      {/* Without a value the bar is indeterminate: a segment that travels along the track, or the whole track when motion is reduced. */}
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full w-full flex-1 bg-primary transition-all",
          "data-[state=indeterminate]:w-2/5 data-[state=indeterminate]:animate-[gauntlet-indeterminate_1.4s_ease-in-out_infinite] data-[state=indeterminate]:transition-none",
          "motion-reduce:data-[state=indeterminate]:w-full motion-reduce:data-[state=indeterminate]:animate-none motion-reduce:data-[state=indeterminate]:opacity-50",
          "in-data-[motion=reduce]:data-[state=indeterminate]:w-full in-data-[motion=reduce]:data-[state=indeterminate]:animate-none in-data-[motion=reduce]:data-[state=indeterminate]:opacity-50"
        )}
        style={typeof value === "number" ? { transform: `translateX(-${100 - value}%)` } : undefined}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
