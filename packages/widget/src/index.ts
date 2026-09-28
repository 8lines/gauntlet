export type SubjectValue = string | number | boolean;
export type SubjectValues = Readonly<Record<string, SubjectValue>>;
/** One subject of the page context, for example `{ type: "order", values: { orderId: "123" } }`. */
export interface PageSubject {
  readonly type: string;
  readonly values: SubjectValues;
}
export type RouteRule =
  | { readonly pattern: string; readonly subject: string }
  | { readonly pattern: string; readonly subjects: Readonly<Record<string, readonly string[]>> };
export type ButtonPosition = "bottom-right" | "bottom-left";
export interface BootOptions {
  readonly target: string;
  readonly routes?: readonly RouteRule[];
  readonly position?: ButtonPosition;
}
export type GauntletCommandName = "boot" | "setSubject" | "removeSubject" | "open" | "close" | "shutdown";
export interface GauntletFunction {
  (command: GauntletCommandName, ...args: unknown[]): void;
  q?: ArrayLike<unknown>[];
}

function gauntlet(): GauntletFunction | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as unknown as { Gauntlet?: GauntletFunction };
  if (typeof host.Gauntlet !== "function") {
    const stub: GauntletFunction = function (this: unknown) {
      (stub.q ||= []).push(arguments);
    } as GauntletFunction;
    host.Gauntlet = stub;
  }
  return host.Gauntlet;
}

function command(name: GauntletCommandName, ...args: unknown[]): void {
  gauntlet()?.(name, ...args);
}

export function boot(options: BootOptions): void {
  command("boot", options);
}
export function setSubject(type: string, values: SubjectValues): void {
  command("setSubject", type, values);
}
export function removeSubject(type: string): void {
  command("removeSubject", type);
}
export function open(): void {
  command("open");
}
export function close(): void {
  command("close");
}
export function shutdown(): void {
  command("shutdown");
}

/** Injects `<script async src="<origin>/widget/loader.js">` once. `gauntletUrl` is the Gauntlet base URL. */
export function loadGauntletWidget(gauntletUrl: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  let origin: string;
  try {
    const url = new URL(gauntletUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError();
    origin = url.origin;
  } catch {
    throw new TypeError("Gauntlet URL must be an http(s) URL");
  }
  const src = `${origin}/widget/loader.js`;
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    if (script.src === src) return;
  }
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}
