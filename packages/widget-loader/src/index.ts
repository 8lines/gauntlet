/**
 * Entry of `loader.js`, the script a host page includes from
 * `${gauntletOrigin}/widget/loader.js`. It discovers the Gauntlet origin from
 * its own script tag and installs `window.Gauntlet`, replaying the stub queue.
 * All top-level side effects of the bundle live here.
 */

import { createCommandProcessor, installGlobal } from "./commands.js";
import { deriveGauntletOrigin } from "./origin.js";
import { createDomRuntime } from "./runtime.js";

const current = document.currentScript;
const result = deriveGauntletOrigin([
  current instanceof HTMLScriptElement ? current.src : "",
  ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src$="/widget/loader.js"]'), (s) => s.src),
]);
if (!result.ok) {
  console.error(`Gauntlet widget: ${result.reason}`);
} else {
  const origin = result.origin;
  let processor: ReturnType<typeof createCommandProcessor>;
  const runtime = createDomRuntime({ gauntletOrigin: origin, explicitSubjects: () => processor.explicitSubjects() });
  processor = createCommandProcessor(runtime, { warn: (message) => console.warn(message) });
  const install = () => installGlobal(window as unknown as { Gauntlet?: unknown }, processor);
  // The widget appends to document.body, which may not exist yet when the loader runs from <head>.
  // Until then the stub keeps queueing commands.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}
