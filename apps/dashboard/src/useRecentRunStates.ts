import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { nextRecentRunState, type RecentRunEntry } from "./recent-run-state.ts";
import type { RecentRun } from "./recent-runs.ts";

const POLL_MS = 3000;

/** The current state of each remembered run, by `runId`. Unfinished runs are polled until they finish. */
export function useRecentRunStates(entries: readonly RecentRun[]): ReadonlyMap<string, RecentRunEntry> {
  const [states, setStates] = useState<ReadonlyMap<string, RecentRunEntry>>(new Map());
  const key = entries.map((e) => `${e.targetId}/${e.runId}`).join("|");
  useEffect(() => {
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const load = async (entry: RecentRun) => {
      const result = await api.run(entry.targetId, entry.runId);
      if (!active) return;
      setStates((current) => new Map(current).set(entry.runId, nextRecentRunState(current.get(entry.runId), result).entry));
      // Whether to poll again never depends on the previous entry.
      if (nextRecentRunState(undefined, result).keepPolling) timers.push(setTimeout(() => void load(entry), POLL_MS));
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
