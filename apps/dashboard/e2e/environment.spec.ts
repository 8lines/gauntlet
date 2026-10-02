import { expect, test, type Page } from "@playwright/test";
import { destructiveOperation, followUpOperation, installApiFixture, recordedState } from "./api-fixture.ts";

async function countTargetRequests(page: Page): Promise<number> {
  return (await recordedState(page)).requests.filter(({ method, path }) => method === "GET" && path === "/api/v1/targets").length;
}

/** Replaces the environments response with the fixture's, extended by `change` (an extra operation, diagnostics). */
async function extendTargets(page: Page, change: (target: Record<string, any>) => void): Promise<void> {
  const payload = await page.evaluate(async () => (await fetch("/api/v1/targets")).json());
  change(payload.targets[0]);
  await page.context().route("**/api/v1/targets", (route) => route.fulfill({ json: payload }));
}

test("environment dropdown preserves the current form and switches to another target", async ({ page }, testInfo) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  const targets = await page.evaluate(async () => (await fetch("/api/v1/targets")).json());
  await page.context().route("**/api/v1/targets", (route) => route.fulfill({
    json: { targets: [...targets.targets, {
      id: "offline-target", label: "Second environment", tags: [], state: "offline",
      refreshedAt: new Date().toISOString(),
    }] },
  }));
  await page.goto(`/t/browser-target/o/${destructiveOperation.id}`);
  const mobile = testInfo.project.name === "mobile";
  const viewer = page.getByRole("group", { name: "Role" }).getByRole("checkbox", { name: "viewer" });
  await viewer.check();
  const openNavigation = async () => {
    if (mobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
  };
  const closeNavigation = async () => {
    if (!mobile) return;
    await expect(async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 500 });
    }).toPass();
  };
  await openNavigation();
  const trigger = page.getByRole("button", { name: /^Choose environment:/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Browser environment/ })).toBeFocused();
  // On mobile the navigation sheet may still be sliding in; the menu must settle inside the viewport.
  await expect.poll(async () => {
    const box = (await menu.boundingBox())!;
    return box.x >= 0 && box.x + box.width <= page.viewportSize()!.width;
  }).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await closeNavigation();
  await expect(viewer).toBeChecked();

  await openNavigation();
  await trigger.click();
  await page.getByRole("menuitem", { name: /Browser environment/ }).click();
  await expect(menu).toBeHidden();
  await closeNavigation();
  await expect(viewer).toBeChecked();

  await openNavigation();
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: /Second environment/ })).toContainText("Unavailable");
  await page.getByRole("menuitem", { name: /Second environment/ }).click();
  await expect(page).toHaveURL(/\/t\/offline-target$/);
  await expect(menu).toBeHidden();
  await closeNavigation();
  await expect(page.getByRole("heading", { level: 1, name: "Second environment", exact: true })).toBeVisible();
  await expect(page.getByText("The environment did not send a valid operation catalog.")).toBeVisible();
  const expectEnvironment = async (label: string) => {
    await openNavigation();
    await expect(trigger).toHaveAccessibleName(`Choose environment: ${label}`);
    await closeNavigation();
  };
  await expectEnvironment("Second environment");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Second environment" })).toBeHidden();
  await expectEnvironment("Browser environment");
});

test("catalog table describes operation impact and confirmation and links to the operation", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Browser environment" })).toBeVisible();
  const row = page.getByRole("row", { name: /Delete test data/ });
  await expect(row).toContainText("deletes data");
  await expect(row).toContainText("Asks you to confirm");
  await expect(row.getByRole("rowheader")).toContainText(destructiveOperation.id);
  await row.getByRole("link", { name: "Delete test data" }).click();
  await expect(page).toHaveURL(`/t/browser-target/o/${destructiveOperation.id}`);
});

test("unavailable operation metadata never claims an operation is read-only", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.context().route(`**/operations/${destructiveOperation.id}`, (route) => route.fulfill({
    status: 503, json: { type: "urn:gauntlet:problem:unavailable", title: "Unavailable", status: 503 },
  }));
  await page.goto("/");
  const row = page.getByRole("row", { name: /Delete test data/ });
  await expect(row).toContainText("Details unavailable");
  await expect(row).not.toContainText("read only");
  await expect(row).not.toContainText("Loading");
});

test("catalog filter matches labels and ids and explains an empty result", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  const filter = page.getByRole("textbox", { name: "Filter operations" });
  await filter.fill("  DELETE ");
  await expect(page.getByRole("row", { name: /Delete test data/ })).toBeVisible();
  await expect(page.getByText("1 of 1")).toBeVisible();
  await filter.fill("browser-delete-fixture");
  await expect(page.getByRole("row", { name: /Delete test data/ })).toBeVisible();
  await filter.fill("no such operation");
  await expect(page.getByText("No operations match")).toBeVisible();
  await expect(page.getByText("Try a different name or operation id.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await filter.fill("");
  await expect(page.getByRole("row", { name: /Delete test data/ })).toBeVisible();
});

test("unavailable operations stay listed, cannot be opened, and are found by id", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  await extendTargets(page, (target) => {
    target.manifest.operations.push({
      id: "search.reset",
      revision: `sha256:${"0".repeat(64)}`,
      label: "Reset search index",
      featureId: target.manifest.operations[0].featureId,
      availability: {
        state: "unavailable",
        problem: { type: "urn:gauntlet:problem:unsupported-capability", title: "Unsupported", status: 501 },
      },
    });
    target.manifest.diagnostics = [{
      severity: "warning", code: "catalog.schema.deprecated-keyword", message: "An operation uses a deprecated schema keyword.",
    }];
  });
  await page.reload();

  const unavailable = page.getByRole("row", { name: /Reset search index/ });
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await expect(unavailable).toContainText("Unavailable");
  await expect(unavailable).toContainText("This application does not provide this feature.");
  await expect(unavailable.getByRole("link")).toHaveCount(0);
  await unavailable.getByText("Reset search index").click({ force: true });
  await expect(page).toHaveURL("/t/browser-target");

  const stats = page.getByRole("term").filter({ hasText: "Need attention" }).locator("xpath=..");
  await expect(stats).toContainText("2");
  await expect(stats).toContainText("1 diagnostic, 1 unavailable operation");
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention).toContainText("An operation uses a deprecated schema keyword.");
  await expect(attention).toContainText("catalog.schema.deprecated-keyword");

  await page.getByRole("textbox", { name: "Filter operations" }).fill("SEARCH.Reset");
  await expect(unavailable).toBeVisible();
  await expect(page.getByRole("row", { name: /Delete test data/ })).toHaveCount(0);
  await expect(page.getByText("1 of 2")).toBeVisible();
});

test("recent runs survive corrupted storage and list new runs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gauntlet.recent-runs.v1", "{not json"));
  await installApiFixture(page, { operation: followUpOperation, scenario: "run-url" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Browser environment" })).toBeVisible();
  await expect(page.getByText("Runs you start in this browser appear here.")).toBeVisible();

  await page.getByRole("link", { name: followUpOperation.label }).click();
  await page.getByRole("region", { name: "Operation actions" })
    .getByRole("button", { name: followUpOperation.label, exact: true }).click();
  await expect(page).toHaveURL(/\/r\/browser-run-01$/);
  await expect(page.getByText(/^\W+Done$/)).toBeVisible({ timeout: 10_000 });

  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Browser environment" })).toBeVisible();
  const recent = page.getByRole("region", { name: "Your recent runs" });
  const link = recent.getByRole("link", { name: /Done/ }).first();
  await expect(link).toBeVisible();
  await expect(link).toContainText(followUpOperation.label);
  await expect(link).toHaveAttribute("href", `/t/browser-target/o/${followUpOperation.id}/r/browser-run-01`);
  await link.click();
  await expect(page).toHaveURL(`/t/browser-target/o/${followUpOperation.id}/r/browser-run-01`);
});

test("blocked storage still renders the overview with no recent runs", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "localStorage", {
      get() { throw new DOMException("Storage is blocked", "SecurityError"); },
    });
  });
  await installApiFixture(page, { operation: followUpOperation, scenario: "mobile" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Browser environment" })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(followUpOperation.label) })).toBeVisible();
  await expect(page.getByText("Runs you start in this browser appear here.")).toBeVisible();
});

test("refresh reloads the environments", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Browser environment" })).toBeVisible();
  const before = await countTargetRequests(page);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => countTargetRequests(page)).toBeGreaterThan(before);
});

test("a failed refresh keeps the last environments and reports the problem", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Browser environment" })).toBeVisible();
  const failing = (route: import("@playwright/test").Route) => route.fulfill({
    status: 503, json: { type: "urn:gauntlet:problem:unavailable", title: "Gauntlet is restarting", status: 503 },
  });
  await page.context().route("**/api/v1/targets", failing);
  await page.getByRole("button", { name: "Refresh" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Could not refresh environments" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Gauntlet is restarting");
  await expect(page.getByRole("heading", { level: 1, name: "Browser environment" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Delete test data/ })).toBeVisible();
  await expect(page.getByText("Could not load environments")).toHaveCount(0);

  await page.context().unroute("**/api/v1/targets", failing);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(alert).toBeHidden();
  await expect(page.getByRole("row", { name: /Delete test data/ })).toBeVisible();
});
