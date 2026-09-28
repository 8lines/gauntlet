/**
 * The floating launcher button: a `<div data-gauntlet-widget>` host element on
 * `document.body` whose closed shadow root holds the button and its badge.
 * The host carries `data-gauntlet-state`, `data-gauntlet-count` and, while
 * unavailable, `data-gauntlet-reason` (DOM contract in
 * docs/superpowers/specs/2026-09-25-embeddable-widget-design.md).
 */

import type { ButtonPosition } from "@8lines/gauntlet-widget";

export type LauncherState = "connecting" | "ready" | "unavailable";

/** Why the launcher is unavailable: the panel refused the page, or never answered. */
export type UnavailableReason = "rejected" | "unreachable";

const UNAVAILABLE_TITLES: Record<UnavailableReason, string> = {
  rejected: "Gauntlet rejected this page (origin or target) — see the browser console",
  unreachable: "Cannot reach Gauntlet",
};

export interface Launcher {
  /** `reason` applies only to `unavailable`. */
  setState(state: LauncherState, reason?: UnavailableReason): void;
  setCount(contextualCount: number): void;
  setExpanded(expanded: boolean): void;
  remove(): void;
}

const STYLES = `
:host { all: initial; }
button {
  position: relative; display: grid; place-items: center; box-sizing: border-box;
  width: 56px; height: 56px; margin: 0; padding: 0; border: 0; border-radius: 50%;
  background: #111827; color: #fff; cursor: pointer;
  box-shadow: 0 6px 20px rgba(17, 24, 39, 0.28);
  transition: transform 120ms ease, box-shadow 120ms ease;
}
button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(17, 24, 39, 0.32); }
button:focus-visible { outline: 3px solid #60a5fa; outline-offset: 3px; }
button:disabled { cursor: not-allowed; opacity: 0.55; box-shadow: none; }
svg { width: 26px; height: 26px; }
span {
  position: absolute; top: -4px; right: -4px; box-sizing: border-box;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: #dc2626; color: #fff; font: 600 12px/20px system-ui, sans-serif; text-align: center;
}
span[hidden] { display: none; }
`;

const ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>';

export function createLauncher(position: ButtonPosition, onClick: () => void): Launcher {
  const host = document.createElement("div");
  host.setAttribute("data-gauntlet-widget", "");
  const side = position === "bottom-left" ? "left" : "right";
  host.style.cssText = `position:fixed;bottom:20px;${side}:20px;z-index:2147483000;display:block;width:56px;height:56px;`;

  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Open Gauntlet");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = ICON;
  const badge = document.createElement("span");
  badge.hidden = true;
  button.append(badge);
  button.addEventListener("click", onClick);
  root.append(style, button);
  document.body.append(host);

  return {
    setState(state, reason = "unreachable") {
      host.setAttribute("data-gauntlet-state", state);
      const unavailable = state === "unavailable";
      button.disabled = unavailable;
      if (unavailable) {
        host.setAttribute("data-gauntlet-reason", reason);
        button.title = UNAVAILABLE_TITLES[reason];
      } else {
        host.removeAttribute("data-gauntlet-reason");
        button.removeAttribute("title");
      }
    },
    setCount(contextualCount) {
      host.setAttribute("data-gauntlet-count", String(contextualCount));
      badge.hidden = contextualCount <= 0;
      badge.textContent = contextualCount > 99 ? "99+" : String(contextualCount);
    },
    setExpanded(expanded) {
      button.setAttribute("aria-expanded", String(expanded));
    },
    remove() {
      host.remove();
    },
  };
}
