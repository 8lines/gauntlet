import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { desktopOperation, installApiFixture, recordedState } from "./api-fixture.ts";

/** Settings lives in the sidebar footer, so the navigation has to be opened first when it is a sheet or collapsed. */
async function openSettings(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  const reachable = await page.locator("#gauntlet-navigation").evaluateAll(
    (nodes) => nodes.some((node) => !(node as HTMLElement).inert && getComputedStyle(node).display !== "none"),
  );
  if (!reachable) await toggle.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

/** Dialogs fade in; contrast is only meaningful once the finite animations (not a looping indicator) have ended. */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)),
  ));
}

async function scan(page: Page, screen: string, theme: "light" | "dark") {
  // A dark scan on a light page (or the reverse) would pass for the wrong reason.
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await settled(page);
  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(({ id, impact, help, nodes }) => ({
      screen,
      id,
      impact,
      help,
      targets: nodes.map((node) => `${node.target.join(" ")}: ${node.failureSummary}`),
    }));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`overview, operation, run, search and settings have no serious violations (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(() => localStorage.setItem("gauntlet.preferences.v1", JSON.stringify({ theme: "system" })));
    await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await scan(page, "overview", theme);

    await page.goto(`/t/browser-target/o/${desktopOperation.id}`);
    await expect(page.getByRole("heading", { name: desktopOperation.label, exact: true })).toBeVisible();
    await scan(page, "operation", theme);

    const actions = page.getByRole("region", { name: "Operation actions" });
    const execute = actions.getByRole("button", { name: desktopOperation.label, exact: true });
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: desktopOperation.label, exact: true });
    // The application rejects the first attempt: the fields it names show their errors.
    const runs = `**/api/v1/targets/browser-target/operations/${desktopOperation.id}/runs`;
    await page.context().route(runs, (route) => route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        type: "urn:gauntlet:problem:validation-failed",
        title: "Validation failed",
        status: 400,
        errors: [{
          instancePath: "",
          schemaPath: "#/required",
          keyword: "required",
          message: "must have required property 'attachment'",
          params: { missingProperty: "attachment" },
        }],
      }),
    }));
    await execute.click();
    await confirm.click();
    await expect(page.getByRole("alert").getByText("Fix the input")).toBeVisible();
    await scan(page, "operation with a validation error", theme);
    await page.context().unroute(runs);

    await page.getByLabel("Attachment").setInputFiles({
      name: "accessibility-fixture.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("browser fixture"),
    });
    await expect.poll(async () => (await recordedState(page)).requests.filter(({ path }) => path.endsWith("/uploads"))).toHaveLength(1);
    await execute.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await scan(page, "confirmation", theme);
    await confirm.click();

    const cancelRun = page.getByRole("main").getByRole("button", { name: "Cancel", exact: true });
    await expect(cancelRun).toBeVisible();
    const progress = page.getByRole("progressbar", { name: "Run progress" });
    await expect(progress).toHaveAttribute("aria-valuenow", "33");
    await expect(progress).toHaveAttribute("data-state", "loading");
    await scan(page, "running run", theme);
    await cancelRun.click();
    await page.getByRole("button", { name: "Run again" }).click();
    await execute.click();
    await confirm.click();
    await expect(page.getByText("Processing finished")).toBeVisible({ timeout: 5_000 });
    await scan(page, "run result", theme);

    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", { name: "Search operations", exact: true });
    await expect(search).toBeVisible();
    await scan(page, "search", theme);
    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();

    await openSettings(page);
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await scan(page, "settings, appearance", theme);
    await settings.getByRole("tab", { name: "MCP", exact: true }).click();
    await expect(settings.getByRole("tabpanel", { name: "MCP", exact: true })).toBeVisible();
    await scan(page, "settings, MCP", theme);
  });
}

test("the navigation toggle reports whether the navigation is open", async ({ page }, testInfo) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  // Matched by slot: while the mobile sheet is open the rest of the page is hidden from the accessibility tree.
  const toggle = page.locator('[data-slot="sidebar-trigger"]');
  const mobile = testInfo.project.name === "mobile";
  await expect(toggle).toHaveAttribute("aria-expanded", mobile ? "false" : "true");
  if (mobile) await expect(toggle).not.toHaveAttribute("aria-controls");
  else await expect(toggle).toHaveAttribute("aria-controls", "gauntlet-navigation");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", mobile ? "true" : "false");
  if (mobile) await page.keyboard.press("Escape");
  else await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", mobile ? "false" : "true");
});

/** A running run that reports no totals, so its progress bar cannot show a fraction. */
async function openRunWithoutTotals(page: Page) {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.context().route("**/api/v1/targets/browser-target/runs/browser-run-01", (route) => route.fulfill({
    json: {
      id: "browser-run-01",
      operationId: desktopOperation.id,
      operationRevision: desktopOperation.revision,
      sequence: 1,
      state: "running",
      createdAt: "2026-09-03T12:00:00Z",
      updatedAt: "2026-09-03T12:00:01Z",
      startedAt: "2026-09-03T12:00:01Z",
      progress: { phase: "processing", message: "Processing file", updatedAt: "2026-09-03T12:00:01Z" },
      summary: { title: "Processing", tone: "neutral" },
      artifacts: [],
      actions: [],
    },
  }));
  await page.goto(`/t/browser-target/o/${desktopOperation.id}/r/browser-run-01`);
  const bar = page.getByRole("progressbar", { name: "Run progress" });
  await expect(bar).toBeVisible();
  return bar;
}

const indicatorAnimation = (bar: Locator) =>
  bar.locator("[data-slot=progress-indicator]").evaluate((node) => getComputedStyle(node).animationName);

test("a progress bar without totals is indeterminate and animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const bar = await openRunWithoutTotals(page);
  await expect(bar).not.toHaveAttribute("aria-valuenow");
  await expect(bar).toHaveAttribute("data-state", "indeterminate");
  expect(await indicatorAnimation(bar)).not.toBe("none");
});

test("an indeterminate progress bar stands still when the system asks to reduce motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const bar = await openRunWithoutTotals(page);
  await expect(bar).not.toHaveAttribute("aria-valuenow");
  await expect(bar).toHaveAttribute("data-state", "indeterminate");
  expect(await indicatorAnimation(bar)).toBe("none");
});

test("an indeterminate progress bar stands still when Gauntlet is set to reduce motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => localStorage.setItem(
    "gauntlet.preferences.v1",
    JSON.stringify({ theme: "system", reducedMotion: true, sidebarCollapsed: false }),
  ));
  const bar = await openRunWithoutTotals(page);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await expect(bar).not.toHaveAttribute("aria-valuenow");
  await expect(bar).toHaveAttribute("data-state", "indeterminate");
  expect(await indicatorAnimation(bar)).toBe("none");
});
