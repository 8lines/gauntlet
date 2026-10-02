import { expect, test, type Frame, type FrameLocator, type Locator, type Page } from "@playwright/test";

const HOST = "http://127.0.0.1:4410";
const UNLISTED = "http://127.0.0.1:4412";
const GAUNTLET = "http://localhost:4411";
const PANEL_URL = `${GAUNTLET}/widget/`;
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const FINALIZE = "Finalize agency application";
const STANDALONE = "Open Gauntlet through the widget in your application";
const DESCRIPTION = "Exercise an explicitly registered agency application binding.";

function panel(page: Page): FrameLocator {
  return page.frameLocator("iframe[data-gauntlet-panel]");
}

function panelFrame(page: Page): Frame | undefined {
  return page.frames().find((frame) => frame.url() === PANEL_URL);
}

function section(page: Page, title: string): Locator {
  const frame = panel(page);
  return frame.locator("section").filter({ has: frame.getByRole("heading", { name: title, exact: true }) });
}

/**
 * Waits until both contextual rows show the subject and their descriptions. Descriptions come
 * from per-operation definitions read after the catalog; a row reserves one line for its
 * description meanwhile, but a longer description can still wrap and move the rows below it.
 */
async function contextualListSettled(page: Page, applicationId: string): Promise<void> {
  const contextual = section(page, "On this page");
  await expect(contextual.getByText(`for agency-application ${applicationId}`, { exact: true })).toHaveCount(2);
  await expect(contextual.getByText(DESCRIPTION, { exact: true })).toHaveCount(2);
}

/** The loader's launcher lives in a closed shadow root, so click the host element's centre. */
async function toggleWidget(page: Page): Promise<void> {
  const box = await page.locator("[data-gauntlet-widget]").boundingBox();
  if (box === null) throw new Error("the widget launcher has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Waits until pointer input at the panel's position reaches the panel at the matching local
 * coordinates. The panel is a cross-origin frame: after it is shown (from `display: none`) or
 * resized, Chromium updates its input routing asynchronously, and a click in that window lands
 * on the host's <iframe> element or at stale coordinates.
 */
async function panelTakesInput(page: Page): Promise<void> {
  const frame = panelFrame(page);
  if (frame === undefined) throw new Error("the panel frame is missing");
  await frame.evaluate(() => {
    const probe = window as unknown as { e2ePointer: string | undefined };
    probe.e2ePointer = undefined;
    document.addEventListener("pointermove", (event) => {
      probe.e2ePointer = `${Math.round(event.clientX)},${Math.round(event.clientY)}`;
    });
  });
  const box = await page.locator("iframe[data-gauntlet-panel]").boundingBox();
  if (box === null) throw new Error("the panel frame has no bounding box");
  let offset = 0;
  await expect.poll(async () => {
    offset = offset === 0 ? 1 : 0; // a pointermove needs an actual move
    await page.mouse.move(box.x + 8 + offset, box.y + 8);
    const seen = await frame.evaluate(() => (window as unknown as { e2ePointer?: string }).e2ePointer);
    return seen === `${8 + offset},8`;
  }).toBe(true);
}

async function openPanel(page: Page): Promise<void> {
  await toggleWidget(page);
  await expect(page.locator("iframe[data-gauntlet-panel]")).toBeVisible();
  await panelTakesInput(page);
}

async function panelWidth(page: Page): Promise<number> {
  return (await page.locator("iframe[data-gauntlet-panel]").boundingBox())?.width ?? 0;
}

test.describe.serial("the widget on a listed host origin", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("shows the contextual operations for the subject on the page", async () => {
    await page.goto(`${HOST}/applications/${FIRST}`);

    // Both agency-applications.finalize and .fail are placed on the agency-application subject.
    await expect(page.locator('[data-gauntlet-widget][data-gauntlet-count="2"]')).toBeVisible();
    await expect(page.locator("[data-gauntlet-widget]")).toHaveAttribute("data-gauntlet-state", "ready");
    await expect(page.locator("iframe[data-gauntlet-panel]")).toBeHidden();

    await openPanel(page);

    const finalize = section(page, "On this page").getByRole("button").filter({ hasText: FINALIZE });
    await expect(finalize).toBeVisible();
    await expect(finalize.getByText(`for agency-application ${FIRST}`, { exact: true })).toBeVisible();
    await contextualListSettled(page, FIRST);
  });

  test("prefills the subject, runs with confirmation and shows the result", async () => {
    const frame = panel(page);
    await section(page, "On this page").getByRole("button").filter({ hasText: FINALIZE }).click();

    await expect(frame.getByRole("heading", { name: FINALIZE, level: 1 })).toBeVisible();
    await expect(frame.getByRole("textbox", { name: "applicationId", exact: true })).toHaveValue(FIRST);
    // Searching would discard the open form, so search waits until the user goes back.
    await expect(frame.getByRole("searchbox", { name: "Search operations" })).toBeDisabled();
    expect(await panelWidth(page)).toBeLessThanOrEqual(400);

    await frame.getByRole("textbox", { name: "confirmationCode", exact: true }).fill("123456");
    await frame.getByRole("region", { name: "Operation actions" }).getByRole("button", { name: FINALIZE }).click();
    const dialog = frame.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: FINALIZE }).click();
    await expect(dialog).toBeHidden();

    await expect(frame.getByText(/Done/)).toBeVisible();
    await expect(frame.getByText("Application finalized", { exact: true })).toBeVisible();
    await expect(frame.getByText("Application finalized.", { exact: true })).toBeVisible();
    // While a run result shows, the drawer widens.
    await expect.poll(() => panelWidth(page)).toBeGreaterThan(400);
    await panelTakesInput(page);
  });

  test("running again collapses the drawer back to its narrow width", async () => {
    const frame = panel(page);
    await frame.getByRole("button", { name: "Run again" }).click();

    await expect(frame.getByText("Nothing has run yet", { exact: true })).toBeVisible();
    await expect.poll(() => panelWidth(page)).toBeLessThanOrEqual(400);
    await expect(frame.getByRole("searchbox", { name: "Search operations" })).toBeDisabled();
    await panelTakesInput(page);

    await frame.getByRole("button", { name: "Back", exact: true }).click();
    await expect(frame.getByRole("searchbox", { name: "Search operations" })).toBeEnabled();
  });

  test("SPA navigation updates the subject without reloading the panel", async () => {
    const frame = panelFrame(page);
    if (frame === undefined) throw new Error("the panel frame is missing");
    await frame.evaluate(() => {
      (window as unknown as { e2eMarker: string }).e2eMarker = "same document";
    });

    await page.evaluate((path) => history.pushState({}, "", path), `/applications/${SECOND}`);

    const finalize = section(page, "On this page").getByRole("button").filter({ hasText: FINALIZE });
    await expect(finalize.getByText(`for agency-application ${SECOND}`, { exact: true })).toBeVisible();
    await expect(finalize.getByText(`for agency-application ${FIRST}`, { exact: true })).toHaveCount(0);
    expect(await frame.evaluate(() => (window as unknown as { e2eMarker?: string }).e2eMarker)).toBe("same document");
  });

  test("an open operation keeps its subject after SPA navigation until the user takes the page values", async () => {
    const frame = panel(page);
    const search = frame.getByRole("searchbox", { name: "Search operations" });
    // Escape in a non-empty search clears the query and keeps the panel open.
    await search.fill("finalize");
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator("iframe[data-gauntlet-panel]")).toBeVisible();

    await contextualListSettled(page, SECOND);
    await section(page, "On this page").getByRole("button").filter({ hasText: FINALIZE }).click();
    await expect(frame.getByRole("heading", { name: FINALIZE, level: 1 })).toBeVisible();
    const applicationId = frame.getByRole("textbox", { name: "applicationId", exact: true });
    await expect(applicationId).toHaveValue(SECOND);
    const useCurrent = frame.getByRole("button", { name: "Use values from the page", exact: true });
    await expect(useCurrent).toHaveCount(0);

    await page.evaluate((path) => history.pushState({}, "", path), `/applications/${FIRST}`);
    await expect(useCurrent).toBeVisible();
    await expect(frame.getByText(`agency-application ${FIRST}`, { exact: true })).toBeVisible();
    await expect(applicationId).toHaveValue(SECOND);

    await useCurrent.click();
    await expect(applicationId).toHaveValue(FIRST);
    await expect(useCurrent).toHaveCount(0);

    await page.evaluate((path) => history.pushState({}, "", path), `/applications/${SECOND}`);
    await expect(useCurrent).toBeVisible();
    await frame.getByRole("button", { name: "Back", exact: true }).click();
    await contextualListSettled(page, SECOND);
  });

  test("lists the run under recent runs after a reload and opens its result", async () => {
    await page.reload();
    await expect(page.locator("[data-gauntlet-widget]")).toHaveAttribute("data-gauntlet-state", "ready");
    await openPanel(page);

    await contextualListSettled(page, SECOND);
    const recent = section(page, "Recent runs").getByRole("button").filter({ hasText: FINALIZE });
    await expect(recent).toHaveCount(1);
    await recent.click();

    const frame = panel(page);
    await expect(frame.getByRole("heading", { name: FINALIZE, level: 1 })).toBeVisible();
    await expect(frame.getByText(/Done/)).toBeVisible();
    await expect(frame.getByText("Application finalized", { exact: true })).toBeVisible();
    await expect(frame.getByText("Application finalized.", { exact: true })).toBeVisible();
    await expect(frame.getByText("Unavailable after a Gauntlet restart")).toHaveCount(0);
  });
});

test("a panel on the system theme paints the system colour scheme from its first render and follows changes", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark" });
  try {
    // Runs in every frame; only the panel's own origin gets the preference and the observer.
    await context.addInitScript((panelOrigin) => {
      if (location.origin !== panelOrigin) return;
      localStorage.setItem("gauntlet.preferences.v1", JSON.stringify({ theme: "system" }));
      const probe = window as unknown as { e2eDarkAtFirstRender?: boolean };
      const observer = new MutationObserver(() => {
        const root = document.getElementById("root");
        if (root === null || root.firstChild === null) return;
        probe.e2eDarkAtFirstRender = document.documentElement.classList.contains("dark");
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }, GAUNTLET);
    const page = await context.newPage();
    await page.goto(`${HOST}/applications/${FIRST}`);
    await expect(page.locator("[data-gauntlet-widget]")).toHaveAttribute("data-gauntlet-state", "ready");

    const frame = panelFrame(page);
    if (frame === undefined) throw new Error("the panel frame is missing");
    // One read, no retries: the class has to be there when #root first gets a child, not just eventually.
    expect(await frame.evaluate(() => (window as unknown as { e2eDarkAtFirstRender?: boolean }).e2eDarkAtFirstRender)).toBe(true);

    const isDark = () => frame.evaluate(() => document.documentElement.classList.contains("dark"));
    expect(await isDark()).toBe(true);
    // A hidden frame does not run media query change listeners, so follow the scheme change with the panel open.
    await openPanel(page);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(isDark).toBe(false);
  } finally {
    await context.close();
  }
});

test("an origin no target lists ends unavailable and never lists operations", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(`${GAUNTLET}/api/`)) apiRequests.push(request.url());
  });

  await page.goto(`${UNLISTED}/applications/${FIRST}`);

  const widget = page.locator("[data-gauntlet-widget]");
  // The loader gives the panel 10 seconds to become ready.
  await expect(widget).toHaveAttribute("data-gauntlet-state", "unavailable", { timeout: 15_000 });
  await expect(widget).toHaveAttribute("data-gauntlet-reason", "unreachable");
  // The loader did try to frame the real panel.
  await expect(page.locator("iframe[data-gauntlet-panel]")).toHaveAttribute("src", PANEL_URL);
  await expect(page.locator("iframe[data-gauntlet-panel]")).toBeHidden();
  await expect(panel(page).getByText(FINALIZE)).toHaveCount(0);
  await expect(panel(page).getByRole("heading", { name: "On this page" })).toHaveCount(0);
  // frame-ancestors kept the panel from loading, so it never asked for the catalog.
  expect(apiRequests).toEqual([]);
});

test("the panel opened directly explains itself and only listed origins may frame it", async ({ page }) => {
  await page.goto(PANEL_URL);
  await expect(page.getByText(STANDALONE, { exact: true })).toBeVisible();
  await expect(page.getByText(FINALIZE)).toHaveCount(0);

  const widgetResponse = await page.request.get(PANEL_URL);
  expect(widgetResponse.status()).toBe(200);
  expect(widgetResponse.headers()["content-security-policy"]).toBe("frame-ancestors http://127.0.0.1:4410");

  const dashboardResponse = await page.request.get(`${GAUNTLET}/`);
  expect(dashboardResponse.status()).toBe(200);
  expect(dashboardResponse.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
});
