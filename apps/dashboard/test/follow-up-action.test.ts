import assert from "node:assert/strict";
import { test } from "node:test";
import type { Problem } from "@8lines/gauntlet-protocol";
import {
  beginBrowserLaunch,
  executeFollowUp,
  followUpPath,
} from "../src/run-actions.ts";
import { navigate, parseRoute } from "../src/route.ts";

test("invoke-operation follow-up creates an internal Gauntlet route", () => {
  assert.equal(followUpPath({
    kind: "invoke-operation",
    label: "Open reset",
    operationId: "reset-user",
  }, "portal"), "/t/portal/o/reset-user");
});

test("invoke-operation follow-up keeps its input in navigation state", () => {
  const navigated: unknown[] = [];
  executeFollowUp({
    kind: "invoke-operation",
    label: "Open reset",
    operationId: "reset-user",
    input: { userId: "user/with?reserved=data" },
  }, "portal/west", {
    navigate: (route) => { navigated.push(route); },
    open: () => { throw new Error("invoke-operation must not open a browser URL"); },
  });

  assert.deepEqual(navigated, [{
    targetId: "portal/west",
    operationId: "reset-user",
    input: { userId: "user/with?reserved=data" },
  }]);
  assert.equal(followUpPath({
    kind: "invoke-operation",
    label: "Open reset",
    operationId: "reset-user",
    input: { userId: "user/with?reserved=data" },
  }, "portal/west"), "/t/portal%2Fwest/o/reset-user");
});

test("open-link follow-up opens only its declared URL", () => {
  const opened: string[] = [];
  executeFollowUp({
    kind: "open-link",
    label: "Open docs",
    url: "https://docs.example.test/result",
  }, "portal", {
    navigate: () => { throw new Error("open-link must not navigate inside Gauntlet"); },
    open: (url) => { opened.push(url); },
  });

  assert.deepEqual(opened, ["https://docs.example.test/result"]);
});

test("a blocked popup does not consume the one-time launch", async () => {
  let launchCalls = 0;
  const attempt = beginBrowserLaunch(
    "portal",
    "run-1",
    "launch-1",
    {
      openBlank: () => null,
      launch: async () => {
        launchCalls += 1;
        return {
          ok: true,
          data: {
            url: "https://app.example.test/one-shot",
            expiresAt: "2026-09-03T12:00:00Z",
            singleUse: true,
          },
        };
      },
    },
  );

  assert.equal(launchCalls, 0);
  assert.deepEqual(await attempt.result, {
    type: "urn:gauntlet:problem:popup-blocked",
    title: "The browser blocked the new window",
    status: 0,
    detail: "Allow Gauntlet to open new windows and try again.",
  });
});

test("browser launch navigates its pre-opened window only to the returned URL", async () => {
  const navigated: string[] = [];
  let closes = 0;
  const attempt = beginBrowserLaunch("portal", "run-1", "launch-1", {
    openBlank: () => ({
      navigate: (url) => { navigated.push(url); },
      close: () => { closes += 1; },
    }),
    launch: async () => ({
      ok: true,
      data: {
        url: "https://app.example.test/one-shot",
        expiresAt: "2026-09-03T12:00:00Z",
        singleUse: true,
      },
    }),
  });

  assert.equal(await attempt.result, undefined);
  assert.deepEqual(navigated, ["https://app.example.test/one-shot"]);
  assert.equal(closes, 0);
});

test("failed browser launch closes its blank window", async () => {
  const returnedProblem: Problem = {
    type: "urn:gauntlet:problem:launch-rejected",
    title: "Launch rejected",
    status: 409,
  };
  const navigated: string[] = [];
  let closes = 0;
  const attempt = beginBrowserLaunch("portal", "run-1", "launch-1", {
    openBlank: () => ({
      navigate: (url) => { navigated.push(url); },
      close: () => { closes += 1; },
    }),
    launch: async () => ({ ok: false, problem: returnedProblem }),
  });

  assert.equal(await attempt.result, returnedProblem);
  assert.deepEqual(navigated, []);
  assert.equal(closes, 1);
});

test("a stale or unmounted browser launch closes without late navigation", async () => {
  let resolveLaunch: ((result: {
    ok: true;
    data: { url: string; expiresAt: string; singleUse: true };
  }) => void) | undefined;
  const navigated: string[] = [];
  let closes = 0;
  const attempt = beginBrowserLaunch("portal", "run-1", "launch-1", {
    openBlank: () => ({
      navigate: (url) => { navigated.push(url); },
      close: () => { closes += 1; },
    }),
    launch: () => new Promise((resolve) => { resolveLaunch = resolve; }),
  });

  attempt.cancel();
  resolveLaunch?.({
    ok: true,
    data: {
      url: "https://app.example.test/late",
      expiresAt: "2026-09-03T12:00:00Z",
      singleUse: true,
    },
  });

  assert.equal(await attempt.result, undefined);
  assert.deepEqual(navigated, []);
  assert.equal(closes, 1);
});

test("active route snapshots exclude input while navigation transfers it in event state", () => {
  assert.deepEqual(parseRoute("/t/portal/o/reset-user"), {
    targetId: "portal",
    operationId: "reset-user",
  });

  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  const originalDispatch = Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent");
  const originalPopStateEvent = Object.getOwnPropertyDescriptor(globalThis, "PopStateEvent");
  const pushes: unknown[] = [];
  const events: Array<{ state: unknown }> = [];
  class TestPopStateEvent extends Event {
    readonly state: unknown;
    constructor(type: string, init: { state: unknown }) {
      super(type);
      this.state = init.state;
    }
  }

  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      pushState: (state: unknown, _unused: string, url: string) => { pushes.push({ state, url }); },
      replaceState: () => undefined,
    },
  });
  Object.defineProperty(globalThis, "dispatchEvent", {
    configurable: true,
    value: (event: { state: unknown }) => { events.push(event); return true; },
  });
  Object.defineProperty(globalThis, "PopStateEvent", {
    configurable: true,
    value: TestPopStateEvent,
  });

  try {
    const input = { userId: "not-in-the-path" };
    navigate({ targetId: "portal", operationId: "reset-user", input });
    assert.deepEqual(pushes, [{
      state: { gauntletInput: input },
      url: "/t/portal/o/reset-user",
    }]);
    assert.deepEqual(events.map(({ state }) => state), [{ gauntletInput: input }]);
  } finally {
    restoreGlobal("history", originalHistory);
    restoreGlobal("dispatchEvent", originalDispatch);
    restoreGlobal("PopStateEvent", originalPopStateEvent);
  }
});

function restoreGlobal(name: "history" | "dispatchEvent" | "PopStateEvent", descriptor: PropertyDescriptor | undefined) {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
