import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonObject, JsonPointer, OperationDefinition, Problem, Run, ValidationError } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "../api.ts";
import { buildCreateRunRequest } from "../create-run-request.ts";
import type { FileFieldState, FormValues } from "../form-upload.ts";
import { initialValues } from "../json-pointer.ts";
import { attachToFields } from "../operation-errors.ts";
import { useRun } from "../useRun.ts";
import { applyBindings, prefillForPreset, restoreSkippedBindings, type BindingValue } from "../widget/prefill.ts";

export interface OperationRunOptions {
  readonly targetId: string;
  readonly operationId: string;
  /** The run named by the URL (`/t/…/o/…/r/:runId`). The widget never passes it. */
  readonly runId?: string | undefined;
  readonly initialInput?: JsonObject | undefined;
  readonly onInitialInputConsumed?: (() => void) | undefined;
  /**
   * Values from the page embedding the widget (placement bindings), applied over the defaults and the preset.
   * The panel freezes them when the operation opens; a new array (e.g. "Use values from the page")
   * is applied over the current form, skipping fields locked by the selected preset.
   */
  readonly bindings?: readonly BindingValue[] | undefined;
  readonly onRunCreated?: ((run: Run) => void) | undefined;
  /** The result left the view ("Run again"); the form is once again the only content. */
  readonly onRunCleared?: (() => void) | undefined;
}

/** All state of the operation screen: definition, form, presets, page bindings, confirmation gate and the run. */
export function useOperationRun(
  { targetId, operationId, runId, initialInput, onInitialInputConsumed, bindings, onRunCreated, onRunCleared }: OperationRunOptions,
) {
  const [definition, setDefinition] = useState<OperationDefinition>();
  const [problem, setProblem] = useState<Problem>();
  const [values, setValues] = useState<FormValues>({});
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

  /* The run named by the URL: loaded once here, then the in-screen polling below takes over. */
  const urlRun = useRun(targetId, runId !== undefined && runId !== run?.id ? runId : undefined);
  useEffect(() => { if (urlRun.run !== undefined) setRun(urlRun.run); }, [urlRun.run]);
  const previousRunId = useRef(runId);
  useEffect(() => {
    // Leaving a run URL (browser back, "Run again") returns to the form; the widget never passes runId.
    if (previousRunId.current !== undefined && runId === undefined) setRun(undefined);
    previousRunId.current = runId;
  }, [runId]);
  const runMissing = urlRun.missing;

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

  const start = async (dryRun: boolean) => {
    if (definition === undefined) return;
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

  /*
   * A dry run skips the confirmation gate: by definition it changes nothing,
   * and asking for consent to an operation without effects teaches people to click through dialogs without reading.
   */
  const attempt = (dryRun: boolean) => {
    if (definition === undefined) return;
    if (!dryRun && definition.execution.confirmationRequired) { setAwaitingConfirmation(true); return; }
    void start(dryRun);
  };

  const applyPreset = (id: string | undefined) => {
    if (definition === undefined) return;
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

  const cancelRun = () => {
    if (run === undefined) return;
    void api.cancelRun(targetId, run.id).then((r) => { if (r.ok) setRun(r.data); });
  };

  const runAgain = () => { setRun(undefined); onRunCleared?.(); };

  return {
    definition,
    problem,
    values,
    setValues,
    presetId,
    applyPreset,
    locked,
    skipped,
    errors,
    run,
    runMissing,
    runProblem: urlRun.problem,
    submitting,
    uploadPending,
    fileStates,
    setFileState,
    attempt,
    confirm: () => { void start(false); },
    awaitingConfirmation,
    cancelConfirmation: () => setAwaitingConfirmation(false),
    cancelRun,
    runAgain,
  };
}
