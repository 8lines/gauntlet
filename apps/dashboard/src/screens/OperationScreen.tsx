import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JsonObject, Run } from "@8lines/gauntlet-protocol";
import { CircleX, FlaskConical, Info, Lock, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "../components/gauntlet/EmptyState.tsx";
import { OperationLoading } from "@/components/gauntlet/OperationLoading";
import { ImpactBadge } from "../components/gauntlet/ImpactBadge.tsx";
import { OperationForm } from "../components/gauntlet/operation-form/OperationForm.tsx";
import {
  DetailSection,
  HISTORY_HINT,
  OperationBehavior,
  OperationDefinitionInfo,
  OperationDetails,
  OperationHistory,
} from "../components/gauntlet/OperationDetails.tsx";
import type { RecentRun } from "../recent-runs.ts";
import { PolicyList } from "../components/gauntlet/PolicyList.tsx";
import { ProblemAlert } from "../components/gauntlet/ProblemAlert.tsx";
import { RunView } from "../components/gauntlet/RunView.tsx";
import { policyEffects } from "../copy.ts";
import { generalErrors } from "../operation-errors.ts";
import { navigate } from "../route.ts";
import type { BindingValue } from "../widget/prefill.ts";
import { useOperationRun } from "./useOperationRun.ts";

/** Radix Select forbids "" as an item value, so "Empty form" uses a sentinel. */
const EMPTY_FORM = "gauntlet:empty-form";

export function OperationScreen(
  { targetId, operationId, runId, revision, environment, initialInput, onInitialInputConsumed, bindings, onRunCreated, onRunCleared, recentRunsVersion = 0, compact = false, onOpenRecentRun }: {
    recentRunsVersion?: number;
    /** The embedded widget uses a compact workspace and opens history inside its panel. */
    compact?: boolean;
    onOpenRecentRun?: ((entry: RecentRun) => void) | undefined;
    targetId: string;
    operationId: string;
    /** The run named by the URL; the widget never passes it. */
    runId?: string | undefined;
    /** The operation's revision in the current manifest; lets the form open from the cached definition. */
    revision?: string | undefined;
    /** Environment label shown in the operation details. */
    environment?: string | undefined;
    initialInput?: JsonObject;
    onInitialInputConsumed?: (() => void) | undefined;
    /**
     * Values from the page embedding the widget (placement bindings), applied over the defaults and the preset.
     * The panel freezes them when the operation opens; a new array (e.g. "Use values from the page")
     * is applied over the current form, skipping fields locked by the selected preset.
     */
    bindings?: readonly BindingValue[] | undefined;
    onRunCreated?: ((run: Run) => void) | undefined;
    /** The result left the view ("Run again"); the form is once again the only content. */
    onRunCleared?: (() => void) | undefined;
  },
) {
  const state = useOperationRun({
    targetId, operationId, runId, revision, initialInput, onInitialInputConsumed, bindings, onRunCreated, onRunCleared,
  });
  const { definition, problem, run, errors, locked, skipped } = state;
  const presetFieldId = useId();
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [wide, setWide] = useState(() => globalThis.matchMedia("(min-width: 1280px)").matches);
  const detailsTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = globalThis.matchMedia("(min-width: 1280px)");
    const change = () => { setWide(media.matches); if (media.matches && !compact) setMobileDetailsOpen(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [compact]);
  const dockedDetails = wide && !compact;

  /* The dialog opens without a Radix trigger, so focus is returned to the button that opened it by hand. */
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);

  const effects = useMemo(
    () => (definition === undefined ? [] : policyEffects(definition.execution)),
    [definition],
  );

  if (problem !== undefined) {
    return (
      <div className="mx-auto w-full px-4 py-6 sm:px-8 sm:py-8">
        <ProblemAlert problem={problem} title="Could not open this operation" />
      </div>
    );
  }

  if (definition === undefined) return <OperationLoading compact={compact} />;

  const destructive = definition.execution.impact === "destructive";
  const presets = definition.presets ?? [];
  const preset = presets.find((p) => p.id === state.presetId);
  const general = generalErrors(errors);
  const label = "Execute";

  const workspace = (
    <div className={`grid items-stretch gap-5 p-4 sm:p-6 ${compact ? "" : "min-h-full @min-[640px]:h-full @min-[640px]:min-h-0 @min-[640px]:grid-cols-2"}`}>
      <div className="flex min-h-0 min-w-0 flex-col gap-5">
        {errors.length > 0 && (
          <Alert className="border-err">
            <CircleX className="text-err" aria-hidden="true" />
            <AlertTitle className="line-clamp-none text-sm/5 font-medium">Fix the input</AlertTitle>
            <AlertDescription className="max-w-[68ch] text-sm/5">
              <p>Nothing was sent to the application. The form is filled in just as you left it.</p>
              {general.length > 0 && (
                <>
                  <ul className="list-disc pl-5 text-foreground">
                    {general.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                  <p>
                    The application did not say which fields these errors refer to. Check the fields marked as required.
                  </p>
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Card role="region" aria-labelledby={`${presetFieldId}-input`} className={`min-h-80 min-w-0 flex-1 gap-0 py-0 ${compact ? "" : "@min-[640px]:min-h-0"}`}>
          <CardHeader className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-4 [.border-b]:pb-4">
            <h2 id={`${presetFieldId}-input`} className="text-sm/5 font-semibold">Input</h2>
            <CardDescription className="text-[13px]/[18px]">Fields marked * are required.</CardDescription>
          </CardHeader>
          <CardContent className={`flex flex-1 flex-col gap-6 p-5 ${compact ? "" : "@min-[640px]:min-h-0 @min-[640px]:overflow-y-auto"}`}>
            {presets.length > 0 && (
              <div className="flex min-w-0 flex-col gap-2 border-b pb-5">
                <Label htmlFor={presetFieldId} className="text-sm/5 font-medium">Start from a preset</Label>
                <Select
                  value={state.presetId ?? EMPTY_FORM}
                  onValueChange={(value) => state.applyPreset(value === EMPTY_FORM ? undefined : value)}
                >
                  <SelectTrigger id={presetFieldId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY_FORM}>Empty form</SelectItem>
                    {presets.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {preset?.description !== undefined && (
                  <p className="text-[13px]/[18px] text-muted-foreground">{preset.description}</p>
                )}
                {locked.length > 0 && (
                  <div className="flex flex-col gap-1 text-[13px]/[18px]">
                    <p className="flex items-center gap-1.5">
                      <Lock className="size-3" aria-hidden="true" />
                      This preset locks {locked.length === 1 ? "one field" : `${locked.length} fields`}.
                    </p>
                    <p className="text-muted-foreground">To unlock them, choose the empty form.</p>
                  </div>
                )}
              </div>
            )}
            {skipped.length > 0 && (
              <ul className="flex flex-col gap-1">
                {skipped.map((pointer) => (
                  <li key={pointer} className="text-[13px]/[18px] text-muted-foreground">
                    Field <span className="font-mono">{pointer}</span> is set by the preset. The value from the page was skipped.
                  </li>
                ))}
              </ul>
            )}
            <OperationForm
              definition={definition} targetId={targetId} values={state.values}
              errors={errors} lockedPointers={locked} fileStates={state.fileStates}
              onChange={state.setValues} onFileState={state.setFileState}
            />
          </CardContent>
          <footer
            role="region"
            aria-label="Operation actions"
            className="sticky bottom-0 z-10 mt-auto shrink-0 rounded-b-xl border-t bg-card p-5"
          >
            <div className="flex min-w-0 flex-col gap-2 @min-[640px]:flex-row @min-[640px]:justify-end">
              {definition.execution.dryRunSupported && (
                <Button
                  variant="outline"
                  className="h-11 w-full shrink-0 @min-[640px]:h-9 @min-[640px]:w-auto"
                  disabled={state.submitting || state.uploadPending}
                  onClick={() => state.attempt(true)}
                >
                  <FlaskConical aria-hidden="true" />
                  Dry run
                </Button>
              )}
              {/*
                * While a run is being sent the button stays focusable (`aria-disabled`, not `disabled`):
                * confirming in the dialog returns focus here, and a disabled button would drop it to <body>.
                */}
              <Button
                ref={confirmationTriggerRef}
                variant={destructive ? "destructive" : "default"}
                className="h-11 w-full min-w-0 shrink aria-disabled:pointer-events-none aria-disabled:opacity-50 @min-[640px]:h-9 @min-[640px]:w-auto"
                disabled={state.uploadPending}
                aria-disabled={state.submitting || undefined}
                onClick={() => { if (!state.submitting) state.attempt(false); }}
              >
                <span className="truncate">{state.submitting ? "Sending" : label}</span>
              </Button>
            </div>
          </footer>
        </Card>
      </div>

      <Card role="region" aria-labelledby={`${presetFieldId}-result`} className={`min-h-80 min-w-0 gap-0 py-0 ${compact ? "" : "@min-[640px]:min-h-0"}`}>
        <CardHeader className="flex shrink-0 border-b px-5 py-4 [.border-b]:pb-4">
          <h2 id={`${presetFieldId}-result`} className="text-sm/5 font-semibold">Result</h2>
        </CardHeader>
        <CardContent className={`flex min-w-0 flex-1 flex-col p-5 ${compact ? "" : "@min-[640px]:min-h-0 @min-[640px]:overflow-y-auto"}`}>
          <ResultArea
            targetId={targetId}
            operationId={operationId}
            runId={runId}
            run={run}
            runMissing={state.runMissing}
            runProblem={state.runProblem}
            onCancel={definition.execution.cancellationSupported ? state.cancelRun : undefined}
            onRunAgain={state.runAgain}
          />
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AlertDialog open={state.awaitingConfirmation} onOpenChange={(open) => { if (!open) state.cancelConfirmation(); }}>
        <AlertDialogContent
          className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto"
          onCloseAutoFocus={(event) => { event.preventDefault(); confirmationTriggerRef.current?.focus(); }}
        >
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle className="text-xl/7 font-semibold">Run {definition.label}?</AlertDialogTitle>
            <AlertDialogDescription className="text-sm/5">
              The application marked this operation as requiring confirmation. Before it starts:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="border-y py-4">
            <PolicyList effects={effects} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={state.confirm}>
              {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <header data-operation-header className="flex shrink-0 items-start justify-between gap-4 border-b px-4 py-4 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="line-clamp-2 min-w-0 text-xl/7 font-semibold break-words" title={definition.label}>{definition.label}</h1>
            <ImpactBadge impact={definition.execution.impact} />
          </div>
          <p className="truncate font-mono text-xs/4 text-muted-foreground" title={`${definition.id} · Definition revision: ${definition.revision}`}>{definition.id}</p>
        </div>
        {!compact && (
          <Button
            ref={detailsTriggerRef}
            variant="outline" size="icon-sm" className="shrink-0"
            aria-label={dockedDetails && detailsOpen ? "Hide details" : "Show details"}
            title={dockedDetails && detailsOpen ? "Hide details" : "Show details"}
            aria-expanded={dockedDetails ? detailsOpen : mobileDetailsOpen}
            aria-controls={dockedDetails && detailsOpen ? `${presetFieldId}-details` : undefined}
            aria-haspopup={dockedDetails ? undefined : "dialog"}
            onClick={() => dockedDetails ? setDetailsOpen((open) => !open) : setMobileDetailsOpen(true)}
          >
            {dockedDetails && detailsOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
          </Button>
        )}
      </header>

      {compact ? (
        <div className="@container min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-muted/30">
          <DetailSection title="What this operation does" icon={<Info />} className="border-b bg-background px-4 py-3">
            <OperationBehavior definition={definition} />
          </DetailSection>
          <Tabs defaultValue="run" className="gap-0">
            <TabsList variant="line" className="sticky top-0 z-20 h-10 w-full justify-start gap-4 rounded-none border-b bg-background px-4 py-0">
              <TabsTrigger value="run" className="flex-none px-0">Run</TabsTrigger>
              <TabsTrigger value="advanced" className="flex-none px-0">Advanced</TabsTrigger>
            </TabsList>
            {/* Kept mounted while "Advanced" is shown, so the form keeps every bit of its state. */}
            <TabsContent value="run" forceMount className="data-[state=inactive]:hidden">
              {workspace}
              <div className="px-4 pb-4 sm:px-6 sm:pb-6">
                <Card role="region" aria-labelledby={`${presetFieldId}-history`} className="min-w-0 gap-0 py-0">
                  <CardHeader className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-4 [.border-b]:pb-4">
                    <h2 id={`${presetFieldId}-history`} className="text-sm/5 font-semibold">Your recent runs</h2>
                    <CardDescription className="text-[13px]/[18px]">{HISTORY_HINT}</CardDescription>
                  </CardHeader>
                  <CardContent className="px-5 py-2">
                    <OperationHistory
                      definition={definition} targetId={targetId} recentRunsVersion={recentRunsVersion}
                      currentRunId={run?.id ?? runId} onOpenRun={onOpenRecentRun}
                    />
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
            <TabsContent value="advanced" className="p-4 sm:p-6">
              <Card className="min-w-0 gap-4 p-5">
                <OperationDefinitionInfo definition={definition} targetId={targetId} environment={environment} />
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="@container min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-muted/30">
            {workspace}
          </div>
          {dockedDetails && (
            <div className={`flex min-h-0 shrink-0 overflow-hidden transition-[width] duration-150 ease-out ${detailsOpen ? "w-80" : "w-0"}`}>
              {detailsOpen && <aside id={`${presetFieldId}-details`} aria-label="Operation details" className="flex w-80 min-w-80 shrink-0 animate-in flex-col border-l bg-background fade-in-0 slide-in-from-right-2 duration-150">
                <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
                  <p className="text-sm/5 font-semibold">Operation details</p>
                  <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={() => { setDetailsOpen(false); detailsTriggerRef.current?.focus(); }}><X aria-hidden="true" /></Button>
                </div>
                <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                  <OperationDetails definition={definition} targetId={targetId} environment={environment} recentRunsVersion={recentRunsVersion} currentRunId={run?.id ?? runId} onOpenRun={onOpenRecentRun} />
                </div>
              </aside>}
            </div>
          )}
        </div>
      )}
      {!compact && <Sheet open={mobileDetailsOpen} onOpenChange={setMobileDetailsOpen}>
        <SheetContent className="w-[min(100%,360px)] gap-0" onCloseAutoFocus={(event) => { event.preventDefault(); detailsTriggerRef.current?.focus(); }}>
          <SheetHeader className="shrink-0 border-b px-5 pr-12">
            <SheetTitle>Operation details</SheetTitle>
            <SheetDescription className="sr-only">Operation behavior, your recent runs and technical definition.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <OperationDetails definition={definition} targetId={targetId} environment={environment} recentRunsVersion={recentRunsVersion} currentRunId={run?.id ?? runId} onOpenRun={onOpenRecentRun} onNavigate={() => setMobileDetailsOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>}
    </div>
  );
}

function ResultArea(
  { targetId, operationId, runId, run, runMissing, runProblem, onCancel, onRunAgain }: {
    targetId: string;
    operationId: string;
    runId: string | undefined;
    run: Run | undefined;
    runMissing: boolean;
    runProblem: ReturnType<typeof useOperationRun>["runProblem"];
    onCancel: (() => void) | undefined;
    onRunAgain: () => void;
  },
) {
  if (runMissing) {
    return (
      <EmptyState
        title="This run is no longer available"
        description="Gauntlet no longer has this run, for example after a restart. Start a new run from the form."
        action={(
          <Button variant="outline" onClick={() => navigate({ targetId, operationId }, { replace: true })}>
            Back to the form
          </Button>
        )}
      />
    );
  }
  // A failed load of the run in the URL wins over any run still held from before the URL changed.
  if (runProblem !== undefined) return <ProblemAlert problem={runProblem} title="Could not load this run" />;
  // `run` is only ever the run the URL names (or, without a run id, the one just started).
  if (run !== undefined && (runId === undefined || run.id === runId)) {
    return <RunView targetId={targetId} run={run} onCancel={onCancel} onRunAgain={onRunAgain} />;
  }
  if (runId !== undefined) {
    return (
      <div className="flex flex-col gap-2" role="status">
        <span className="sr-only">Loading the run</span>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  return (
    <EmptyState
      title="Nothing has run yet"
      description="The result will appear here when the run finishes. Your input stays in place, so fixing it and running again takes one click."
    />
  );
}
