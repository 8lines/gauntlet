import { expect, test, type Locator } from "@playwright/test";
import { desktopOperation, installApiFixture, operationWithRevision } from "./api-fixture.ts";

const operation = operationWithRevision({
  ...desktopOperation,
  label: "Verify all pending applications and finish processing agency submissions",
  execution: { ...desktopOperation.execution, dryRunSupported: true },
});
const targetLabel = "Environment for verifying extended business scenarios";

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
    const pageBody = page.locator(".page-body");
    await expectContained(actions, page.getByRole("main"));
    expect((await pageBody.boundingBox())!.width).toBeGreaterThan(0);
    const insets = await page.locator(".page-heading, .page-body, .page-inset, .action-bar").evaluateAll(
      (nodes) => nodes.map((node) => getComputedStyle(node).paddingLeft),
    );
    expect(new Set(insets).size).toBe(1);
  }
});

test("short viewports keep dialog controls reachable in both themes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 320 : 800, height: 360 });
  await installApiFixture(page, { operation, scenario: "desktop", targetLabel });
  await page.goto("/");
  for (const theme of ["Light", "Dark"]) {
    await page.getByRole("button", { name: "User settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "User settings", exact: true });
    await settings.getByRole("radio", { name: theme, exact: true }).check();
    const done = settings.getByRole("button", { name: "Done", exact: true });
    await expectContained(done, settings);
    await expect(done).toBeInViewport();
    await done.click();
    await page.getByRole("button", { name: "Search operations", exact: true }).click();
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
