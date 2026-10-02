import { expect, test, type Locator, type Page } from "@playwright/test";
import { desktopOperation, installApiFixture, operationWithRevision } from "./api-fixture.ts";

const operation = operationWithRevision({
  ...desktopOperation,
  label: "Verify all pending applications and finish processing agency submissions",
  execution: { ...desktopOperation.execution, dryRunSupported: true },
});
const targetLabel = "Environment for verifying extended business scenarios";

/** The sidebar width transition would otherwise be measured half way. */
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
}

async function expectContained(child: Locator, parent: Locator) {
  const inside = (await child.boundingBox())!;
  const outside = (await parent.boundingBox())!;
  expect(inside.x).toBeGreaterThanOrEqual(outside.x);
  expect(inside.x + inside.width).toBeLessThanOrEqual(outside.x + outside.width + 1);
  expect(inside.y).toBeGreaterThanOrEqual(outside.y);
  expect(inside.y + inside.height).toBeLessThanOrEqual(outside.y + outside.height + 1);
}

test("long operation labels keep both actions visible across workspace widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one responsive width matrix");
  await installApiFixture(page, { operation, scenario: "desktop", targetLabel });
  await page.goto(`/t/browser-target/o/${operation.id}`);
  for (const width of [320, 390, 640, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await settled(page);
    const actions = page.getByRole("region", { name: "Operation actions" });
    const execute = actions.getByRole("button", { name: operation.label, exact: true });
    const dryRun = actions.getByRole("button", { name: "Dry run" });
    await expectContained(execute, actions);
    await expectContained(dryRun, actions);
    for (const button of [execute, dryRun]) {
      expect(await button.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    }
    expect(await actions.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    expect((await breadcrumbs.boundingBox())!.height).toBeLessThanOrEqual(24);
    await expectContained(actions, page.getByRole("main"));
    const header = page.getByRole("banner");
    await expectContained(page.getByRole("button", { name: "Search environments and operations" }), header);
    await expectContained(page.getByRole("button", { name: "Toggle navigation" }), header);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  }
});

test("the shell switches between the sidebar and the mobile sheet at the md breakpoint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one responsive width matrix");
  await installApiFixture(page, { operation, scenario: "desktop", targetLabel });
  await page.goto(`/t/browser-target/o/${operation.id}`);
  const trigger = page.getByRole("button", { name: "Toggle navigation" });
  const environment = `Choose environment: ${targetLabel}`;

  await page.setViewportSize({ width: 767, height: 800 });
  await expect(page.locator("#gauntlet-navigation")).toHaveCount(0);
  await trigger.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expectContained(sheet.getByRole("button", { name: environment }), sheet);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 768, height: 800 });
  const sidebar = page.locator("#gauntlet-navigation");
  await expect(sidebar).toBeVisible();
  await expectContained(sidebar.getByRole("button", { name: environment }), sidebar);
});

test("short viewports keep dialog controls reachable in both themes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 320 : 800, height: 360 });
  await installApiFixture(page, { operation, scenario: "desktop", targetLabel });
  await page.goto("/");
  for (const theme of ["Light", "Dark"]) {
    if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Toggle navigation" }).click();
    const sidebar = testInfo.project.name === "mobile" ? page.getByRole("dialog") : page.locator("#gauntlet-navigation");
    await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "User settings", exact: true });
    await settings.getByRole("radio", { name: theme, exact: true }).check();
    const done = settings.getByRole("button", { name: "Done", exact: true });
    await expectContained(done, settings);
    await expect(done).toBeInViewport();
    await done.click();
    await page.getByRole("button", { name: "Search environments and operations", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search operations", exact: true });
    const close = search.getByRole("button", { name: "Close search" });
    await expectContained(close, search);
    await search.getByRole("link", { name: new RegExp(operation.label) }).focus();
    await expectContained(close, search);
    await expect(close).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();
  }
});
