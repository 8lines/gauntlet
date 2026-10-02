import { useEffect, useRef, useState, type RefObject } from "react";
import type { TargetSnapshot } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { navigate, routePath, type Route } from "./route.ts";

/** Controlled by the app header's Search button (`triggerRef`) until the command palette replaces it. */
export function GlobalSearch({
  targets,
  open,
  onOpenChange: setOpen,
  triggerRef,
}: {
  targets: readonly TargetSnapshot[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (triggerRef.current?.closest("[inert]")) return;
      const modal = document.querySelector("dialog[open]");
      if (modal !== null && modal !== dialogRef.current) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen, triggerRef]);

  useEffect(() => {
    if (open) {
      setSearch("");
      dialogRef.current?.showModal();
      inputRef.current?.focus();
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
      triggerRef.current?.focus();
    }
  }, [open]);

  const query = search.trim().toLocaleLowerCase("en");
  const results = (targets ?? [])
    .flatMap((target) => [
      {
        label: target.label,
        description: "Environment overview",
        route: { targetId: target.id } as Route,
        disabled: false,
        environment: true,
      },
      ...(target.manifest?.operations ?? []).map((operation) => ({
        label: operation.label,
        description: target.label,
        route: { targetId: target.id, operationId: operation.id } as Route,
        disabled: operation.availability.state !== "available",
        environment: false,
      })),
    ])
    .filter((result) =>
      `${result.label} ${result.description}`
        .toLocaleLowerCase("en")
        .includes(query),
    );

  const select = (route: Route) => {
    navigate(route);
    setOpen(false);
    setSearch("");
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        className="dialog-surface search-dialog"
        aria-label="Search operations"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <Icon name="search" className="text-primary" />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search environments and operations"
            placeholder="Search environments and operations…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-h-11 min-w-0 flex-1 bg-transparent text-[15px] outline-none"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                dialogRef.current
                  ?.querySelector<HTMLAnchorElement>("a[href]")
                  ?.focus();
              }
              if (event.key === "Enter") {
                const first = results.find((result) => !result.disabled);
                if (first) select(first.route);
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Close search"
            onClick={() => setOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <div
          className="min-h-0 overflow-y-auto p-2"
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const links = [
              ...event.currentTarget.querySelectorAll<HTMLAnchorElement>(
                "a[href]",
              ),
            ];
            const index = links.indexOf(
              document.activeElement as HTMLAnchorElement,
            );
            if (index < 0) return;
            event.preventDefault();
            const next = index + (event.key === "ArrowDown" ? 1 : -1);
            if (next < 0) inputRef.current?.focus();
            else links[next]?.focus();
          }}
        >
          <p
            className="px-3 py-2 text-[12px] text-muted-foreground"
            role="status"
          >
            {results.length > 0
              ? `Environments and operations · ${results.length}`
              : "No matching results"}
          </p>
          {results.map((result) => (
            <a
              key={routePath(result.route)}
              href={result.disabled ? undefined : routePath(result.route)}
              aria-disabled={result.disabled || undefined}
              onClick={(event) => {
                event.preventDefault();
                if (!result.disabled) select(result.route);
              }}
              className={`flex items-center gap-3 rounded-control px-3 py-3 ${result.disabled ? "opacity-45" : "hover:bg-accent focus:bg-accent"}`}
            >
              <Icon
                name={result.environment ? "server" : "play"}
                className="text-muted-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="block wrap-anywhere text-[14px]">{result.label}</span>
                <span className="text-[12px] text-muted-foreground">
                  {result.description}
                  {result.disabled ? " · unavailable" : ""}
                </span>
              </span>
              {!result.disabled && (
                <Icon
                  name="arrow"
                  className="h-4 w-4 text-muted-foreground"
                />
              )}
            </a>
          ))}
        </div>
        <div className="shrink-0 border-t border-border bg-muted/50 px-5 py-3 text-[11px] text-muted-foreground">
          ↑ ↓ select <span className="mx-3">↵ open</span> Esc close
        </div>
      </dialog>
    </>
  );
}
