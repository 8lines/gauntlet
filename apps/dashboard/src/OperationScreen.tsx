import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JsonObject, JsonPointer, OperationDefinition, Problem, Run, ValidationError } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "./api.ts";
import { buildCreateRunRequest } from "./create-run-request.ts";
import { OperationForm } from "./components/gauntlet/operation-form/OperationForm.tsx";
import type { FileFieldState } from "./form-upload.ts";
import { RunView } from "./components/gauntlet/RunView.tsx";
import { Card, EffectList, Badge, ConfirmDialog, Button, EmptyState } from "./ui.tsx";
import { runButtonLabel, describeProblem, policyEffects, impactLabel } from "./copy.ts";
import { Icon } from "./Icon.tsx";
import { initialValues } from "./json-pointer.ts";
import { attachToFields, generalErrors } from "./operation-errors.ts";
import { applyBindings, prefillForPreset, restoreSkippedBindings, type BindingValue } from "./widget/prefill.ts";

const IMPACT_TONES = { read: "ok", write: "wait", destructive: "stop" } as const;

export function OperationScreen(
  { targetId, operationId, initialInput, onInitialInputConsumed, bindings, onRunCreated, onRunCleared }: {
    targetId: string;
    operationId: string;
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
  const [definition, setDefinition] = useState<OperationDefinition>();
  const [problem, setProblem] = useState<Problem>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [presetId, setPresetId] = useState<string>();
  const [errors, setErrors] = useState<readonly ValidationError[]>([]);
  const [run, setRun] = useState<Run>();
  const [submitting, setSubmitting] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [fileStates, setFileStates] = useState<ReadonlyMap<JsonPointer, FileFieldState>>(() => new Map());
  const [skipped, setSkipped] = useState<readonly JsonPointer[]>([]);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  /** Values from the page already applied to the form (on load or later). */
  const appliedRef = useRef<readonly BindingValue[] | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setDefinition(undefined); setProblem(undefined); setRun(undefined); setErrors([]); setPresetId(undefined); setAwaitingConfirmation(false);
    setFileStates(new Map()); setSkipped([]);
    void (async () => {
      const result = await api.operation(targetId, operationId);
      if (!active) return;
      if (!result.ok) { setProblem(result.problem); return; }
      setDefinition(result.data);
      const initial = initialInput ?? initialValues(result.data.inputSchema);
      appliedRef.current = bindingsRef.current;
      const prefill = prefillForPreset(result.data.inputSchema, initial, undefined, bindingsRef.current);
      setValues(prefill.values); setSkipped(prefill.skipped);
      if (initialInput !== undefined) onInitialInputConsumed?.();
    })();
    return () => { active = false; };
  }, [targetId, operationId]);

  /* Poll the run state until it reaches a terminal state. */
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (run === undefined || isRunFinished(run)) return;
    const timer = setInterval(async () => {
      const current = runRef.current;
      if (current === undefined) return;
      const result = await api.run(targetId, current.id);
      if (result.ok) setRun(result.data);
    }, 1500);
    return () => clearInterval(timer);
  }, [run?.id, run?.state, targetId]);

  const preset = definition?.presets?.find((p) => p.id === presetId);
  const locked: readonly JsonPointer[] = preset?.lockedPointers ?? [];

  /* New values from the page (the panel swapped them) are applied to the form, respecting preset locks. */
  useEffect(() => {
    if (definition === undefined || bindings === appliedRef.current) return;
    appliedRef.current = bindings;
    if (bindings === undefined) return;
    const prefill = applyBindings(values, definition.inputSchema, bindings, locked);
    setValues(prefill.values); setSkipped(prefill.skipped);
  }, [bindings, definition]);
  const uploadPending = [...fileStates.values()].some(({ pending }) => pending > 0);
  const setFileState = useCallback((pointer: JsonPointer, state: FileFieldState) => {
    setFileStates((current) => {
      const next = new Map(current);
      if (state.pending === 0 && state.problem === undefined) next.delete(pointer);
      else next.set(pointer, state);
      return next;
    });
  }, []);

  const effects = useMemo(
    () => (definition === undefined ? [] : policyEffects(definition.execution)),
    [definition],
  );

  if (problem !== undefined) {
    const described = describeProblem(problem);
    return (
      <div className="p-4 sm:p-6">
        <Card title="Could not open this operation">
          <div className="p-5">
            <p className="text-[13px] font-medium text-stop">{described.title}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{described.advice}</p>
          </div>
        </Card>
      </div>
    );
  }

  if (definition === undefined) {
    return <p className="p-6 text-[13px] text-muted-foreground">Loading operation…</p>;
  }

  /*
   * A dry run skips the confirmation gate — by definition it changes nothing,
   * and asking for consent to an operation without effects teaches people to click through dialogs without reading.
   */
  const attempt = (dryRun: boolean) => {
    if (!dryRun && definition.execution.confirmationRequired) { setAwaitingConfirmation(true); return; }
    void start(dryRun);
  };

  const start = async (dryRun: boolean) => {
    setAwaitingConfirmation(false);
    setSubmitting(true); setErrors([]);
    const requestId = `dashboard-${Date.now()}`;
    const request = buildCreateRunRequest(
      definition,
      values as JsonObject,
      { requestId, target: { id: targetId } },
      dryRun,
      definition.execution.idempotency === "none" ? undefined : requestId,
    );
    const result = await api.createRun(targetId, operationId, {
      ...request,
      context: { ...request.context },
      dryRun: request.dryRun ?? false,
    });
    setSubmitting(false);
    if (result.ok) { setRun(result.data); onRunCreated?.(result.data); return; }
    setErrors(attachToFields(result.problem.errors ?? []));
    setProblem(result.problem.errors === undefined ? result.problem : undefined);
  };

  const applyPreset = (id: string) => {
    const selected = definition.presets?.find((p) => p.id === id);
    setPresetId(id);
    if (selected === undefined) {
      // "Empty form" unlocks the fields: they get back the values from the page that the lock skipped.
      setValues(restoreSkippedBindings(values, definition.inputSchema, bindings, skipped));
      setSkipped([]);
      return;
    }
    const prefill = prefillForPreset(definition.inputSchema, initialValues(definition.inputSchema), selected, bindings);
    setValues(prefill.values); setSkipped(prefill.skipped);
  };

  const destructive = definition.execution.impact === "destructive";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {awaitingConfirmation && (
        <ConfirmDialog
          title={`${definition.label} — confirm`}
          destructive={destructive}
          cta={runButtonLabel(definition)}
          onCancel={() => setAwaitingConfirmation(false)}
          onConfirm={() => void start(false)}
        >
          <p className="mb-3 text-[13px] text-muted-foreground">
            The application marked this operation as requiring confirmation. Before it starts:
          </p>
          <EffectList items={effects} />
        </ConfirmDialog>
      )}

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="page-heading">
          <p className="page-eyebrow">Operation</p>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="page-title">{definition.label}</h1>
                <Badge tone={IMPACT_TONES[definition.execution.impact]}>{impactLabel(definition.execution.impact)}</Badge>
                <span
                  className="mono-text text-[11px] text-muted-foreground"
                  title={`The run will be pinned to this definition revision: ${definition.revision}`}
                >
                  {definition.revision.replace(/^sha256:(.{7}).*$/, "@$1")}
                </span>
              </div>
              {definition.description !== undefined && (
                <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-muted-foreground">{definition.description}</p>
              )}
            </div>

          </div>
        </div>

        <div className="page-body grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,.85fr)]">
          <div className="min-w-0 space-y-5">
            <Card title="What this operation does" icon="shield">
              <div className="p-5"><EffectList items={effects} /></div>
            </Card>

            {definition.presets !== undefined && definition.presets.length > 0 && (
              <Card title="Start from a preset" icon="layers">
                <div className="p-5">
                  <select
                    aria-label="Preset" value={presetId ?? ""} onChange={(e) => applyPreset(e.target.value)}
                    className="field-control w-full rounded-control border border-input bg-background px-3 py-2 text-[13px]"
                  >
                    <option value="">Empty form</option>
                    {definition.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  {preset?.description !== undefined && (
                    <p className="mt-2 text-[12px] text-muted-foreground">{preset.description}</p>
                  )}
                  {locked.length > 0 && (
                    <p className="mt-2 text-[12px] text-wait">
                      This preset locks {locked.length === 1 ? "one field" : `${locked.length} fields`}.
                      To unlock them, choose the empty form.
                    </p>
                  )}
                </div>
              </Card>
            )}

            <Card title="Input" icon="edit">
              <div className="space-y-5 p-5">
                {skipped.map((pointer) => (
                  <p key={pointer} className="text-[12px] text-muted-foreground">
                    Field {pointer} is set by the preset — the value from the page was skipped.
                  </p>
                ))}
                <OperationForm
                  definition={definition} targetId={targetId} values={values}
                  errors={errors} lockedPointers={locked} fileStates={fileStates}
                  onChange={setValues} onFileState={setFileState}
                />
              </div>
            </Card>

            {errors.length > 0 && (
              <Card title="Fix the input">
                <div className="space-y-3 p-5">
                  <p className="text-[13px] text-muted-foreground">
                    Nothing was sent to the application. The form is filled in just as you left it.
                  </p>
                  {generalErrors(errors).length > 0 && (
                    <>
                      <EffectList items={generalErrors(errors).map((t) => ({ tone: "stop" as const, text: t }))} />
                      <p className="text-[12px] text-muted-foreground">
                        The application did not say which fields these errors refer to — it reported them for the whole form.
                        Check the fields marked as required in the operation description.
                      </p>
                    </>
                  )}
                </div>
              </Card>
            )}
          </div>

          <div className="min-w-0 xl:sticky xl:top-6 xl:self-start">
            {run === undefined
              ? (
                <Card title="Result" icon="activity">
                  <EmptyState
                    title="Nothing has run yet"
                    description="The result will appear here when the run finishes. Your input stays in place, so fixing it and running again takes one click."
                  />
                </Card>
              )
              : (
                <RunView
                  targetId={targetId}
                  run={run}
                  onCancel={definition.execution.cancellationSupported
                    ? () => { void api.cancelRun(targetId, run.id).then((r) => { if (r.ok) setRun(r.data); }); }
                    : undefined}
                  onRunAgain={() => { setRun(undefined); onRunCleared?.(); }}
                />
              )}
          </div>
        </div>
      </div>
      <footer role="region" aria-label="Operation actions" className="action-bar">
        <p className="action-label">{definition.label}</p>
          <div className="action-controls">
            {definition.execution.dryRunSupported && (
              <Button disabled={submitting || uploadPending} onClick={() => attempt(true)}><Icon name="play" className="h-3.5 w-3.5" />Dry run</Button>
            )}
            <Button
              variant={definition.execution.impact === "destructive" ? "destructive" : "primary"}
              disabled={submitting || uploadPending} onClick={() => attempt(false)}
            >
              <Icon name={destructive ? "trash" : "play"} className="h-3.5 w-3.5" />
              {submitting ? "Sending…" : runButtonLabel(definition)}
            </Button>
          </div>
      </footer>
    </div>
  );
}
