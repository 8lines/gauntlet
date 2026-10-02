import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  AdapterManifest,
  JsonObject,
  OperationSummary,
  Problem,
} from "@8lines/gauntlet-protocol";
import { api, type TargetSnapshot } from "./api.ts";
import { Card, Button, EmptyState } from "./ui.tsx";
import { describeProblem } from "./copy.ts";
import { navigate, useRoute } from "./route.ts";
import { Icon } from "./Icon.tsx";
import { GlobalSearch } from "./GlobalSearch.tsx";
import { EnvironmentPicker } from "./EnvironmentPicker.tsx";
import { useOperationDetails } from "./useOperationDetails.ts";
import { EnvironmentOverview } from "./EnvironmentOverview.tsx";
import { UserSettings } from "./UserSettings.tsx";
import { usePreferences } from "./preferences.ts";
import { OperationScreen } from "./screens/OperationScreen.tsx";
import { rememberRun } from "./recent-runs.ts";
import { browserStorage } from "./browser-storage.ts";

export function App() {
  const route = useRoute();
  const [targets, setTargets] = useState<readonly TargetSnapshot[]>();
  const [problem, setProblem] = useState<Problem>();
  const [navOpen, setNavOpen] = useState(false);
  const { preferences, updatePreferences, saved } = usePreferences();
  const navCollapsed = preferences.sidebarCollapsed;
  const isDesktop = useDesktopLayout();
  const navButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreNavFocusRef = useRef(false);
  const [navigationInput, setNavigationInput] = useState(() => ({
    key: 0,
    input: gauntletInput(globalThis.history.state),
  }));

  useEffect(() => {
    const handleNavigation = (event: PopStateEvent) => {
      // Only navigation that carries new input remounts the operation screen; a run URL
      // replacing the operation URL (or back to it) keeps the form as it is.
      const input = gauntletInput(event.state);
      setNavigationInput((current) =>
        input === undefined ? { ...current, input } : { key: current.key + 1, input },
      );
    };
    globalThis.addEventListener("popstate", handleNavigation);
    return () => globalThis.removeEventListener("popstate", handleNavigation);
  }, []);

  const consumeInitialInput = useCallback(() => {
    globalThis.history.replaceState(null, "", globalThis.location.href);
    setNavigationInput((current) => ({ ...current, input: undefined }));
  }, []);

  useEffect(() => {
    void (async () => {
      const result = await api.targets();
      if (result.ok) setTargets(result.data);
      else setProblem(result.problem);
    })();
  }, []);

  const selected = targets?.find((t) => t.id === route.targetId) ?? targets?.[0];

  useEffect(() => {
    if (route.targetId === undefined && selected !== undefined)
      navigate({ targetId: selected.id });
  }, [route.targetId, selected]);

  const openNavigation = useCallback(() => {
    restoreNavFocusRef.current = false;
    setNavOpen(true);
  }, []);

  const closeNavigation = useCallback(() => {
    restoreNavFocusRef.current = !isDesktop;
    setNavOpen(false);
  }, [isDesktop]);

  useEffect(() => {
    if (!navOpen || isDesktop) return;
    const frame = globalThis.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [navOpen, isDesktop]);

  useEffect(() => {
    if (navOpen || !restoreNavFocusRef.current) return;
    restoreNavFocusRef.current = false;
    const frame = globalThis.requestAnimationFrame(() => {
      navButtonRef.current?.focus({ preventScroll: true });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen || isDesktop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const controls = [
          ...document.querySelectorAll<HTMLButtonElement>(
            "#gauntlet-navigation button:not(:disabled)",
          ),
        ].filter((control) => control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeNavigation();
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [navOpen, isDesktop, closeNavigation]);

  useEffect(() => {
    if (!isDesktop || !navOpen) return;
    restoreNavFocusRef.current = false;
    setNavOpen(false);
  }, [navOpen, isDesktop]);

  return (
    <div className="flex h-dvh min-w-0 overflow-hidden">
      <Sidebar
        selected={selected}
        route={route}
        open={navOpen}
        collapsed={navCollapsed}
        isDesktop={isDesktop}
        closeButtonRef={closeButtonRef}
        onClose={closeNavigation}
      />
      {navOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={closeNavigation}
        />
      )}

      <div
        className="app-shell flex min-w-0 flex-1 flex-col"
        data-sidebar-collapsed={navCollapsed}
        inert={navOpen && !isDesktop}
        aria-hidden={(navOpen && !isDesktop) || undefined}
      >
        <header className="app-header flex shrink-0 items-center gap-2 sm:gap-3">
          <button
            ref={navButtonRef}
            type="button"
            onClick={() =>
              isDesktop
                ? updatePreferences({ sidebarCollapsed: !navCollapsed })
                : openNavigation()
            }
            aria-label={
              isDesktop && !navCollapsed
                ? "Collapse navigation"
                : "Open navigation"
            }
            aria-controls="gauntlet-navigation"
            aria-expanded={isDesktop ? !navCollapsed : navOpen}
            className="icon-button"
          >
            <Icon name="panel" />
          </button>
          <div className="h-6 w-px bg-border" />
          <GlobalSearch targets={targets} />
          <div className="hidden sm:ml-auto sm:block" />
          <EnvironmentPicker targets={targets ?? []} selected={selected} />
          <UserSettings preferences={preferences} onChange={updatePreferences} saved={saved} />
        </header>

        <main
          id="workspace"
          className={`workspace min-h-0 min-w-0 flex-1 overflow-x-hidden ${route.operationId === undefined ? "overflow-y-auto" : "flex flex-col overflow-hidden"}`}
        >
          <div className="page-inset flex min-h-10 shrink-0 items-center border-b border-border">
            <Breadcrumbs selected={selected} route={route} />
          </div>
          {problem !== undefined && <FullPageError problem={problem} />}
          {problem === undefined && targets === undefined && <Loading />}
          {problem === undefined &&
            targets !== undefined &&
            targets.length === 0 && (
              <EmptyState
                title="No environments configured"
                description="Add an environment to the Gauntlet configuration, then restart the server."
              />
            )}
          {selected !== undefined && route.operationId === undefined && (
            <EnvironmentOverview target={selected} />
          )}
          {selected !== undefined && route.operationId !== undefined && (
            <OperationScreen
              key={`${selected.id}:${route.operationId}:${navigationInput.key}`}
              targetId={selected.id}
              operationId={route.operationId}
              runId={route.runId}
              environment={selected.label}
              {...(navigationInput.input === undefined
                ? {}
                : { initialInput: navigationInput.input })}
              onInitialInputConsumed={consumeInitialInput}
              onRunCreated={(run) => {
                const operationId = route.operationId!;
                rememberRun(browserStorage, {
                  targetId: selected.id,
                  operationId,
                  label: selected.manifest?.operations.find((o) => o.id === operationId)?.label ?? operationId,
                  runId: run.id,
                  startedAt: run.startedAt ?? run.createdAt,
                });
                navigate({ targetId: selected.id, operationId, runId: run.id }, { replace: true });
              }}
              onRunCleared={() => navigate({ targetId: selected.id, operationId: route.operationId! }, { replace: true })}
            />
          )}
        </main>
        <footer className="app-footer" aria-label="Application information">
          Gauntlet v{__GAUNTLET_VERSION__}
        </footer>
      </div>
    </div>
  );
}

function gauntletInput(state: unknown): JsonObject | undefined {
  if (
    typeof state !== "object" ||
    state === null ||
    !("gauntletInput" in state)
  )
    return undefined;
  const input = (state as { gauntletInput?: unknown }).gauntletInput;
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as JsonObject)
    : undefined;
}

function Breadcrumbs({
  selected,
  route,
}: {
  selected: TargetSnapshot | undefined;
  route: ReturnType<typeof useRoute>;
}) {
  if (selected === undefined)
    return <span className="text-[13px] font-medium">Gauntlet</span>;
  const operation = selected.manifest?.operations.find(
    (o) => o.id === route.operationId,
  );
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-2 text-[12px]"
    >
      <Icon name="grid" className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
      <button
        type="button"
        onClick={() => navigate({ targetId: selected.id })}
        title={selected.label}
        className={`min-w-0 truncate text-left ${operation === undefined ? "" : "max-w-[50%]"} ${
          operation === undefined
            ? "font-medium"
            : "text-muted-foreground hover:text-foreground hover:underline"
        }`}
      >
        {selected.label}
      </button>
      {operation !== undefined && (
        <>
          <Icon name="chevron" className="h-3 w-3 text-muted-foreground" />
          <span className="truncate font-medium" title={operation.label}>{operation.label}</span>
        </>
      )}
    </nav>
  );
}

function Sidebar({
  selected,
  route,
  open,
  collapsed,
  isDesktop,
  closeButtonRef,
  onClose,
}: {
  selected: TargetSnapshot | undefined;
  route: ReturnType<typeof useRoute>;
  open: boolean;
  collapsed: boolean;
  isDesktop: boolean;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const manifest = selected?.manifest;
  const hidden = isDesktop ? collapsed : !open;
  return (
    <aside
      id="gauntlet-navigation"
      aria-label="Gauntlet navigation"
      aria-hidden={hidden || undefined}
      inert={hidden}
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-rail text-rail-foreground transition-transform motion-reduce:transition-none lg:static lg:w-[272px] lg:translate-x-0 ${collapsed ? "lg:hidden" : ""} ${
        open
          ? "visible translate-x-0 pointer-events-auto"
          : "invisible -translate-x-full pointer-events-none lg:visible lg:pointer-events-auto"
      }`}
    >
      <div className="sidebar-brand flex shrink-0 items-center gap-3 px-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Icon name="logo" className="h-5 w-5" />
        </span>
        <span className="text-xl font-semibold tracking-tight">
          Gauntlet
        </span>
        <span className="flex-1" />
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="icon-button min-h-12 min-w-12 lg:hidden"
        >
          <Icon name="close" />
        </button>
      </div>

      <nav aria-label="Operations" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
        {selected !== undefined && (
          <button
            type="button"
            className="nav-item mb-3"
            aria-current={route.operationId === undefined ? "page" : undefined}
            onClick={() => {
              navigate({ targetId: selected.id });
              onClose();
            }}
          >
            <Icon name="grid" />
            Overview
            <span className="nav-count">
              {manifest?.operations.length ?? 0}
            </span>
          </button>
        )}
        {manifest === undefined ? (
          <p className="px-2 py-2 text-[12px] leading-relaxed text-rail-muted">
            No operation catalog — the environment did not respond correctly.
          </p>
        ) : (
          <Catalog
            manifest={manifest}
            targetId={selected!.id}
            activeId={route.operationId}
            onSelect={onClose}
          />
        )}
      </nav>

    </aside>
  );
}

const MEDIA_DESKTOP = "(min-width: 1024px)";

function useDesktopLayout(): boolean {
  const [isDesktop, setIsDesktop] = useState(matchesDesktopLayout);

  useEffect(() => {
    if (typeof globalThis.matchMedia === "function") {
      const media = globalThis.matchMedia(MEDIA_DESKTOP);
      const update = () => setIsDesktop(media.matches);
      update();
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }

    const update = () => setIsDesktop(matchesDesktopLayout());
    globalThis.addEventListener("resize", update);
    return () => globalThis.removeEventListener("resize", update);
  }, []);

  return isDesktop;
}

function matchesDesktopLayout(): boolean {
  if (typeof globalThis.matchMedia === "function")
    return globalThis.matchMedia(MEDIA_DESKTOP).matches;
  return (
    typeof globalThis.innerWidth === "number" && globalThis.innerWidth >= 1024
  );
}

function Catalog({
  manifest,
  targetId,
  activeId,
  onSelect,
}: {
  manifest: AdapterManifest;
  targetId: string;
  activeId: string | undefined;
  onSelect: () => void;
}) {
  const details = useOperationDetails(targetId, manifest.operations);
  const groups = [...manifest.features].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  const ungrouped = manifest.operations.filter(
    (o) => !groups.some((g) => g.id === o.featureId),
  );

  const renderItems = (operations: readonly OperationSummary[]) =>
    operations.map((o) => {
      const available = o.availability.state === "available";
      return (
        <button
          key={o.id}
          type="button"
          disabled={!available}
          onClick={() => {
            navigate({ targetId, operationId: o.id });
            onSelect();
          }}
          aria-label={o.label}
          title={details[o.id]?.description ?? o.label}
          aria-current={o.id === activeId ? "page" : undefined}
          className="nav-item mb-1"
        >
          <Icon name="play" className="h-[18px] w-[18px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{o.label}</span>
            <span className={`mt-1 block text-[11px] font-normal leading-relaxed ${available ? "text-rail-muted" : "text-wait"}`}>
              {!available ? "Unavailable" : details[o.id]?.label ?? "Loading details…"}
            </span>
          </span>
        </button>
      );
    });

  return (
    <>
      {groups.map((g) => {
        const operations = manifest.operations.filter(
          (o) => o.featureId === g.id,
        );
        if (operations.length === 0) return null;
        return (
          <div key={g.id}>
            <p className="section-label mb-2 mt-6 px-3 text-rail-muted">
              {g.label}
            </p>
            {renderItems(operations)}
          </div>
        );
      })}
      {ungrouped.length > 0 && (
        <div>
          <p className="section-label mb-2 mt-6 px-3 text-rail-muted">
            Other
          </p>
          {renderItems(ungrouped)}
        </div>
      )}
    </>
  );
}

function Loading() {
  return (
    <div className="page-body" role="status">
      <p className="text-[14px] text-muted-foreground">Loading environments…</p>
      <div aria-hidden="true" className="mt-6 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-card bg-muted" />
        ))}
      </div>
    </div>
  );
}

function FullPageError({ problem }: { problem: Problem }) {
  const { title, advice } = describeProblem(problem);
  return (
    <div className="p-4 sm:p-6">
      <Card title="Could not load environments">
        <div className="p-4">
          <p className="text-[13px] font-medium text-stop">{title}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{advice}</p>
          <div className="mt-3">
            <Button onClick={() => globalThis.location.reload()}>
              Try again
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
