import { useCallback, useEffect, useRef, useState } from "react";
import { listPins, pin, unpin } from "./pins.ts";
import type { Result } from "./api.ts";

const ERROR_VISIBLE_MS = 5000;

export interface Pins {
  /** Pinned operation ids, oldest first; undefined until loaded, or when loading failed. */
  readonly pinnedIds: readonly string[] | undefined;
  isPinned(operationId: string): boolean;
  toggle(operationId: string): void;
  /** A short message after a failed toggle, cleared by the next toggle or after five seconds. */
  readonly error: string | undefined;
}

function withPin(ids: readonly string[], operationId: string, index = ids.length): readonly string[] {
  if (ids.includes(operationId)) return ids;
  return [...ids.slice(0, index), operationId, ...ids.slice(index)];
}

function withoutPin(ids: readonly string[], operationId: string): readonly string[] {
  return ids.includes(operationId) ? ids.filter((id) => id !== operationId) : ids;
}

/**
 * The signed-in principal's pins on one target. Loads when the target changes, when `reloadKey`
 * changes and when the document becomes visible again, so pins made in the dashboard and in the
 * widget meet. `toggle` updates at once and undoes the change if the server refuses it.
 */
export function usePins(targetId: string | undefined, reloadKey = 0): Pins {
  const [state, setState] = useState<{ readonly targetId: string; readonly ids: readonly string[] } | undefined>(undefined);
  const [error, setError] = useState<{ readonly targetId: string; readonly message: string } | undefined>(undefined);
  const latestLoad = useRef(0);
  const mutations = useRef({ started: 0, pending: 0 });
  // Mutations go out one after another, so a quick pin and unpin reach the server in that order.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const pinnedIds = state !== undefined && state.targetId === targetId ? state.ids : undefined;

  const load = useCallback(async () => {
    if (targetId === undefined) return;
    const token = ++latestLoad.current;
    const startedMutations = mutations.current.started;
    const result = await listPins(targetId);
    // A newer load, another target or an unmount took over.
    if (token !== latestLoad.current || !result.ok) return;
    // A toggle made since this load began is newer than the server's answer.
    if (mutations.current.started !== startedMutations || mutations.current.pending > 0) return;
    setState({ targetId, ids: result.data.map((entry) => entry.operationId) });
  }, [targetId]);

  useEffect(() => {
    void load();
    return () => {
      latestLoad.current += 1;
    };
  }, [load, reloadKey]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [load]);

  useEffect(() => () => clearTimeout(errorTimer.current), []);

  const toggle = useCallback((operationId: string) => {
    if (targetId === undefined || pinnedIds === undefined) return;
    const index = pinnedIds.indexOf(operationId);
    const pinning = index === -1;
    clearTimeout(errorTimer.current);
    setError(undefined);
    mutations.current.started += 1;
    mutations.current.pending += 1;
    const update = (change: (ids: readonly string[]) => readonly string[]) =>
      setState((current) => (current === undefined || current.targetId !== targetId ? current : { targetId, ids: change(current.ids) }));
    update((ids) => (pinning ? withPin(ids, operationId) : withoutPin(ids, operationId)));

    const sent: Promise<Result<undefined>> = queue.current.then(() => (pinning ? pin : unpin)(targetId, operationId));
    queue.current = sent;
    void sent.then((result) => {
      mutations.current.pending -= 1;
      if (result.ok) return;
      update((ids) => (pinning ? withoutPin(ids, operationId) : withPin(ids, operationId, index)));
      setError({ targetId, message: pinning ? "Could not pin the operation." : "Could not unpin the operation." });
      errorTimer.current = setTimeout(() => setError(undefined), ERROR_VISIBLE_MS);
    });
  }, [targetId, pinnedIds]);

  const isPinned = useCallback((operationId: string) => pinnedIds?.includes(operationId) ?? false, [pinnedIds]);

  return {
    pinnedIds,
    isPinned,
    toggle,
    error: error !== undefined && error.targetId === targetId ? error.message : undefined,
  };
}
