import { useSyncExternalStore } from "react";
import type { JsonObject } from "@8lines/gauntlet-protocol";

export interface Route {
  readonly targetId?: string;
  readonly operationId?: string;
  readonly runId?: string;
  readonly input?: JsonObject;
}

export interface NavigateOptions {
  readonly replace?: boolean;
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts[0] !== "t" || parts[1] === undefined) return {};
  const targetId = decodeURIComponent(parts[1]);
  if (parts[2] === "o" && parts[3] !== undefined) {
    const operationId = decodeURIComponent(parts[3]);
    if (parts[4] === "r" && parts[5] !== undefined) return { targetId, operationId, runId: decodeURIComponent(parts[5]) };
    return { targetId, operationId };
  }
  return { targetId };
}

function readRoute(): Route {
  return globalThis.location === undefined ? {} : parseRoute(globalThis.location.pathname);
}

const listeners = new Set<() => void>();
let current = readRoute();

function refresh() {
  current = readRoute();
  for (const listener of listeners) listener();
}
globalThis.addEventListener?.("popstate", refresh);

export function routePath(route: Route): string {
  if (route.targetId === undefined) return "/";
  const target = `/t/${encodeURIComponent(route.targetId)}`;
  if (route.operationId === undefined) return target;
  const operation = `${target}/o/${encodeURIComponent(route.operationId)}`;
  return route.runId === undefined ? operation : `${operation}/r/${encodeURIComponent(route.runId)}`;
}

export function navigate(route: Route, options: NavigateOptions = {}): void {
  const url = routePath(route);
  const state = route.input === undefined ? null : { gauntletInput: route.input };
  globalThis.history[options.replace ? "replaceState" : "pushState"](state, "", url);
  globalThis.dispatchEvent(new PopStateEvent("popstate", { state }));
}

/** Client-side navigation for a link click; clicks with a modifier key are left to the browser (new tab, new window). */
export function followRoute(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }, route: Route): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(route);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}
