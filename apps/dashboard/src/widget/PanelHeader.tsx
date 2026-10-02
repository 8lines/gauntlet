import type { Ref } from "react";
import type { TargetSnapshot } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { StateMark } from "@/components/gauntlet/StateMark";
import { targetStateLabel, targetStateTone } from "../app/EnvironmentSwitcher.tsx";

/**
 * Header of the embedded panel. The close button (and Escape, handled by `Panel`) is the
 * only way to close the drawer: the open iframe covers the host's launcher button.
 */
export function PanelHeader({ snapshot, search, onClose }: {
  snapshot: TargetSnapshot | undefined;
  search?: {
    readonly query: string;
    readonly onQuery: (query: string) => void;
    readonly inputRef: Ref<HTMLInputElement>;
    readonly disabled: boolean;
  } | undefined;
  onClose: () => void;
}) {
  const environment = snapshot?.manifest?.application.environment;
  return (
    <header className="shrink-0 border-b border-border bg-background px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Icon name="logo" className="h-4 w-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight">
          {snapshot?.label ?? "Gauntlet"}
        </p>
        {snapshot !== undefined && (
          <span
            className="flex min-w-0 max-w-[45%] items-center gap-1.5 rounded-badge border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={`Environment: ${environment?.name ?? snapshot.label} · ${targetStateLabel(snapshot)}`}
          >
            <StateMark tone={targetStateTone(snapshot)} className="shrink-0" />
            {environment === undefined
              ? <span className="truncate">{targetStateLabel(snapshot)}</span>
              : (
                <>
                  <span className="truncate font-medium text-foreground">{environment.name}</span>
                  <span className="shrink-0">{environment.kind}</span>
                </>
              )}
          </span>
        )}
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {search !== undefined && (
        <label
          className={`mt-3 flex items-center gap-2 rounded-control border border-input bg-background px-3 focus-within:border-ring ${search.disabled ? "opacity-50" : ""}`}
          title={search.disabled ? "Go back to the list to search" : undefined}
        >
          <Icon name="search" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={search.inputRef}
            type="search"
            aria-label="Search operations"
            placeholder={search.disabled ? "Go back to the list to search" : "Search operations…"}
            disabled={search.disabled}
            value={search.query}
            onChange={(event) => search.onQuery(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears a non-empty query first; only an empty search lets it close the panel.
              if (event.key !== "Escape" || search.query === "") return;
              event.preventDefault();
              event.stopPropagation();
              search.onQuery("");
            }}
            className="min-h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
        </label>
      )}
    </header>
  );
}
