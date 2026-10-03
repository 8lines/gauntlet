import type { FollowUpAction, Problem, SessionLaunchResponse } from "@8lines/gauntlet-protocol";
import { api, type Result } from "./api.ts";
import { navigate, routePath, type Route } from "./route.ts";

type DirectFollowUpAction = Extract<FollowUpAction, { kind: "invoke-operation" | "open-link" }>;

export interface FollowUpEffects {
  readonly navigate: (route: Route) => void;
  readonly open: (url: string) => void;
}

const defaultFollowUpEffects: FollowUpEffects = {
  navigate: navigate,
  open: (url) => { globalThis.open(url, "_blank", "noopener,noreferrer"); },
};

export function followUpPath(
  action: Extract<FollowUpAction, { kind: "invoke-operation" }>,
  targetId: string,
): string {
  return routePath({ targetId, operationId: action.operationId });
}

export function executeFollowUp(
  action: DirectFollowUpAction,
  targetId: string,
  effects: FollowUpEffects = defaultFollowUpEffects,
): void {
  if (action.kind === "invoke-operation") {
    effects.navigate({
      targetId,
      operationId: action.operationId,
      ...(action.input === undefined ? {} : { input: action.input }),
    });
    return;
  }
  effects.open(action.url);
}

export interface BrowserPopup {
  readonly navigate: (url: string) => void;
  readonly close: () => void;
}

export interface BrowserLaunchDependencies {
  readonly openBlank: () => BrowserPopup | null;
  readonly launch: (targetId: string, runId: string, artifactId: string) => Promise<Result<SessionLaunchResponse>>;
}

export interface BrowserLaunchAttempt {
  readonly result: Promise<Problem | undefined>;
  readonly cancel: () => void;
}

const POPUP_BLOCKED: Problem = Object.freeze({
  type: "urn:gauntlet:problem:popup-blocked",
  title: "The browser blocked the new window",
  status: 0,
  detail: "Allow Gauntlet to open new windows and try again.",
});

const defaultBrowserLaunchDependencies: BrowserLaunchDependencies = {
  openBlank: () => {
    const popup = globalThis.open("about:blank", "_blank");
    if (popup === null) return null;
    popup.opener = null;
    return {
      navigate: (url) => { popup.location.replace(url); },
      close: () => { popup.close(); },
    };
  },
  launch: api.launchArtifact,
};

export function beginBrowserLaunch(
  targetId: string,
  runId: string,
  artifactId: string,
  dependencies: BrowserLaunchDependencies = defaultBrowserLaunchDependencies,
): BrowserLaunchAttempt {
  const popup = dependencies.openBlank();
  if (popup === null) {
    return { result: Promise.resolve(POPUP_BLOCKED), cancel: () => undefined };
  }

  let current = true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    popup.close();
  };
  const cancel = () => {
    if (!current) return;
    current = false;
    close();
  };
  const result = (async (): Promise<Problem | undefined> => {
    const response = await dependencies.launch(targetId, runId, artifactId);
    if (!current) { close(); return undefined; }
    current = false;
    if (!response.ok) { close(); return response.problem; }
    popup.navigate(response.data.url);
    return undefined;
  })();
  return { result, cancel };
}
