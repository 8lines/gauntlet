import { expect, test, type Frame, type Page } from "@playwright/test";

const HOST = "http://127.0.0.1:4390";
const OTHER = "http://127.0.0.1:4392";
const UNLISTED = "http://127.0.0.1:4393";
const PANEL_URL = "http://localhost:4391/widget/";
const SILENT_PANEL_URL = "http://localhost:4391/silent/widget/";

interface Received {
  readonly type: string;
  readonly context?: unknown;
}

/** Globals the fake panel, the evil frame and the host fixture page expose. */
interface FixtureWindow {
  received: Received[];
  connects: number;
  oldPort: MessagePort | undefined;
  panelSend(message: unknown): void;
  announceReady(): void;
  gotPort: boolean;
  originalPushState: History["pushState"];
  originalReplaceState: History["replaceState"];
  Gauntlet(...args: unknown[]): void;
}

function order(orderId: string) {
  return { target: "shop", subjects: [{ type: "order", values: { orderId } }] };
}

function panelFrame(page: Page): Frame | undefined {
  return page.frames().find((frame) => frame.url() === PANEL_URL);
}

async function received(page: Page): Promise<Received[]> {
  const frame = panelFrame(page);
  if (frame === undefined) return [];
  try {
    return await frame.evaluate(() => (window as unknown as FixtureWindow).received ?? []);
  } catch {
    return []; // the panel is navigating
  }
}

async function contexts(page: Page): Promise<unknown[]> {
  return (await received(page)).filter((message) => message.type === "gauntlet:context").map((message) => message.context);
}

async function panelSend(page: Page, message: unknown): Promise<void> {
  const frame = panelFrame(page);
  if (frame === undefined) throw new Error("the panel frame is missing");
  await frame.evaluate((value) => (window as unknown as FixtureWindow).panelSend(value), message);
}

async function gauntlet(page: Page, ...args: unknown[]): Promise<void> {
  await page.evaluate((values) => (window as unknown as FixtureWindow).Gauntlet(...values), args);
}

test("sends the contextual subject for the current path without leaking the URL", async ({ page }) => {
  await page.goto(`${HOST}/orders/123?secret=x#frag`);

  await expect.poll(() => contexts(page)).toEqual([order("123")]);
  const widget = page.locator("[data-gauntlet-widget]");
  await expect(widget).toHaveAttribute("data-gauntlet-state", "ready");
  await expect(widget).toHaveAttribute("data-gauntlet-count", "1");

  const everything = JSON.stringify(await received(page));
  for (const leak of ["secret", "frag", "127.0.0.1"]) expect(everything).not.toContain(leak);
  expect(await panelFrame(page)!.evaluate(() => document.referrer)).toBe("http://127.0.0.1:4390/");
});

test("a loader that runs from <head> before <body> exists still boots", async ({ page }) => {
  await page.goto(`${HOST}/orders/123?scenario=head`);

  await expect(page.locator("[data-gauntlet-widget]")).toHaveAttribute("data-gauntlet-state", "ready");
  await expect.poll(() => contexts(page)).toEqual([order("123")]);
});

test("SPA navigation updates the context only when the path's subjects change", async ({ page }) => {
  await page.goto(`${HOST}/orders/123`);
  await expect.poll(() => contexts(page)).toEqual([order("123")]);

  await page.evaluate(() => history.pushState({}, "", "/orders/456"));
  await expect.poll(() => contexts(page)).toEqual([order("123"), order("456")]);

  await page.evaluate(() => history.pushState({}, "", "/orders/456?x=1"));
  await page.waitForTimeout(100);
  await page.evaluate(() => history.replaceState({}, "", "/orders/456"));
  await page.waitForTimeout(300);
  expect(await contexts(page)).toEqual([order("123"), order("456")]);

  await page.evaluate(() => history.go(-2));
  await expect.poll(() => contexts(page)).toEqual([order("123"), order("456"), order("123")]);
});

test("explicit subjects override URL subjects and removing them restores the URL value", async ({ page }) => {
  await page.goto(`${HOST}/orders/123`);
  await expect.poll(() => contexts(page)).toEqual([order("123")]);

  await gauntlet(page, "setSubject", "order", { orderId: "999" });
  await expect.poll(() => contexts(page)).toEqual([order("123"), order("999")]);

  await gauntlet(page, "removeSubject", "order");
  await expect.poll(() => contexts(page)).toEqual([order("123"), order("999"), order("123")]);
});

test("commands queued before the loader apply to the first context", async ({ page }) => {
  await page.goto(`${HOST}/orders/123?scenario=queued`);

  await expect
    .poll(async () => (await contexts(page))[0])
    .toEqual({
      target: "shop",
      subjects: [
        { type: "order", values: { orderId: "123" } },
        { type: "cart", values: { cartId: "c1" } },
      ],
    });
});

test("the button opens the panel, which can widen and close itself", async ({ page }) => {
  await page.goto(`${HOST}/orders/123`);
  const widget = page.locator("[data-gauntlet-widget]");
  const iframe = page.locator("iframe[data-gauntlet-panel]");
  await expect(widget).toHaveAttribute("data-gauntlet-state", "ready");
  await expect(iframe).toBeHidden();

  const box = await widget.boundingBox();
  if (box === null) throw new Error("the widget button has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(iframe).toBeVisible();
  await expect.poll(async () => (await received(page)).some((message) => message.type === "gauntlet:open")).toBe(true);

  await panelSend(page, { channel: 1, type: "gauntlet:resize", expanded: true });
  await expect.poll(async () => (await iframe.boundingBox())?.width ?? 0).toBeGreaterThan(400);

  await panelSend(page, { channel: 1, type: "gauntlet:close" });
  await expect(iframe).toBeHidden();
});

function collectWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  return warnings;
}

test("an origin the target does not list becomes unavailable and tells the developer why", async ({ page }) => {
  const warnings = collectWarnings(page);

  // 4392 is listed for another target only, so the panel loads and rejects target "shop".
  await page.goto(`${OTHER}/orders/123`);

  const widget = page.locator("[data-gauntlet-widget]");
  await expect(widget).toHaveAttribute("data-gauntlet-state", "unavailable");
  await expect(widget).toHaveAttribute("data-gauntlet-reason", "rejected");
  expect(warnings.some((warning) => warning.includes("rejected") && warning.includes("http://127.0.0.1:4392") && warning.includes('"shop"'))).toBe(true);
  await expect(page.locator("iframe[data-gauntlet-panel]")).toBeHidden();
});

test("an origin no target lists cannot frame the panel and times out with a configuration hint", async ({ page }) => {
  const warnings = collectWarnings(page);
  await page.clock.install();

  await page.goto(`${UNLISTED}/orders/123`);
  const widget = page.locator("[data-gauntlet-widget]");
  await expect(widget).toHaveAttribute("data-gauntlet-state", "connecting");
  await page.clock.runFor(2_000);
  await expect(page.locator("iframe[data-gauntlet-panel]")).toHaveAttribute("src", PANEL_URL);

  await expect(widget).not.toHaveAttribute("data-gauntlet-reason", /.*/);
  await page.clock.runFor(10_000);
  await expect(widget).toHaveAttribute("data-gauntlet-state", "unavailable");
  await expect(widget).toHaveAttribute("data-gauntlet-reason", "unreachable");
  const timeout = warnings.find((warning) => warning.includes("did not become ready"));
  expect(timeout, warnings.join("\n")).toBeDefined();
  for (const part of [PANEL_URL, UNLISTED, '"shop"', "widget.enabled", "targets[].widget.origins"]) expect(timeout).toContain(part);
  // The frame-ancestors policy blocked the panel, so it never got to reject the origin.
  expect(warnings.some((warning) => warning.includes("rejected"))).toBe(false);
});

test("a panel that never becomes ready makes the widget unavailable after 10 seconds", async ({ page }) => {
  await page.clock.install();
  // The panel URL is derived from the loader's origin only, so the silent panel
  // is served in place of /widget/ to simulate a Gauntlet that never answers.
  const silentPanel = await (await page.request.get(SILENT_PANEL_URL)).text();
  await page.route(PANEL_URL, (route) => route.fulfill({ contentType: "text/html", body: silentPanel }));
  await page.goto(`${HOST}/orders/123?scenario=silent`);
  const widget = page.locator("[data-gauntlet-widget]");
  await expect(widget).toHaveAttribute("data-gauntlet-state", "connecting");

  await page.clock.runFor(5_000);
  await expect(page.locator("iframe[data-gauntlet-panel]")).toHaveAttribute("src", PANEL_URL);
  await expect(widget).toHaveAttribute("data-gauntlet-state", "connecting");

  await page.clock.runFor(6_000);
  await expect(widget).toHaveAttribute("data-gauntlet-state", "unavailable");
  await expect(widget).toHaveAttribute("data-gauntlet-reason", "unreachable");
});

test("ready messages from frames other than the panel are ignored", async ({ page }) => {
  await page.goto(`${HOST}/orders/123?scenario=evil`);
  await expect(page.locator("[data-gauntlet-widget]")).toHaveAttribute("data-gauntlet-state", "ready");
  await expect(page.locator("[data-gauntlet-widget]")).not.toHaveAttribute("data-gauntlet-reason", /.*/);

  // One foreign-origin frame, and one frame on the Gauntlet origin that is not the panel iframe.
  const evilUrls = [`${OTHER}/evil.html`, "http://localhost:4391/evil-same-origin.html"];
  const evilFrames = () => page.frames().filter((frame) => evilUrls.includes(frame.url()));
  await expect.poll(() => evilFrames().length).toBe(2);
  await page.waitForTimeout(1_000); // the evil frames keep announcing ready every 100 ms

  for (const frame of evilFrames()) {
    expect(await frame.evaluate(() => (window as unknown as FixtureWindow).gotPort), frame.url()).toBe(false);
  }
  expect(await panelFrame(page)!.evaluate(() => (window as unknown as FixtureWindow).connects)).toBe(1);
});

test("a reloaded panel reconnects on a fresh port and the previous port goes dead", async ({ page }) => {
  await page.goto(`${HOST}/orders/123`);
  const widget = page.locator("[data-gauntlet-widget]");
  await expect(widget).toHaveAttribute("data-gauntlet-count", "1");
  const frame = panelFrame(page)!;

  const navigated = page.waitForEvent("framenavigated", (navigatedFrame) => navigatedFrame === frame);
  await frame.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  await navigated;

  // The reloaded document is connected again and receives the context again.
  await expect.poll(() => frame.evaluate(() => (window as unknown as FixtureWindow).connects).catch(() => 0)).toBe(1);
  await expect.poll(() => contexts(page)).toEqual([order("123")]);
  await panelSend(page, { channel: 1, type: "gauntlet:state", contextualCount: 5, globalCount: 1 });
  await expect(widget).toHaveAttribute("data-gauntlet-count", "5");

  // A document's ports die with it, so exercise the old port from a live document:
  // the panel announces ready again, the loader reconnects and must drop the previous port.
  await frame.evaluate(() => (window as unknown as FixtureWindow).announceReady());
  await expect.poll(() => frame.evaluate(() => (window as unknown as FixtureWindow).connects)).toBe(2);
  await expect(widget).toHaveAttribute("data-gauntlet-count", "1");

  await frame.evaluate(() =>
    (window as unknown as FixtureWindow).oldPort!.postMessage({ channel: 1, type: "gauntlet:state", contextualCount: 7, globalCount: 1 }),
  );
  await page.waitForTimeout(300);
  await expect(widget).toHaveAttribute("data-gauntlet-count", "1");

  await panelSend(page, { channel: 1, type: "gauntlet:state", contextualCount: 3, globalCount: 1 });
  await expect(widget).toHaveAttribute("data-gauntlet-count", "3");
});

test("a second loader copy does nothing and shutdown removes everything", async ({ page }) => {
  await page.goto(`${HOST}/orders/123?scenario=double`);
  const widget = page.locator("[data-gauntlet-widget]");
  const iframe = page.locator("iframe[data-gauntlet-panel]");
  await expect(page.locator('script[src$="/widget/loader.js"]')).toHaveCount(2);
  await expect(widget).toHaveAttribute("data-gauntlet-state", "ready");
  await expect(widget).toHaveCount(1);
  await expect(iframe).toHaveCount(1);
  await expect.poll(() => contexts(page)).toEqual([order("123")]);
  const panel = panelFrame(page)!;

  await gauntlet(page, "shutdown");
  await expect(widget).toHaveCount(0);
  await expect(iframe).toHaveCount(0);

  await page.evaluate(() => history.pushState({}, "", "/orders/789"));
  expect(panel.isDetached()).toBe(true);
  expect(panelFrame(page)).toBeUndefined();
  const restored = await page.evaluate(() => {
    const fixture = window as unknown as FixtureWindow;
    return {
      push: history.pushState === fixture.originalPushState,
      replace: history.replaceState === fixture.originalReplaceState,
      source: history.pushState.toString(),
    };
  });
  expect(restored.push).toBe(true);
  expect(restored.replace).toBe(true);
  expect(restored.source).toContain("[native code]");

  // A later boot starts over from the current path.
  await gauntlet(page, "boot", { target: "shop", routes: [{ pattern: "/orders/:orderId", subject: "order" }] });
  await expect.poll(() => contexts(page)).toEqual([order("789")]);
  await expect(widget).toHaveCount(1);
});
