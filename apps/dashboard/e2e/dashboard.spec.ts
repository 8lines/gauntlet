import { expect, test } from "@playwright/test";
import {
  desktopOperation,
  destructiveOperation,
  installApiFixture,
  recordedRuns,
  recordedState,
} from "./api-fixture.ts";

test("mobile execution stays inside the viewport and confirms both modes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile acceptance");
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: destructiveOperation.label }).click();

  const roleGroup = page.getByRole("group", { name: "Role" });
  await expect(roleGroup).toBeVisible();
  const viewer = roleGroup.getByRole("button", { name: "viewer" });
  await expect(viewer).toHaveAttribute("aria-pressed", "false");
  await viewer.click();
  await expect(viewer).toHaveAttribute("aria-pressed", "true");

  const dryRun = page.getByRole("button", { name: "Dry run" });
  const liveRun = page.getByRole("button", { name: /delete$/ });
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
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.y).toBeGreaterThanOrEqual(16);
  expect(Math.round(dialogBox!.y + dialogBox!.height)).toBeLessThanOrEqual(828);
  expect(await dialog.locator("[data-dialog-content]").evaluate((node) => getComputedStyle(node).overflowY)).toBe("auto");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await liveRun.click();
  await dialog.getByRole("button", { name: /delete$/ }).click();
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

test("mobile navigation removes the closed drawer from view and focus order", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile acceptance");
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");

  const navigation = page.locator("#gauntlet-navigation");
  const hamburger = page.getByRole("button", { name: "Open navigation" });

  await expect(navigation).toBeHidden();
  await expect(navigation).toHaveAttribute("aria-hidden", "true");
  expect(await navigation.evaluate((element) => (element as HTMLElement).inert)).toBe(true);

  await hamburger.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("#gauntlet-navigation"))).toBeNull();

  await hamburger.click();
  await expect(navigation).toBeVisible();
  await expect(navigation).not.toHaveAttribute("aria-hidden", "true");
  const closeNavigation = page.getByRole("button", { name: "Close navigation" });
  await expect(closeNavigation).toBeFocused();
  const closeBox = await closeNavigation.boundingBox();
  expect(closeBox?.height).toBeGreaterThanOrEqual(44);
  expect(closeBox?.width).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(hamburger).toBeFocused();

  await hamburger.click();
  await expect(closeNavigation).toBeFocused();
  await page.getByRole("button", { name: destructiveOperation.label }).click();
  await expect(navigation).toBeHidden();
  await expect(hamburger).toBeFocused();
});

test("confirmation dialog contains focus and restores its exact trigger", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile acceptance");
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: destructiveOperation.label }).click();

  const trigger = page.getByRole("main").getByRole("button", { name: /delete$/ });
  await trigger.click();

  const dialog = page.getByRole("dialog");
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const confirm = dialog.getByRole("button", { name: /delete$/ });
  const appRoot = page.locator("#root");

  await expect(dialog).toBeVisible();
  await expect(confirm).toBeFocused();
  expect(await dialog.evaluate((element) => !document.querySelector("#root")!.contains(element))).toBe(true);
  await expect(appRoot).toHaveAttribute("aria-hidden", "true");
  expect(await appRoot.evaluate((element) => (element as HTMLElement).inert)).toBe(true);

  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(appRoot).not.toHaveAttribute("aria-hidden", "true");
  expect(await appRoot.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  await expect(trigger).toBeFocused();
});

test("desktop handles upload, polling, cancellation, rich results and follow-ups", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop acceptance");
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/t/browser-target");
  await page.getByRole("button", { name: /^Choose environment:/ }).click();
  await expect(page.getByRole("dialog", { name: "Environments", exact: true }).getByText("Acme Portal", { exact: true })).toBeVisible();
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

  const execute = page.getByRole("main").getByRole("button", { name: desktopOperation.label, exact: true });
  await execute.click();
  await page.getByRole("dialog").getByRole("button", { name: desktopOperation.label, exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel run" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect.poll(async () => (await recordedState(page)).requests.filter(({ path }) => path.endsWith("/cancel"))).toHaveLength(1);
  await expect(page.getByText("cancelled", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Run again" }).click();
  await execute.click();
  await page.getByRole("dialog").getByRole("button", { name: desktopOperation.label, exact: true }).click();
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
  const trigger = page.getByRole("button", { name: "Search operations", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search operations" });
  const search = dialog.getByRole("searchbox");
  await expect(search).toBeFocused();
  await search.fill("nonexistent operation");
  await expect(dialog.getByRole("status")).toHaveText("No matching results");
  await search.fill("Process");
  await search.press("ArrowDown");
  await expect(dialog.getByRole("link")).toBeFocused();
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

test("desktop sidebar collapses and overview links navigate to operations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop acceptance");
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  const navigation = page.locator("#gauntlet-navigation");
  const expectHeaderAligned = async () => {
    const workspace = (await page.getByRole("main").boundingBox())!;
    const header = (await page.locator(".app-header").boundingBox())!;
    const toggle = (await page.locator(".app-header > button").first().boundingBox())!;
    const profile = (await page.getByRole("button", { name: "User settings", exact: true }).boundingBox())!;
    expect(header.x).toBeCloseTo(workspace.x, 0);
    expect(header.width).toBeCloseTo(workspace.width, 0);
    expect(toggle.x).toBeCloseTo(workspace.x, 0);
    expect(profile.x + profile.width).toBeCloseTo(workspace.x + workspace.width, 0);
    expect(toggle.y + toggle.height / 2).toBeCloseTo(profile.y + profile.height / 2, 0);
  };
  await expectHeaderAligned();
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(navigation).toBeHidden();
  await expectHeaderAligned();
  const workspace = (await page.getByRole("main").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(workspace.x).toBeGreaterThan(0);
  expect(workspace.x).toBeCloseTo(viewport.width - workspace.x - workspace.width, 0);
  const profile = (await page.getByRole("button", { name: "User settings", exact: true }).boundingBox())!;
  expect(profile.x + profile.width).toBeLessThanOrEqual(workspace.x + workspace.width);
  expect(profile.y + profile.height).toBeLessThan(workspace.y);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(navigation).toBeVisible();
  await expectHeaderAligned();
  await page.getByRole("main").getByRole("link", { name: /Process test file/ }).click();
  await expect(page.getByRole("heading", { name: desktopOperation.label, exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: desktopOperation.label })).toHaveAttribute("aria-current", "page");
});

test("operation actions stay at the bottom while the content scrolls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 390 : 1440, height: 560 });
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${destructiveOperation.id}`);

  const execute = page.getByRole("main").getByRole("button", { name: /delete$/ });
  await expect(execute).toBeVisible();
  const before = (await execute.boundingBox())!;
  expect(before.y).toBeGreaterThan(450);
  expect(before.y + before.height).toBeLessThanOrEqual(560);

  const lastContent = page.getByText("The result will appear here, next to the form.", { exact: false });
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
