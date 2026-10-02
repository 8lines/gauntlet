import { useEffect, useState } from "react";
import type { Run } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "./api.ts";
import type { RecentRun } from "./recent-runs.ts";

type Entry = { readonly run?: Run; readonly missing: boolean };

/** The current state of each remembered run, by `runId`. Unfinished runs are polled until they finish. */
export function useRecentRunStates(entries: readonly RecentRun[]): ReadonlyMap<string, Entry> {
  const [states, setStates] = useState<ReadonlyMap<string, Entry>>(new Map());
  const key = entries.map((e) => `${e.targetId}/${e.runId}`).join("|");
  useEffect(() => {
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const load = async (entry: RecentRun) => {
      const result = await api.run(entry.targetId, entry.runId);
      if (!active) return;
      const next: Entry = result.ok ? { run: result.data, missing: false } : { missing: result.problem.status === 404 };
      setStates((current) => new Map(current).set(entry.runId, next));
      if (result.ok && !isRunFinished(result.data)) timers.push(setTimeout(() => void load(entry), 3000));
    };
    for (const entry of entries) void load(entry);
    return () => {
      active = false;
      timers.forEach(clearTimeout);
    };
    // `entries` is identified by `key`; the array itself changes identity on every render.
  }, [key]);
  return states;
}
