import { expect, test } from "@playwright/test";
import dashboardPackage from "../package.json" with { type: "json" };
import {
  desktopOperation,
  destructiveOperation,
  followUpInput,
  followUpOperation,
  installApiFixture,
  recordedRuns,
  recordedState,
} from "./api-fixture.ts";

test("the sidebar footer shows the build version on desktop and in the mobile sheet", async ({ page }, testInfo) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: testInfo.project.name === "mobile" ? "mobile" : "desktop" });
  await page.goto("/");
  const version = `Gauntlet v${dashboardPackage.version}`;

  if (testInfo.project.name === "mobile") {
    await expect(page.getByText(version)).toBeHidden();
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await expect(page.getByRole("dialog").getByText(version, { exact: true })).toBeVisible();
    return;
  }
  const navigation = page.locator("#gauntlet-navigation");
  await expect(navigation.getByText(version, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(navigation).toHaveJSProperty("inert", true);
  await expect(navigation.getByText(version, { exact: true })).not.toBeInViewport();
});

test("mobile execution stays inside the viewport and confirms both modes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile acceptance");
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");

  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: destructiveOperation.label }).click();

  const roleGroup = page.getByRole("group", { name: "Role" });
  await expect(roleGroup).toBeVisible();
  const viewer = roleGroup.getByRole("checkbox", { name: "viewer" });
  await expect(viewer).not.toBeChecked();
  await viewer.click();
  await expect(viewer).toBeChecked();

  const actions = page.getByRole("region", { name: "Operation actions" });
  const dryRun = actions.getByRole("button", { name: "Dry run" });
  const liveRun = actions.getByRole("button", { name: destructiveOperation.label, exact: true });
  for (const control of [dryRun, liveRun]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(350);
  }

  await dryRun.click();
  await expect.poll(() => recordedRuns(page)).toMatchObject([{
    dryRun: true,
    confirmation: {
      operationId: destructiveOperation.id,
      operationRevision: destructiveOperation.revision,
      impact: "destructive",
    },
  }]);
  await page.getByRole("button", { name: "Run again" }).click();

  await liveRun.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.y).toBeGreaterThanOrEqual(16);
  expect(Math.round(dialogBox!.y + dialogBox!.height)).toBeLessThanOrEqual(828);
  expect(await dialog.evaluate((node) => getComputedStyle(node).overflowY)).toBe("auto");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await liveRun.click();
  await dialog.getByRole("button", { name: destructiveOperation.label, exact: true }).click();
  await expect.poll(() => recordedRuns(page)).toMatchObject([
    { dryRun: true },
    {
      dryRun: false,
      confirmation: {
        operationId: destructiveOperation.id,
        operationRevision: destructiveOperation.revision,
        impact: "destructive",
      },
    },
  ]);

  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBe(widths.viewport);
});

test("mobile navigation removes the closed sheet from view and focus order", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile acceptance");
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");

  const sheet = page.getByRole("dialog");
  const trigger = page.getByRole("button", { name: "Toggle navigation" });

  await expect(sheet).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("[data-slot=sidebar]"))).toBeNull();

  await trigger.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: destructiveOperation.label, exact: true })).toBeVisible();
  // Radix hides the page behind the sheet from assistive technology.
  await expect(page.getByRole("main")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await sheet.getByRole("button", { name: destructiveOperation.label, exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/o/${destructiveOperation.id}$`));
});

test("confirmation dialog contains focus and restores its exact trigger", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile acceptance");
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");

  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: destructiveOperation.label }).click();

  const trigger = page.getByRole("region", { name: "Operation actions" })
    .getByRole("button", { name: destructiveOperation.label, exact: true });
  await trigger.click();

  const dialog = page.getByRole("alertdialog");
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const confirm = dialog.getByRole("button", { name: destructiveOperation.label, exact: true });
  const appRoot = page.locator("#root");

  // The AlertDialog starts on the least destructive action and keeps focus inside (Radix focus scope).
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  expect(await dialog.evaluate((element) => !document.querySelector("#root")!.contains(element))).toBe(true);
  await expect(appRoot).toHaveAttribute("aria-hidden", "true");

  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(appRoot).not.toHaveAttribute("aria-hidden", "true");
  await expect(trigger).toBeFocused();
});

test("desktop handles upload, polling, cancellation, rich results and follow-ups", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop acceptance");
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/t/browser-target");
  await page.getByRole("button", { name: /^Choose environment:/ }).click();
  await expect(page.getByRole("menu").getByText("Acme Portal", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: desktopOperation.label }).click();

  await page.getByLabel("Attachment").setInputFiles({
    name: "desktop-fixture.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("browser fixture"),
  });
  await expect.poll(async () => (await recordedState(page)).requests.filter(({ path }) => path.endsWith("/uploads"))).toMatchObject([
    { method: "POST", fileNames: ["desktop-fixture.txt"] },
  ]);

  const execute = page.getByRole("region", { name: "Operation actions" })
    .getByRole("button", { name: desktopOperation.label, exact: true });
  await execute.click();
  await page.getByRole("alertdialog").getByRole("button", { name: desktopOperation.label, exact: true }).click();
  const cancelRun = page.getByRole("main").getByRole("button", { name: "Cancel", exact: true });
  await expect(cancelRun).toBeVisible();
  await cancelRun.click();
  await expect.poll(async () => (await recordedState(page)).requests.filter(({ path }) => path.endsWith("/cancel"))).toHaveLength(1);
  await expect(page.getByText(/^\W+Cancelled$/)).toBeVisible();

  await page.getByRole("button", { name: "Run again" }).click();
  await execute.click();
  await page.getByRole("alertdialog").getByRole("button", { name: desktopOperation.label, exact: true }).click();
  await expect(page.getByText("Processing finished")).toBeVisible({ timeout: 5_000 });
  await expect.poll(async () => (await recordedState(page)).requests.filter(({ method, path }) => method === "GET" && path.endsWith("/runs/browser-run-01"))).not.toHaveLength(0);

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  expect(await table.evaluate((node) => node.parentElement!.scrollWidth > node.parentElement!.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);

  const external = page.getByRole("link", { name: "Open ↗" });
  await expect(external).toHaveAttribute("href", "https://docs.example.test/result");
  await expect(external).toHaveAttribute("target", "_blank");
  await expect(external).toHaveAttribute("rel", /noopener/);

  const launchCard = page.getByText("Open test session", { exact: true }).first().locator("..");
  const popupPromise = page.waitForEvent("popup");
  await launchCard.getByRole("button", { name: "Open" }).click();
  const popup = await popupPromise;
  expect(popup.url()).toBe("about:blank");
  await expect.poll(async () => (await recordedState(page)).requests.filter(({ path }) => path.endsWith("/launch"))).toHaveLength(1);
  await expect.poll(() => popup.url()).toBe("http://127.0.0.1:4173/t/launched-session");

  await page.getByText("Reuse the result", { exact: true }).locator("../..").getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(`/t/browser-target/o/${desktopOperation.id}`);
  await expect(page.getByText("review-notes.txt", { exact: true })).toBeVisible();
});

test("reduced motion removes the cursor animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  const animationName = await page.evaluate(() => {
    const cursor = document.createElement("span");
    cursor.className = "activity-dot";
    document.body.append(cursor);
    return getComputedStyle(cursor).animationName;
  });
  expect(animationName).toBe("none");
});

test("search filters operations, supports keyboard navigation and restores focus", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operation catalog" })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Search environments and operations", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search operations" });
  const search = dialog.getByRole("combobox");
  await expect(search).toBeFocused();
  await search.fill("nonexistent operation");
  await expect(dialog.getByText("No matching results")).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await search.fill("Process");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowDown");
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: desktopOperation.label, exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("search lists recent runs of the current environment and opens one", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.addInitScript((operationId) => {
    localStorage.setItem("gauntlet.recent-runs.v1", JSON.stringify([
      { targetId: "browser-target", operationId, label: "Process test file", runId: "run-recent-1", startedAt: new Date().toISOString() },
      { targetId: "other-target", operationId, label: "Elsewhere", runId: "run-other", startedAt: new Date().toISOString() },
    ]));
  }, desktopOperation.id);
  await page.goto("/t/browser-target");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search operations" });
  const runs = dialog.getByRole("group", { name: "Recent runs" });
  await expect(runs.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option", { name: /Elsewhere/ })).toHaveCount(0);
  await runs.getByRole("option", { name: /Process test file/ }).click();
  await expect(page).toHaveURL(`/t/browser-target/o/${desktopOperation.id}/r/run-recent-1`);
});

test("desktop sidebar collapses, stays collapsed after a reload and navigates to operations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop acceptance");
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  const navigation = page.locator("#gauntlet-navigation");
  const sidebar = page.locator('[data-slot="sidebar"]');
  const trigger = page.getByRole("button", { name: "Toggle navigation" });
  const expectHeaderAligned = async () => {
    const main = (await page.getByRole("main").boundingBox())!;
    const header = (await page.getByRole("banner").boundingBox())!;
    const toggle = (await trigger.boundingBox())!;
    const search = (await page.getByRole("button", { name: "Search environments and operations" }).boundingBox())!;
    expect(header.x).toBeCloseTo(main.x, 0);
    expect(header.width).toBeCloseTo(main.width, 0);
    expect(toggle.x).toBeGreaterThan(main.x);
    expect(search.x + search.width).toBeLessThanOrEqual(main.x + main.width);
    expect(toggle.y + toggle.height / 2).toBeCloseTo(search.y + search.height / 2, 0);
    expect(header.y + header.height).toBeCloseTo(main.y, 0);
  };

  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(navigation.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expectHeaderAligned();
  const expandedMain = (await page.getByRole("main").boundingBox())!;
  expect(expandedMain.x).toBeGreaterThanOrEqual(256);

  await trigger.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(navigation).toHaveJSProperty("inert", true);
  await expect.poll(async () => (await page.getByRole("main").boundingBox())!.x).toBeCloseTo(0, 0);
  expect((await page.getByRole("main").boundingBox())!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  await expectHeaderAligned();

  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(navigation).toHaveJSProperty("inert", false);
  await navigation.getByRole("button", { name: desktopOperation.label }).click();
  await expect(page.getByRole("heading", { name: desktopOperation.label, exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: desktopOperation.label })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Browser environment" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText(desktopOperation.label, { exact: true })).toHaveAttribute("aria-current", "page");
});

test("operation actions stay at the bottom while the content scrolls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 390 : 1440, height: 560 });
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${destructiveOperation.id}`);

  const execute = page.getByRole("region", { name: "Operation actions" })
    .getByRole("button", { name: destructiveOperation.label, exact: true });
  await expect(execute).toBeVisible();
  const before = (await execute.boundingBox())!;
  expect(before.y).toBeGreaterThan(450);
  expect(before.y + before.height).toBeLessThanOrEqual(560);

  const lastContent = page.getByText("The result will appear here when the run finishes.", { exact: false });
  await lastContent.scrollIntoViewIfNeeded();
  await expect(lastContent).toBeInViewport();
  const after = (await execute.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 0);
  const actions = page.getByRole("region", { name: "Operation actions" });
  const actionsBox = (await actions.boundingBox())!;
  const contentBox = (await lastContent.boundingBox())!;
  // Scroll offsets snap to whole pixels, so the text can end a subpixel past the bar's edge.
  expect(contentBox.y + contentBox.height).toBeLessThanOrEqual(actionsBox.y + 1);
  expect(await actions.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(255, 255, 255)");
});

test("a run URL survives reload and keeps polling", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop acceptance");
  await installApiFixture(page, { operation: followUpOperation, scenario: "run-url" });
  await page.goto(`/t/browser-target/o/${followUpOperation.id}`);
  await page.getByRole("region", { name: "Operation actions" })
    .getByRole("button", { name: followUpOperation.label, exact: true }).click();

  await expect(page).toHaveURL(`/t/browser-target/o/${followUpOperation.id}/r/browser-run-01`);
  await page.reload();
  await expect(page.getByText(/^\W+Running$/)).toBeVisible();
  await expect(page.getByText(/^\W+Done$/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Invitation sent", { exact: true })).toBeVisible();
  const polls = (await recordedState(page)).requests
    .filter(({ method, path }) => method === "GET" && path.endsWith("/runs/browser-run-01"));
  expect(polls.length).toBeGreaterThanOrEqual(2);
});

test("an unknown run shows that it is no longer available", async ({ page }, testInfo) => {
  await installApiFixture(page, { operation: followUpOperation, scenario: testInfo.project.name === "mobile" ? "mobile" : "desktop" });
  await page.goto(`/t/browser-target/o/${encodeURIComponent(followUpOperation.id)}/r/run_missing`);
  await expect(page.getByText("This run is no longer available")).toBeVisible();
  await page.getByRole("button", { name: "Back to the form" }).click();
  await expect(page).toHaveURL(`/t/browser-target/o/${followUpOperation.id}`);
  await expect(page.getByText("Nothing has run yet")).toBeVisible();
});

test("a follow-up into the same operation reopens the form with its input", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop acceptance");
  await installApiFixture(page, { operation: followUpOperation, scenario: "run-url" });
  await page.goto(`/t/browser-target/o/${followUpOperation.id}`);
  await page.getByRole("region", { name: "Operation actions" })
    .getByRole("button", { name: followUpOperation.label, exact: true }).click();
  await expect(page).toHaveURL(/\/r\/browser-run-01$/);
  await expect(page.getByText(/^\W+Done$/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Open", exact: true }).first().click();
  await expect(page).not.toHaveURL(/\/r\//);
  await expect(page.getByLabel("Email")).toHaveValue(followUpInput.email);
  await expect(page.getByText("Nothing has run yet")).toBeVisible();
});
