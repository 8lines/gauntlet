import { useId, useMemo, useRef } from "react";
import type { JsonObject, Run } from "@8lines/gauntlet-protocol";
import { CircleX, FlaskConical, Lock } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "../components/gauntlet/EmptyState.tsx";
import { OperationLoading } from "@/components/gauntlet/OperationLoading";
import { ImpactBadge } from "../components/gauntlet/ImpactBadge.tsx";
import { OperationForm } from "../components/gauntlet/operation-form/OperationForm.tsx";
import { PolicyList } from "../components/gauntlet/PolicyList.tsx";
import { ProblemAlert } from "../components/gauntlet/ProblemAlert.tsx";
import { RunView } from "../components/gauntlet/RunView.tsx";
import { policyEffects, runButtonLabel } from "../copy.ts";
import { generalErrors } from "../operation-errors.ts";
import { navigate } from "../route.ts";
import type { BindingValue } from "../widget/prefill.ts";
import { useOperationRun } from "./useOperationRun.ts";

/** Radix Select forbids "" as an item value, so "Empty form" uses a sentinel. */
const EMPTY_FORM = "gauntlet:empty-form";

export function OperationScreen(
  { targetId, operationId, runId, environment, initialInput, onInitialInputConsumed, bindings, onRunCreated, onRunCleared }: {
    targetId: string;
    operationId: string;
    /** The run named by the URL; the widget never passes it. */
    runId?: string | undefined;
    /** Environment label shown in the action bar ("in Shop staging"). */
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
    targetId, operationId, runId, initialInput, onInitialInputConsumed, bindings, onRunCreated, onRunCleared,
  });
  const { definition, problem, run, errors, locked, skipped } = state;
  const presetFieldId = useId();
  /* The dialog opens without a Radix trigger, so focus is returned to the button that opened it by hand. */
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);

  const effects = useMemo(
    () => (definition === undefined ? [] : policyEffects(definition.execution)),
    [definition],
  );

  if (problem !== undefined) {
    return (
      <div className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-8 sm:py-8">
        <ProblemAlert problem={problem} title="Could not open this operation" />
      </div>
    );
  }

  if (definition === undefined) return <OperationLoading />;

  const destructive = definition.execution.impact === "destructive";
  const presets = definition.presets ?? [];
  const preset = presets.find((p) => p.id === state.presetId);
  const general = generalErrors(errors);
  const label = runButtonLabel(definition);

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

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-8 px-4 py-6 sm:px-8 sm:py-8">
          <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="min-w-0 text-2xl/8 font-semibold break-words">{definition.label}</h1>
                <ImpactBadge impact={definition.execution.impact} />
              </div>
              <p
                className="font-mono text-xs/4 break-all text-muted-foreground"
                title={`The run will be pinned to this definition revision: ${definition.revision}`}
              >
                {definition.id}
              </p>
              {definition.description !== undefined && (
                <p className="max-w-[68ch] text-sm/5 text-muted-foreground">{definition.description}</p>
              )}
            </div>

            {presets.length > 0 && (
              <div className="flex w-full shrink-0 flex-col gap-2 lg:w-80">
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
          </header>

          <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)] xl:gap-12">
            <div className="flex min-w-0 flex-col gap-6">
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

              <Card className="gap-0 py-0">
                <CardHeader className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-6">
                  <h2 className="text-base/6 font-semibold">Input</h2>
                  <CardDescription className="text-[13px]/[18px]">Fields marked * are required.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6 p-6">
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
              </Card>
            </div>

            <aside
              aria-label="Execution policy and result"
              className="flex min-w-0 flex-col gap-8 xl:sticky xl:top-6 xl:self-start"
            >
              <section aria-labelledby={`${presetFieldId}-policy`} className="flex flex-col gap-3">
                <h2 id={`${presetFieldId}-policy`} className="text-base/6 font-semibold">What this operation does</h2>
                <PolicyList effects={effects} />
              </section>

              <section aria-labelledby={`${presetFieldId}-result`} className="flex flex-col gap-3 border-t pt-4">
                <h2 id={`${presetFieldId}-result`} className="text-base/6 font-semibold">Result</h2>
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
              </section>
            </aside>
          </div>
        </div>
      </div>

      <footer
        role="region"
        aria-label="Operation actions"
        className="flex shrink-0 flex-col gap-3 border-t bg-background px-4 py-3 sm:min-h-16 sm:flex-row sm:items-center sm:px-8"
      >
        <div className="hidden min-w-0 flex-1 sm:block">
          <p className="truncate text-sm/5 font-medium" title={definition.label}>{definition.label}</p>
          {environment !== undefined && (
            <p className="truncate text-[13px]/[18px] text-muted-foreground">in {environment}</p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end">
          {definition.execution.dryRunSupported && (
            <Button
              variant="outline"
              className="h-11 w-full sm:h-9 sm:w-auto"
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
            className="h-11 w-full min-w-0 shrink aria-disabled:pointer-events-none aria-disabled:opacity-50 sm:h-9 sm:w-auto"
            disabled={state.uploadPending}
            aria-disabled={state.submitting || undefined}
            onClick={() => { if (!state.submitting) state.attempt(false); }}
          >
            <span className="truncate">{state.submitting ? "Sending" : label}</span>
          </Button>
        </div>
      </footer>
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
