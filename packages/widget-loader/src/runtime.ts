/**
 * The loader's DOM runtime: the launcher button, the hidden panel iframe, the
 * handshake and MessagePort channel with the panel, and page-context tracking
 * across SPA navigation. Commands reach it through `LoaderRuntime` (see
 * ./commands.ts). Timings and the DOM contract follow
 * docs/superpowers/specs/2026-09-25-embeddable-widget-design.md.
 */

import { parsePanelMessage, type PageContext } from "@8lines/gauntlet-widget-channel";
import type { SubjectValues } from "@8lines/gauntlet-widget";
import type { LoaderRuntime } from "./commands.js";
import { panelHandshake } from "./handshake.js";
import { createLauncher, type Launcher, type LauncherState, type UnavailableReason } from "./launcher.js";
import type { LoaderConfig } from "./options.js";
import { subjectsForPath } from "./routes.js";
import { pageContext, sameContext } from "./subjects.js";

export interface DomRuntimeOptions {
  readonly gauntletOrigin: string;
  explicitSubjects(): ReadonlyMap<string, SubjectValues>;
}

const READY_TIMEOUT_MS = 10_000;
const IDLE_FALLBACK_MS = 1_500;
const RECOMPUTE_DEBOUNCE_MS = 50;
const PANEL_WIDTH = "400px";
const PANEL_EXPANDED_WIDTH = "min(960px, 100vw)";

type HistoryMethod = History["pushState"];

/** State that exists only between `start` and `stop`. */
interface Session {
  readonly config: LoaderConfig;
  readonly launcher: Launcher;
  readonly originalPushState: HistoryMethod;
  readonly originalReplaceState: HistoryMethod;
  readonly wrappedPushState: HistoryMethod;
  readonly wrappedReplaceState: HistoryMethod;
  state: LauncherState;
  frame: HTMLIFrameElement | undefined;
  port: MessagePort | undefined;
  lastSent: PageContext | undefined;
  open: boolean;
  expanded: boolean;
  oversizeWarned: boolean;
  idleHandle: number | undefined;
  readyTimer: ReturnType<typeof setTimeout> | undefined;
  recomputeTimer: ReturnType<typeof setTimeout> | undefined;
}

export function createDomRuntime(options: DomRuntimeOptions): LoaderRuntime {
  const { gauntletOrigin } = options;
  let session: Session | undefined;

  function closePort(port: MessagePort | undefined): void {
    if (port === undefined) return;
    port.onmessage = null;
    port.close();
  }

  function post(message: object): void {
    session?.port?.postMessage(message);
  }

  function setState(state: LauncherState, reason?: UnavailableReason): void {
    if (session === undefined) return;
    session.state = state;
    session.launcher.setState(state, reason);
  }

  /** Sends the current context when connected and it differs from the last one sent. */
  function recompute(): void {
    if (session === undefined) return;
    clearTimeout(session.recomputeTimer);
    session.recomputeTimer = undefined;
    if (session.port === undefined) return;
    const { config } = session;
    const fromUrl = subjectsForPath(config.routes, location.pathname);
    const { context: next, withinLimits } = pageContext(config.target, fromUrl, options.explicitSubjects());
    if (!withinLimits && !session.oversizeWarned) {
      console.warn("Gauntlet widget: the page context exceeds the channel limits; sending it without subjects");
      session.oversizeWarned = true;
    }
    if (sameContext(session.lastSent, next)) return;
    session.lastSent = next;
    post({ channel: 1, type: "gauntlet:context", context: next });
  }

  function scheduleRecompute(): void {
    if (session === undefined) return;
    clearTimeout(session.recomputeTimer);
    session.recomputeTimer = setTimeout(recompute, RECOMPUTE_DEBOUNCE_MS);
  }

  function applyFrameLayout(): void {
    const frame = session?.frame;
    if (session === undefined || frame === undefined) return;
    frame.hidden = !session.open;
    frame.style.display = session.open ? "block" : "none";
    frame.style.width = session.expanded ? PANEL_EXPANDED_WIDTH : PANEL_WIDTH;
  }

  function becomeUnavailable(reason: UnavailableReason): void {
    if (session === undefined) return;
    clearTimeout(session.readyTimer);
    session.readyTimer = undefined;
    closePort(session.port);
    session.port = undefined;
    setState("unavailable", reason);
    close();
  }

  function ensureFrame(): void {
    if (session === undefined || session.frame !== undefined) return;
    cancelIdle(session);
    const frame = document.createElement("iframe");
    frame.setAttribute("data-gauntlet-panel", "");
    frame.title = "Gauntlet";
    frame.referrerPolicy = "origin";
    const side = session.config.position === "bottom-left" ? "left" : "right";
    frame.style.cssText =
      `position:fixed;top:0;${side}:0;height:100vh;max-width:100vw;border:0;margin:0;padding:0;` +
      "z-index:2147483001;background:#fff;color-scheme:normal;box-shadow:0 0 32px rgba(17,24,39,0.24);";
    frame.src = `${gauntletOrigin}/widget/`;
    session.frame = frame;
    applyFrameLayout();
    document.body.append(frame);
    session.readyTimer = setTimeout(() => {
      if (session === undefined || session.port !== undefined) return;
      // The browser blocks the panel silently when this origin is missing from its
      // frame-ancestors policy (listed for no target) or when the widget is disabled (404).
      console.warn(
        `Gauntlet widget: the panel at ${gauntletOrigin}/widget/ did not become ready within ${READY_TIMEOUT_MS / 1000} seconds ` +
          `for target "${session.config.target}" on ${location.origin}. Check that widget.enabled is true and that ` +
          `${location.origin} is listed in targets[].widget.origins in the Gauntlet configuration.`,
      );
      becomeUnavailable("unreachable");
    }, READY_TIMEOUT_MS);
  }

  function connect(): void {
    const target = session?.frame?.contentWindow;
    if (session === undefined || !target) return;
    clearTimeout(session.readyTimer);
    session.readyTimer = undefined;
    closePort(session.port);
    const channel = new MessageChannel();
    const port = channel.port1;
    port.onmessage = (event) => {
      if (session?.port === port) onPanelMessage(event.data);
    };
    session.port = port;
    target.postMessage({ channel: 1, type: "gauntlet:connect", target: session.config.target }, gauntletOrigin, [channel.port2]);
    setState("ready");
    session.lastSent = undefined;
    recompute();
    if (session.open) post({ channel: 1, type: "gauntlet:open" });
  }

  function reject(): void {
    if (session === undefined) return;
    console.warn(
      `Gauntlet widget: Gauntlet rejected this page's origin ${location.origin} for target "${session.config.target}": ` +
        `the target is unknown or has no widget.origins, or ${location.origin} is not listed. ` +
        `Add ${location.origin} to that target's widget.origins (targets[].widget.origins) in the Gauntlet configuration.`,
    );
    becomeUnavailable("rejected");
  }

  function onWindowMessage(event: MessageEvent): void {
    const outcome = panelHandshake(event, gauntletOrigin, session?.frame?.contentWindow);
    if (outcome === "ready") connect();
    else if (outcome === "rejected") reject();
  }

  function onPanelMessage(data: unknown): void {
    if (session === undefined) return;
    const parsed = parsePanelMessage(data);
    if (parsed.kind === "unknown") {
      console.debug("Gauntlet widget: ignoring unknown message", parsed.type);
      return;
    }
    if (parsed.kind !== "message") return;
    const message = parsed.message;
    switch (message.type) {
      case "gauntlet:state":
        session.launcher.setCount(message.contextualCount);
        return;
      case "gauntlet:close":
        close();
        return;
      case "gauntlet:resize":
        session.expanded = message.expanded;
        applyFrameLayout();
        return;
    }
  }

  function cancelIdle(current: Session): void {
    if (current.idleHandle === undefined) return;
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(current.idleHandle);
    else clearTimeout(current.idleHandle);
    current.idleHandle = undefined;
  }

  function wrapHistory(original: HistoryMethod): HistoryMethod {
    return function (this: History, ...args: Parameters<HistoryMethod>) {
      original.apply(this, args);
      scheduleRecompute();
    };
  }

  function start(config: LoaderConfig): void {
    if (session !== undefined) stop();
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    session = {
      config,
      launcher: createLauncher(config.position, () => (session?.open ? close() : open())),
      originalPushState,
      originalReplaceState,
      wrappedPushState: wrapHistory(originalPushState),
      wrappedReplaceState: wrapHistory(originalReplaceState),
      state: "connecting",
      frame: undefined,
      port: undefined,
      lastSent: undefined,
      open: false,
      expanded: false,
      oversizeWarned: false,
      idleHandle: undefined,
      readyTimer: undefined,
      recomputeTimer: undefined,
    };
    setState("connecting");
    window.addEventListener("message", onWindowMessage);
    window.addEventListener("popstate", scheduleRecompute);
    history.pushState = session.wrappedPushState;
    history.replaceState = session.wrappedReplaceState;
    session.idleHandle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(() => ensureFrame(), { timeout: IDLE_FALLBACK_MS })
        : (setTimeout(ensureFrame, IDLE_FALLBACK_MS) as unknown as number);
  }

  function open(): void {
    if (session === undefined || session.state === "unavailable") return;
    ensureFrame();
    session.open = true;
    applyFrameLayout();
    session.launcher.setExpanded(true);
    post({ channel: 1, type: "gauntlet:open" });
  }

  function close(): void {
    if (session === undefined) return;
    session.open = false;
    applyFrameLayout();
    session.launcher.setExpanded(false);
  }

  function stop(): void {
    const current = session;
    if (current === undefined) return;
    session = undefined;
    window.removeEventListener("message", onWindowMessage);
    window.removeEventListener("popstate", scheduleRecompute);
    if (history.pushState === current.wrappedPushState) history.pushState = current.originalPushState;
    if (history.replaceState === current.wrappedReplaceState) history.replaceState = current.originalReplaceState;
    cancelIdle(current);
    clearTimeout(current.readyTimer);
    clearTimeout(current.recomputeTimer);
    closePort(current.port);
    current.frame?.remove();
    current.launcher.remove();
  }

  return { start, refresh: recompute, open, close, stop };
}
