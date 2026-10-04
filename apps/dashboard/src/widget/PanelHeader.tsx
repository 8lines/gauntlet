import type { Ref } from "react";
import { LogOut, Search, X } from "lucide-react";
import type { TargetSnapshot } from "../api.ts";
import { GauntletMark } from "@/components/gauntlet/GauntletMark";
import { StateMark } from "@/components/gauntlet/StateMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { targetStateLabel, targetStateTone } from "../app/EnvironmentSwitcher.tsx";

/**
 * Header of the embedded panel. The close button (and Escape, handled by `Panel`) is the
 * only way to close the drawer: the open iframe covers the host's launcher button.
 */
export function PanelHeader({ snapshot, search, onClose, onLogOut }: {
  snapshot: TargetSnapshot | undefined;
  search?: {
    readonly query: string;
    readonly onQuery: (query: string) => void;
    readonly inputRef: Ref<HTMLInputElement>;
    readonly disabled: boolean;
  } | undefined;
  onClose: () => void;
  /** Shown only when Gauntlet requires authentication. */
  onLogOut?: (() => void) | undefined;
}) {
  const environment = snapshot?.manifest?.application.environment;
  return (
    <header className="shrink-0 border-b bg-background px-4 py-3">
      <div className="flex items-center gap-2">
        <GauntletMark className="size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm/5 font-medium">{snapshot?.label ?? "Gauntlet"}</p>
          {snapshot !== undefined && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs/4 text-muted-foreground">
              <StateMark tone={targetStateTone(snapshot)} className="shrink-0" />
              {environment === undefined
                ? <span className="truncate">{targetStateLabel(snapshot)}</span>
                : (
                  <>
                    <span className="sr-only">{targetStateLabel(snapshot)}. </span>
                    <span className="truncate">{`${environment.name}, ${environment.kind}`}</span>
                  </>
                )}
            </p>
          )}
        </div>
        {onLogOut !== undefined && (
          <Button type="button" variant="ghost" size="icon" aria-label="Log out" title="Log out" onClick={onLogOut}>
            <LogOut aria-hidden="true" />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {search !== undefined && (
        <div className="relative mt-3" title={search.disabled ? "Go back to the list to search" : undefined}>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
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
            className="pl-9 text-sm/5 md:text-sm/5"
          />
        </div>
      )}
    </header>
  );
}
