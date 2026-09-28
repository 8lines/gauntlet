import { useSyncExternalStore } from "react";
import type { JsonObject } from "@8lines/gauntlet-protocol";

export interface Route {
  readonly targetId?: string;
  readonly operationId?: string;
  readonly input?: JsonObject;
}

export interface NavigateOptions {
  readonly replace?: boolean;
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts[0] !== "t" || parts[1] === undefined) return {};
  if (parts[2] === "o" && parts[3] !== undefined) {
    return {
      targetId: decodeURIComponent(parts[1]),
      operationId: decodeURIComponent(parts[3]),
    };
  }
  return { targetId: decodeURIComponent(parts[1]) };
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
  return route.targetId === undefined
    ? "/"
    : route.operationId === undefined
      ? `/t/${encodeURIComponent(route.targetId)}`
      : `/t/${encodeURIComponent(route.targetId)}/o/${encodeURIComponent(route.operationId)}`;
}

export function navigate(route: Route, options: NavigateOptions = {}): void {
  const url = routePath(route);
  const state = route.input === undefined ? null : { gauntletInput: route.input };
  globalThis.history[options.replace ? "replaceState" : "pushState"](state, "", url);
  globalThis.dispatchEvent(new PopStateEvent("popstate", { state }));
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}
