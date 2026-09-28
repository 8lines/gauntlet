import assert from "node:assert/strict";
import { test } from "node:test";
import { boot, close, loadGauntletWidget, open, removeSubject, setSubject, shutdown } from "../src/index.js";

type FakeScript = { src: string; async: boolean };

function withFakeBrowser(action: (win: Record<string, any>, scripts: FakeScript[]) => void): void {
  const scripts: FakeScript[] = [];
  const win: Record<string, any> = {};
  const document = {
    createElement: (tag: string) => { assert.equal(tag, "script"); return { src: "", async: false }; },
    head: { appendChild: (node: FakeScript) => { scripts.push(node); } },
    querySelectorAll: (selector: string) => { assert.equal(selector, "script[src]"); return scripts; },
  };
  Object.assign(globalThis, { window: win, document });
  try {
    action(win, scripts);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  }
}

test("commands are no-ops without a window (SSR)", () => {
  assert.equal(typeof (globalThis as Record<string, unknown>).window, "undefined");
  boot({ target: "shop" });
  setSubject("order", { orderId: "1" });
  loadGauntletWidget("https://gauntlet.internal");
});

test("commands install the queue stub and enqueue in call order", () => {
  withFakeBrowser((win) => {
    boot({ target: "shop", routes: [{ pattern: "/orders/:orderId", subject: "order" }] });
    setSubject("order", { orderId: "1" });
    removeSubject("order");
    open();
    close();
    shutdown();
    assert.equal(typeof win.Gauntlet, "function");
    assert.deepEqual(win.Gauntlet.q.map((entry: ArrayLike<unknown>) => Array.from(entry)), [
      ["boot", { target: "shop", routes: [{ pattern: "/orders/:orderId", subject: "order" }] }],
      ["setSubject", "order", { orderId: "1" }],
      ["removeSubject", "order"],
      ["open"],
      ["close"],
      ["shutdown"],
    ]);
  });
});

test("commands call an already loaded Gauntlet function instead of replacing it", () => {
  withFakeBrowser((win) => {
    const calls: unknown[][] = [];
    win.Gauntlet = (...args: unknown[]) => { calls.push(args); };
    open();
    assert.deepEqual(calls, [["open"]]);
  });
});

test("loadGauntletWidget injects one async loader script from the Gauntlet origin", () => {
  withFakeBrowser((_win, scripts) => {
    loadGauntletWidget("https://gauntlet.internal/some/path?x=1");
    loadGauntletWidget("https://gauntlet.internal");
    assert.deepEqual(scripts, [{ src: "https://gauntlet.internal/widget/loader.js", async: true }]);
    assert.throws(() => loadGauntletWidget("ftp://gauntlet.internal"), TypeError);
    assert.throws(() => loadGauntletWidget("not a url"), TypeError);
  });
});
