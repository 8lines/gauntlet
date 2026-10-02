import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonObject } from "@8lines/gauntlet-protocol";
import { navigate, useRoute } from "../route.ts";
import { GlobalSearch } from "../GlobalSearch.tsx";
import { EnvironmentOverview } from "../EnvironmentOverview.tsx";
import { UserSettings } from "../UserSettings.tsx";
import { usePreferences } from "../preferences.ts";
import { OperationScreen } from "../screens/OperationScreen.tsx";
import { rememberRun } from "../recent-runs.ts";
import { browserStorage } from "../browser-storage.ts";
import { useTargets } from "../useTargets.ts";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader, type BreadcrumbEntry } from "./AppHeader.tsx";
import { AppSidebar } from "./AppSidebar.tsx";
import { LoadFailed, LoadingState, NoEnvironments } from "./PageStates.tsx";

export function App() {
  const route = useRoute();
  const { targets, problem, refreshing, refresh } = useTargets();
  const { preferences, updatePreferences, saved } = usePreferences();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
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

  const selected = targets?.find((t) => t.id === route.targetId) ?? targets?.[0];

  useEffect(() => {
    if (route.targetId === undefined && selected !== undefined)
      navigate({ targetId: selected.id });
  }, [route.targetId, selected]);

  const manifest = selected?.manifest;
  const operation = manifest?.operations.find((o) => o.id === route.operationId);
  const breadcrumb: BreadcrumbEntry[] = selected === undefined
    ? [{ label: "Gauntlet" }]
    : [{ label: selected.label, ...(route.operationId === undefined ? {} : { route: { targetId: selected.id } }) }];
  if (selected !== undefined && route.operationId !== undefined) {
    if (operation !== undefined) {
      const feature = manifest?.features.find((f) => f.id === operation.featureId);
      breadcrumb.push({ label: feature?.label ?? "Other" });
    }
    breadcrumb.push({ label: operation?.label ?? route.operationId });
  }

  return (
    <SidebarProvider
      open={!preferences.sidebarCollapsed}
      onOpenChange={(open) => updatePreferences({ sidebarCollapsed: !open })}
      className="h-svh min-h-0"
    >
      <AppSidebar
        targets={targets}
        selected={selected}
        route={route}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/* Not `SidebarInset`: that renders a `main`, and the header belongs outside the main landmark. */}
      <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
        <AppHeader
          breadcrumb={breadcrumb}
          onSearch={() => setSearchOpen(true)}
          searchRef={searchTriggerRef}
        />
        <main
          id="workspace"
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden ${route.operationId === undefined ? "overflow-y-auto" : "overflow-y-hidden"}`}
        >
          {problem !== undefined && <LoadFailed problem={problem} refreshing={refreshing} onRetry={refresh} />}
          {problem === undefined && targets === undefined && <LoadingState />}
          {problem === undefined && targets !== undefined && targets.length === 0 && <NoEnvironments />}
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
      </div>
      <GlobalSearch
        targets={targets}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        triggerRef={searchTriggerRef}
      />
      <UserSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        preferences={preferences}
        onChange={updatePreferences}
        saved={saved}
      />
    </SidebarProvider>
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
