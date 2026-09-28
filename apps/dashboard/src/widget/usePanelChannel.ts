import { useCallback, useEffect, useRef, useState } from "react";
import { parseHostMessage, type PageContext, type PanelMessage } from "@8lines/gauntlet-widget-channel";
import { decideConnect, parseWidgetConfig } from "./handshake.ts";

/**
 * Panel side of channel 1 (see docs/superpowers/specs/2026-09-25-embeddable-widget-design.md,
 * "Handshake"): fetch `/widget/config.json`, post `gauntlet:ready` to the parent, accept a single
 * `gauntlet:connect` via `decideConnect`, then talk over the transferred port only.
 *
 * - `waiting`: config not loaded yet, or `ready` posted and no connect yet;
 * - `standalone`: the panel is not framed (`window.parent === window`);
 * - `unavailable`: `/widget/config.json` could not be read, so no handshake is attempted
 *   (the loader then times out and greys its button out);
 * - `rejected`: the parent failed the connect checks; all later window messages are ignored;
 * - `connected`: the port is live, `target` is the host's target id.
 */
export type PanelChannelState =
  | { readonly kind: "waiting" }
  | { readonly kind: "standalone" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "rejected" }
  | { readonly kind: "connected"; readonly target: string };

export interface PanelCounts {
  readonly contextualCount: number;
  readonly globalCount: number;
}

export interface PanelChannel {
  readonly state: PanelChannelState;
  readonly context: PageContext | undefined;
  /** Increments on every `gauntlet:open`, so the panel can focus search and refresh. */
  readonly openCount: number;
  readonly sendState: (counts: PanelCounts) => void;
  readonly close: () => void;
  readonly setExpanded: (expanded: boolean) => void;
}

async function loadConfig() {
  try {
    const response = await fetch("/widget/config.json", { headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    return parseWidgetConfig(await response.json());
  } catch {
    return undefined;
  }
}

export function usePanelChannel(): PanelChannel {
  const [state, setState] = useState<PanelChannelState>({ kind: "waiting" });
  const [context, setContext] = useState<PageContext>();
  const [openCount, setOpenCount] = useState(0);
  const portRef = useRef<MessagePort | undefined>(undefined);
  const expandedRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let removeListener = () => {};
    void (async () => {
      const config = await loadConfig();
      if (!active) return;
      if (window.parent === window) { setState({ kind: "standalone" }); return; }
      if (config === undefined) { setState({ kind: "unavailable" }); return; }

      const onMessage = (event: MessageEvent) => {
        const decision = decideConnect(event, window.parent, config);
        if (decision.kind === "ignore") return;
        removeListener();
        if (decision.kind === "reject") {
          window.parent.postMessage({ channel: 1, type: "gauntlet:rejected" }, "*");
          setState({ kind: "rejected" });
          return;
        }
        const port = decision.port as MessagePort;
        const target = decision.target;
        port.onmessage = (portEvent: MessageEvent) => {
          const parsed = parseHostMessage(portEvent.data);
          if (parsed.kind === "unknown") {
            console.debug(`Gauntlet: ignoring unknown host message ${parsed.type}`);
            return;
          }
          if (parsed.kind === "invalid") {
            console.debug("Gauntlet: ignoring invalid host message");
            return;
          }
          const message = parsed.message;
          if (message.type === "gauntlet:open") { setOpenCount((count) => count + 1); return; }
          if (message.context.target !== target) {
            console.debug(`Gauntlet: ignoring context for target ${message.context.target}`);
            return;
          }
          setContext(message.context);
        };
        portRef.current = port;
        setState({ kind: "connected", target });
      };
      window.addEventListener("message", onMessage);
      removeListener = () => window.removeEventListener("message", onMessage);
      window.parent.postMessage({ channel: 1, type: "gauntlet:ready" }, "*");
    })();
    return () => {
      active = false;
      removeListener();
      portRef.current?.close();
      portRef.current = undefined;
    };
  }, []);

  const post = useCallback((message: PanelMessage) => { portRef.current?.postMessage(message); }, []);

  const sendState = useCallback(
    (counts: PanelCounts) => post({ channel: 1, type: "gauntlet:state", ...counts }),
    [post],
  );
  const close = useCallback(() => post({ channel: 1, type: "gauntlet:close" }), [post]);
  const setExpanded = useCallback((expanded: boolean) => {
    if (portRef.current === undefined || expandedRef.current === expanded) return;
    expandedRef.current = expanded;
    post({ channel: 1, type: "gauntlet:resize", expanded });
  }, [post]);

  return { state, context, openCount, sendState, close, setExpanded };
}
