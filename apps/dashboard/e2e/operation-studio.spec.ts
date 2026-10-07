import { expect, test } from "@playwright/test";
import { destructiveOperation, installApiFixture, namedRun, operationWithRevision } from "./api-fixture.ts";
import { waitForStableLayout } from "./layout-stability.ts";

const operation = operationWithRevision({
  ...destructiveOperation,
  inputHandling: undefined,
  label: "Wipe the demo database and restore the production seed",
  description: "Replaces the demo database with the production seed. ".repeat(12),
});

test("studio fills the workspace and collapsing details preserves input", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop studio geometry");
  await page.setViewportSize({ width: 1920, height: 900 });
  await installApiFixture(page, { operation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${operation.id}`);
  const input = page.getByRole("region", { name: "Input", exact: true });
  const result = page.getByRole("region", { name: "Result", exact: true });
  await expect(input).toBeVisible();
  await expect(result).toBeVisible();
  await page.getByRole("checkbox", { name: "viewer" }).check();
  await waitForStableLayout(page);
  const before = (await input.boundingBox())!;
  const output = (await result.boundingBox())!;
  const workspace = (await page.getByRole("main").boundingBox())!;
  expect(Math.abs(before.y - output.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(before.width - output.width)).toBeLessThanOrEqual(1);
  expect(before.x - workspace.x).toBeLessThanOrEqual(32);
  const details = page.getByRole("complementary", { name: "Operation details", exact: true });
  await expect(details).toBeVisible();
  await page.screenshot({ path: info.outputPath("studio-desktop.png") });
  expect((await details.boundingBox())!.x + (await details.boundingBox())!.width).toBeCloseTo(workspace.x + workspace.width, 0);
  await page.getByRole("button", { name: "Hide details", exact: true }).click();
  await expect(details).toHaveCount(0);
  await waitForStableLayout(page);
  expect((await input.boundingBox())!.width).toBeGreaterThan(before.width + 100);
  await expect(page.getByRole("checkbox", { name: "viewer" })).toBeChecked();
  await page.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(details).toBeVisible();
  expect((await page.locator('[data-operation-header]').boundingBox())!.height).toBeLessThan(160);
});

test("mobile details sheet traps focus and returns to its trigger", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "mobile details sheet");
  await installApiFixture(page, { operation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${operation.id}`);
  const trigger = page.getByRole("button", { name: "Show details", exact: true });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Operation details", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("What this operation does", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Your recent runs", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Definition", exact: true }).click();
  await expect(sheet.getByText(operation.revision, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("studio-mobile-details.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("checkbox", { name: "viewer" })).toBeVisible();
});

test("new runs immediately appear in operation history", async ({ page }, info) => {
  await installApiFixture(page, { operation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${operation.id}`);
  await page.getByRole("region", { name: "Operation actions" }).getByRole("button", { name: "Execute", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Execute", exact: true }).click();
  await expect(page.getByRole("region", { name: "Result", exact: true }).getByText("Processing finished", { exact: true })).toBeVisible();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Show details", exact: true }).click();
  const history = page.getByRole("region", { name: "Your recent runs", exact: true });
  await expect(history.getByRole("link", { name: /browser-run-01/ })).toBeVisible();
  await history.getByRole("link", { name: /browser-run-01/ }).click();
  if (info.project.name === "mobile") await expect(page.getByRole("dialog", { name: "Operation details", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Result", exact: true }).getByText("Processing finished", { exact: true })).toBeVisible();
});

test("operation history filters by target and operation and opens a result without clearing input", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop history navigation");
  await installApiFixture(page, { operation, scenario: "mobile" });
  await page.addInitScript(({ id, label }) => localStorage.setItem("gauntlet.recent-runs.v1", JSON.stringify([
    { targetId: "browser-target", operationId: id, label, runId: "matching-run", startedAt: "2026-09-03T12:00:01Z" },
    { targetId: "another-target", operationId: id, label, runId: "other-target-run", startedAt: "2026-09-03T12:00:01Z" },
    { targetId: "browser-target", operationId: "another-operation", label, runId: "other-operation-run", startedAt: "2026-09-03T12:00:01Z" },
  ])), { id: operation.id, label: operation.label });
  await page.route("**/api/v1/targets/browser-target/runs/matching-run", (route) => route.fulfill({
    json: namedRun(operation, "matching-run", "succeeded", "Historical result"),
  }));
  await page.goto(`/t/browser-target/o/${operation.id}`);
  await page.getByRole("checkbox", { name: "viewer" }).check();
  const history = page.getByRole("region", { name: "Your recent runs", exact: true });
  await expect(history.getByRole("link")).toHaveCount(1);
  await history.getByRole("link", { name: /matching-run/ }).click();
  await expect(page).toHaveURL(/\/r\/matching-run$/);
  await expect(page.getByText("Historical result", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "viewer" })).toBeChecked();
});

test("confirmation controls fit inside the dialog with long operation titles at every width", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one responsive matrix");
  await installApiFixture(page, { operation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${operation.id}`);
  for (const width of [320, 390, 640, 800, 1440]) {
    await page.setViewportSize({ width, height: 500 });
    await page.getByRole("region", { name: "Operation actions" }).getByRole("button", { name: "Execute", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await waitForStableLayout(page);
    for (const button of [dialog.getByRole("button", { name: "Cancel", exact: true }), dialog.getByRole("button", { name: "Execute", exact: true })]) {
      await button.scrollIntoViewIfNeeded();
      const outer = (await dialog.boundingBox())!;
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(outer.x);
      expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
      expect(await button.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await expect(button).toBeInViewport();
    }
    expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
  }
});

test("long titles on short screens keep the form and both actions reachable", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one short-screen width matrix");
  const longOperation = operationWithRevision({
    ...operation,
    inputHandling: undefined,
    label: "Wipe the demo database and restore the production seed, then rebuild every agency application and refresh all pending submissions for this environment",
  });
  await installApiFixture(page, { operation: longOperation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${longOperation.id}`);
  for (const width of [320, 390, 640, 800]) {
    await page.setViewportSize({ width, height: 360 });
    await waitForStableLayout(page);
    const actions = page.getByRole("region", { name: "Operation actions" });
    const box = (await actions.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(360);
    await expect(actions.getByRole("button", { name: "Execute", exact: true })).toBeInViewport();
    await expect(actions.getByRole("button", { name: "Dry run", exact: true })).toBeInViewport();
    await expect(page.getByRole("region", { name: "Input", exact: true })).toBeInViewport();
  }
});
