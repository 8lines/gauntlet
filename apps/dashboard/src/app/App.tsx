import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { JsonObject, Problem } from "@8lines/gauntlet-protocol";
import { ProblemAlert } from "@/components/gauntlet/ProblemAlert";
import { navigate, parseRoute, useRoute } from "../route.ts";
import { usePreferences } from "../preferences.ts";
import { OverviewScreen } from "../screens/OverviewScreen.tsx";
import { rememberRun } from "../recent-runs.ts";
import { browserStorage } from "../browser-storage.ts";
import { useTargets } from "../useTargets.ts";
import { usePins } from "../usePins.ts";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader, type BreadcrumbEntry } from "./AppHeader.tsx";
import { AppSidebar } from "./AppSidebar.tsx";
import { CommandSearch } from "./CommandSearch.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { LoadFailed, LoadingState, NoEnvironments, SessionLoadFailed, SessionLoading } from "./PageStates.tsx";
import { LoginScreen } from "./LoginScreen.tsx";
import { needsSignIn, useAuthSession } from "./useAuthSession.ts";
import type { AuthSession } from "../auth.ts";
import { ChunkErrorBoundary } from "@/components/gauntlet/ChunkErrorBoundary";
import { OperationLoading } from "@/components/gauntlet/OperationLoading";

const OperationScreen = lazy(() => import("../screens/OperationScreen.tsx").then((m) => ({ default: m.OperationScreen })));

export function App() {
  const auth = useAuthSession();
  if (auth.state.status === "loading") return <SessionLoading />;
  if (auth.state.status === "failed") return <SessionLoadFailed problem={auth.state.problem} onRetry={auth.retry} />;
  if (needsSignIn(auth.state.session)) return <LoginScreen session={auth.state.session} onSignedIn={auth.signedIn} />;
  return <AuthenticatedApp session={auth.state.session} onSignOut={auth.signOut} />;
}

/** The dashboard itself; it mounts only once Gauntlet accepts the session, so nothing loads before sign-in. */
function AuthenticatedApp({ session, onSignOut }: { session: AuthSession; onSignOut: () => Promise<Problem | undefined> }) {
  const route = useRoute();
  const [logoutProblem, setLogoutProblem] = useState<Problem | undefined>(undefined);
  const signOut = async () => setLogoutProblem(await onSignOut());
  const { targets, problem, refreshing, refresh } = useTargets();
  const { preferences, updatePreferences, saved } = usePreferences();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /* Bumped when a run is remembered, so an overview already on screen lists it. */
  const [recentRunsVersion, setRecentRunsVersion] = useState(0);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const settingsOpener = useRef<HTMLElement | null>(null);
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
  const pins = usePins(selected?.id);

  useEffect(() => {
    // Replace, not push: Back from the first environment must not land on "/" and redirect again.
    if (route.targetId === undefined && selected !== undefined)
      navigate({ targetId: selected.id }, { replace: true });
  }, [route.targetId, selected]);

  const manifest = selected?.manifest;
  const operation = manifest?.operations.find((o) => o.id === route.operationId);
  const breadcrumb: BreadcrumbEntry[] = selected === undefined
    ? [{ label: "Gauntlet" }]
    : [{ label: selected.label, ...(route.operationId === undefined ? {} : { route: { targetId: selected.id } }) }];
  if (selected !== undefined && route.operationId === undefined) breadcrumb.push({ label: "Overview" });
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
        pins={pins}
        navigationToggle={navigationToggle}
        principal={session.mode === "none" ? undefined : session.principal ?? undefined}
        onSignOut={signOut}
        onOpenSettings={(opener) => {
          settingsOpener.current = opener;
          setSettingsOpen(true);
        }}
      />
      {/* Not `SidebarInset`: that renders a `main`, and the header belongs outside the main landmark. */}
      <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
        <AppHeader breadcrumb={breadcrumb} onSearch={() => setSearchOpen(true)} triggerRef={navigationToggle} />
        <main
          id="workspace"
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden ${route.operationId === undefined ? "overflow-y-auto" : "overflow-y-hidden"}`}
        >
          {logoutProblem !== undefined && (
            <div className="shrink-0 px-4 pt-4 sm:px-8">
              <ProblemAlert problem={logoutProblem} title="Could not log out" />
            </div>
          )}
          {problem !== undefined && (targets === undefined || targets.length === 0) && <LoadFailed problem={problem} refreshing={refreshing} onRetry={refresh} />}
          {problem === undefined && targets === undefined && <LoadingState />}
          {problem === undefined && targets !== undefined && targets.length === 0 && <NoEnvironments />}
          {selected !== undefined && route.operationId === undefined && (
            <OverviewScreen
              key={selected.id}
              target={selected}
              recentRunsVersion={recentRunsVersion}
              refreshing={refreshing}
              refreshProblem={problem}
              onRefresh={refresh}
            />
          )}
          {selected !== undefined && route.operationId !== undefined && (
            <ChunkErrorBoundary resetKey={`${selected.id}:${route.operationId}:${navigationInput.key}`}>
              <Suspense fallback={<OperationLoading />}>
                <OperationScreen
                  key={`${selected.id}:${route.operationId}:${navigationInput.key}`}
                  targetId={selected.id}
                  operationId={route.operationId}
                  runId={route.runId}
                  revision={selected.manifest?.operations.find((o) => o.id === route.operationId)?.revision}
                  environment={selected.label}
                  recentRunsVersion={recentRunsVersion}
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
                    setRecentRunsVersion((version) => version + 1);
                    // The run may be created after the user moved on (another screen, another run);
                    // only a user still on this operation's form is taken to the run's URL.
                    const current = parseRoute(globalThis.location.pathname);
                    if (current.targetId === route.targetId && current.operationId === operationId && current.runId === undefined)
                      navigate({ targetId: selected.id, operationId, runId: run.id }, { replace: true });
                  }}
                  onRunCleared={() => navigate({ targetId: selected.id, operationId: route.operationId! }, { replace: true })}
                />
              </Suspense>
            </ChunkErrorBoundary>
          )}
        </main>
      </div>
      <CommandSearch targets={targets} open={searchOpen} onOpenChange={setSearchOpen} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        opener={settingsOpener}
        preferences={preferences}
        onChange={updatePreferences}
        saved={saved}
        authenticated={session.mode !== "none"}
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
