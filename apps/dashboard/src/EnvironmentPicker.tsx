import { useId, useRef } from "react";
import type { TargetSnapshot } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { formatRelativeTime } from "./copy.ts";
import { navigate } from "./route.ts";

export function EnvironmentPicker({ targets, selected }: {
  targets: readonly TargetSnapshot[];
  selected: TargetSnapshot | undefined;
}) {
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (selected === undefined) return null;
  const application = selected.manifest?.application;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        aria-label={`Choose environment: ${selected.label}`}
        className="toolbar-control flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left hover:bg-accent sm:max-w-72 sm:flex-none"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateColorClass(selected)}`} />
        <span className="truncate text-[12px] font-medium">
          {application?.environment.name ?? selected.label}
        </span>
        {application !== undefined && (
          <span className="hidden shrink-0 rounded-badge border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">
            {application.environment.kind}
          </span>
        )}
        <Icon name="chevron" className="ml-auto h-3.5 w-3.5 rotate-90 text-muted-foreground" />
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        onToggle={(event) => {
          if (event.newState === "open") {
            event.currentTarget.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
          }
        }}
        role="dialog"
        aria-label="Environments"
        className="environment-popover"
      >
        <p className="px-3 pb-2 pt-1 text-[11px] font-medium text-muted-foreground">Environments</p>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {targets.map((target) => (
            <button
              key={target.id}
              type="button"
              aria-pressed={target.id === selected.id}
              onClick={() => {
                if (target.id !== selected.id) navigate({ targetId: target.id });
                popover.current?.hidePopover();
                trigger.current?.focus();
              }}
              className="flex min-h-12 w-full items-center gap-3 rounded-control px-3 py-2 text-left hover:bg-accent aria-pressed:bg-accent"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateColorClass(target)}`} />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-[13px] font-medium">{target.label}</span>
                <span className="mt-0.5 block break-words text-[11px] text-muted-foreground">
                  {target.manifest?.application.environment.name ?? "No environment details"}
                  {target.manifest && ` · ${target.manifest.application.environment.kind}`} · {stateLabel(target)}
                </span>
              </span>
              {target.id === selected.id && <Icon name="check" className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
        <dl className="mt-2 space-y-2 border-t border-border px-3 pb-2 pt-3 text-[12px]">
          {application !== undefined && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Application</dt>
              <dd className="min-w-0 break-words text-right">{application.label}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Refreshed</dt>
            <dd>{formatRelativeTime(selected.refreshedAt)}</dd>
          </div>
        </dl>
      </div>
    </>
  );
}

export function stateColorClass(target: TargetSnapshot): string {
  return target.state === "online" ? "bg-ok" : target.state === "degraded" ? "bg-wait" : "bg-stop";
}

export function stateLabel(target: TargetSnapshot): string {
  return target.state === "online" ? "online" : target.state === "degraded" ? "degraded" : "unavailable";
}
