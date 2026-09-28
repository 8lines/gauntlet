/**
 * Processes `window.Gauntlet(command, ...args)` calls: remembers subjects set
 * before `boot`, enforces command ordering, and installs the global,
 * replaying any stub queue. See docs/superpowers/specs/2026-09-25-embeddable-widget-design.md,
 * section "Host API".
 */

import { isPortableId, isSubjectValues, MAX_SUBJECTS } from "@8lines/gauntlet-widget-channel";
import type { SubjectValues } from "@8lines/gauntlet-widget";
import { parseBootOptions, type LoaderConfig } from "./options.js";

export interface LoaderRuntime {
  start(config: LoaderConfig): void;
  refresh(): void;
  open(): void;
  close(): void;
  stop(): void;
}

export interface CommandLog {
  warn(message: string): void;
}

export interface CommandProcessor {
  dispatch(name: unknown, args: readonly unknown[]): void;
  explicitSubjects(): ReadonlyMap<string, SubjectValues>;
}

export const LOADER_MARK = "__gauntletLoader" as const;

export function createCommandProcessor(runtime: LoaderRuntime, log: CommandLog): CommandProcessor {
  let booted = false;
  const explicit = new Map<string, SubjectValues>();

  function warn(message: string): void {
    log.warn(`Gauntlet widget: ${message}`);
  }

  function handleBoot(value: unknown): void {
    if (booted) {
      warn("boot was already called; ignoring");
      return;
    }
    const result = parseBootOptions(value);
    if (!result.ok) {
      warn(result.reason);
      return;
    }
    booted = true;
    runtime.start(result.config);
    if (result.ignoredKeys.length > 0) {
      warn(`boot ignored unknown option key(s): ${result.ignoredKeys.join(", ")}`);
    }
  }

  function handleSetSubject(type: unknown, values: unknown): void {
    if (!isPortableId(type) || !isSubjectValues(values)) {
      warn("setSubject requires a valid type and values");
      return;
    }
    if (!explicit.has(type) && explicit.size >= MAX_SUBJECTS) {
      warn(`setSubject ignored "${type}": at most ${MAX_SUBJECTS} subject types can be set`);
      return;
    }
    explicit.set(type, { ...values });
    if (booted) runtime.refresh();
  }

  function handleRemoveSubject(type: unknown): void {
    if (!isPortableId(type)) {
      warn("removeSubject requires a valid type");
      return;
    }
    explicit.delete(type);
    if (booted) runtime.refresh();
  }

  function handleOpenOrClose(which: "open" | "close"): void {
    if (!booted) {
      warn(`${which} requires boot to be called first`);
      return;
    }
    if (which === "open") runtime.open();
    else runtime.close();
  }

  function handleShutdown(): void {
    booted = false;
    explicit.clear();
    runtime.stop();
  }

  function dispatch(name: unknown, args: readonly unknown[]): void {
    switch (name) {
      case "boot":
        handleBoot(args[0]);
        return;
      case "setSubject":
        handleSetSubject(args[0], args[1]);
        return;
      case "removeSubject":
        handleRemoveSubject(args[0]);
        return;
      case "open":
        handleOpenOrClose("open");
        return;
      case "close":
        handleOpenOrClose("close");
        return;
      case "shutdown":
        handleShutdown();
        return;
      default:
        warn(`unknown command "${String(name)}"`);
    }
  }

  return { dispatch, explicitSubjects: () => explicit };
}

interface GauntletStub {
  (...args: unknown[]): void;
  q?: ArrayLike<unknown>[];
  [LOADER_MARK]?: boolean;
}

export function installGlobal(host: { Gauntlet?: unknown }, processor: CommandProcessor): boolean {
  const existing = host.Gauntlet as GauntletStub | undefined;
  if (existing?.[LOADER_MARK] === true) return false;

  const queued = existing?.q;
  const installed: GauntletStub = (...args: unknown[]) => {
    const [name, ...rest] = args;
    processor.dispatch(name, rest);
  };
  installed[LOADER_MARK] = true;
  host.Gauntlet = installed;

  if (queued !== undefined) {
    for (const entry of queued) {
      processor.dispatch(entry[0], Array.from(entry).slice(1));
    }
  }
  return true;
}
