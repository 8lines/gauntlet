import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationSummary, Run } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { describeProblem } from "../copy.ts";
import { OperationScreen } from "../screens/OperationScreen.tsx";
import { BackBar } from "./BackBar.tsx";
import { OperationLists } from "./OperationLists.tsx";
import { PanelHeader } from "./PanelHeader.tsx";
import { PanelNotice, TargetProblem } from "./PanelNotice.tsx";
import { subjectChip } from "./placements.ts";
import type { BindingValue } from "./prefill.ts";
import { RecentRunView } from "./RecentRunView.tsx";
import { readRecentRuns, rememberRun } from "../recent-runs.ts";
import { browserStorage } from "../browser-storage.ts";
import { usePanelCatalog } from "./usePanelCatalog.ts";
import { usePanelChannel, type PanelChannel, type PanelChannelState } from "./usePanelChannel.ts";
import { usePanelTarget } from "./usePanelTarget.ts";
import { openOperationView, pageSubjectDrifted, reseedOperationView, runCreatedIn, type OperationView, type View } from "./view.ts";

const NOT_CONNECTED: Readonly<Record<Exclude<PanelChannelState["kind"], "connected">, { title: string; detail?: string }>> = {
  // Framed and waiting for the loader's connect: normally a split second.
  waiting: { title: "Connecting…" },
  standalone: {
    title: "Open Gauntlet through the widget in your application",
    detail: "This panel works inside an application that embeds the Gauntlet widget.",
  },
  unavailable: {
    title: "Cannot connect to Gauntlet",
    detail: "Could not load the widget configuration from the Gauntlet server.",
  },
  rejected: {
    title: "Gauntlet rejected this application",
    detail: "This application is not configured to open Gauntlet.",
  },
};

/** The embedded panel: channel state, header, and navigation between lists, an operation and a run. */
export function Panel() {
  const channel = usePanelChannel();
  const { close } = channel;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (channel.state.kind !== "connected") {
    const notice = NOT_CONNECTED[channel.state.kind];
    return (
      <div className="flex h-full flex-col bg-canvas">
        <PanelHeader snapshot={undefined} onClose={close} />
        <PanelNotice title={notice.title} detail={notice.detail} />
      </div>
    );
  }
  return <ConnectedPanel channel={channel} targetId={channel.state.target} />;
}

function ConnectedPanel({ channel, targetId }: { channel: PanelChannel; targetId: string }) {
  const { context, openCount, sendState, close, setExpanded } = channel;
  const { target, operations, refreshProblem } = usePanelTarget(targetId, openCount);
  const [query, setQuery] = useState("");
  const catalog = usePanelCatalog(targetId, operations, context, query);
  const [view, setView] = useState<View>({ kind: "lists" });
  const [recent, setRecent] = useState(() => readRecentRuns(browserStorage));
  const searchRef = useRef<HTMLInputElement>(null);

  const resolved = target.kind !== "loading";
  const { contextual, global } = catalog.lists;
  useEffect(() => {
    if (resolved) sendState({ contextualCount: contextual.length, globalCount: global.length });
  }, [resolved, contextual.length, global.length, context, operations, sendState]);

  const expanded = view.kind !== "lists" && view.runShown;
  useEffect(() => { setExpanded(expanded); }, [expanded, setExpanded]);

  // `gauntlet:open` focuses search only on the lists; an open form keeps its focus and state.
  const viewKindRef = useRef(view.kind);
  viewKindRef.current = view.kind;
  useEffect(() => {
    if (openCount > 0 && viewKindRef.current === "lists") searchRef.current?.focus();
  }, [openCount]);

  // The view freezes the page subject and its bindings, so later SPA navigation cannot switch the form's subject.
  const openOperation = (operation: OperationSummary) =>
    setView(openOperationView(targetId, operation, catalog.subjectOf(operation.id), catalog.bindingsFor(operation.id)));
  const backToLists = () => setView({ kind: "lists" });
  const onRunCreated = (operation: OperationSummary) => (run: Run) => {
    setRecent(rememberRun(browserStorage, {
      targetId,
      operationId: operation.id,
      label: operation.label,
      runId: run.id,
      startedAt: run.startedAt ?? run.createdAt,
    }));
    // The request is async: the user may have left this operation before the run came back.
    setView((current) => runCreatedIn(current, targetId, operation.id));
  };
  const setRunShown = useCallback((runShown: boolean) => {
    setView((current) => (current.kind === "lists" || current.runShown === runShown ? current : { ...current, runShown }));
  }, []);

  const snapshot = target.kind === "found" ? target.snapshot : undefined;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <PanelHeader
        snapshot={snapshot}
        search={snapshot === undefined
          ? undefined
          // Searching from an open operation would discard its form, so search waits for "Back".
          : { query, onQuery: setQuery, inputRef: searchRef, disabled: view.kind !== "lists" }}
        onClose={close}
      />
      <main className="@container/workspace flex min-h-0 flex-1 flex-col">
        {refreshProblem !== undefined && snapshot !== undefined && (
          <p role="status" className="shrink-0 border-b border-wait-bd bg-wait-bg px-4 py-2 text-[12px] text-wait">
            Could not refresh the catalog: {describeProblem(refreshProblem).title}. Showing the last known state.
          </p>
        )}
        {target.kind === "loading" && <p className="p-6 text-[13px] text-muted-foreground">Loading catalog…</p>}
        {target.kind === "unknown" && (
          <PanelNotice
            tone="stop" icon="warning"
            title={`Unknown target ${targetId}`}
            detail="Check the target ID in the widget boot call and in the Gauntlet configuration."
          />
        )}
        {target.kind === "error" && (
          <PanelNotice
            tone="stop" icon="warning"
            title={describeProblem(target.problem).title}
            detail={describeProblem(target.problem).advice}
          />
        )}
        {snapshot !== undefined && view.kind === "lists" && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TargetProblem snapshot={snapshot} />
            <OperationLists
              targetId={targetId}
              query={query}
              lists={catalog.lists}
              results={catalog.results}
              recent={recent.filter((entry) => entry.targetId === targetId)}
              describe={catalog.describe}
              subjectOf={catalog.subjectOf}
              onOpenOperation={openOperation}
              onOpenRun={(entry) => setView({ kind: "run", entry, runShown: false })}
            />
          </div>
        )}
        {snapshot !== undefined && view.kind === "operation" && (
          <>
            <BackBar onBack={backToLists} targetId={targetId} operationId={view.operation.id} />
            <PageSubjectDrift
              view={view}
              current={catalog.subjectOf(view.operation.id)}
              currentBindings={catalog.bindingsFor(view.operation.id)}
              onUseCurrent={(subject, bindings) => setView((current) => (
                current.kind === "operation" && current.operation.id === view.operation.id
                  ? reseedOperationView(current, subject, bindings)
                  : current
              ))}
            />
            <OperationScreen
              key={view.operation.id}
              targetId={targetId}
              operationId={view.operation.id}
              bindings={view.bindings}
              onRunCreated={onRunCreated(view.operation)}
              onRunCleared={() => setRunShown(false)}
            />
          </>
        )}
        {snapshot !== undefined && view.kind === "run" && (
          <>
            <BackBar onBack={backToLists} targetId={targetId} operationId={view.entry.operationId} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <RecentRunView
                entry={view.entry}
                onResultShown={setRunShown}
                onRunAgain={() => {
                  const operation = operations.find((candidate) => candidate.id === view.entry.operationId);
                  if (operation === undefined) backToLists();
                  else openOperation(operation);
                }}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Shown above an open operation when the page has moved on to another subject: the form keeps
 * the values it was opened with until the user explicitly takes the current page's.
 */
function PageSubjectDrift({ view, current, currentBindings, onUseCurrent }: {
  view: OperationView;
  current: PageSubject | undefined;
  currentBindings: readonly BindingValue[] | undefined;
  onUseCurrent: (subject: PageSubject, bindings: readonly BindingValue[]) => void;
}) {
  if (!pageSubjectDrifted(view.subject, current, currentBindings) || current === undefined || currentBindings === undefined) {
    return null;
  }
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-wait-bd bg-wait-bg px-4 py-2 text-[12px] text-wait">
      <p className="min-w-0 flex-1">
        The page now shows <span className="font-medium">{subjectChip(current)}</span>.{" "}
        {view.subject === undefined
          ? "The form has no values from the page."
          : <>The form has values for <span className="font-medium">{subjectChip(view.subject)}</span>.</>}
      </p>
      <button
        type="button"
        onClick={() => onUseCurrent(current, currentBindings)}
        className="shrink-0 rounded-control border border-wait-bd bg-background px-2 py-1 font-medium text-foreground hover:bg-accent"
      >
        Use values from the page
      </button>
    </div>
  );
}
