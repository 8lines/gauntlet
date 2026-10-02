import { expect, test, type Page } from "@playwright/test";
import { desktopOperation, destructiveOperation, installApiFixture } from "./api-fixture.ts";

/** Settings lives in the sidebar footer, so the navigation has to be opened first when it is a sheet or collapsed. */
async function openSettings(page: Page) {
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible();
  const reachable = await page.locator("#gauntlet-navigation").evaluateAll(
    (nodes) => nodes.some((node) => !(node as HTMLElement).inert && getComputedStyle(node).display !== "none"),
  );
  if (!reachable) await toggle.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

test("MCP settings prepare a client connection for the chosen server URL", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });

  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "MCP", exact: true }).click();
  const connection = settings.getByRole("tabpanel", { name: "MCP", exact: true });
  const url = connection.getByRole("textbox", { name: "MCP server URL" });

  await expect(connection).toContainText("Streamable HTTP");
  await url.fill("https://gauntlet.internal.example/mcp");
  await connection.getByRole("button", { name: "Copy configuration" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '{\n  "mcpServers": {\n    "gauntlet": {\n      "url": "https://gauntlet.internal.example/mcp"\n    }\n  }\n}',
  );
});

test("MCP settings reject an address that cannot be used as an HTTP endpoint", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await openSettings(page);
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("tab", { name: "MCP", exact: true }).click();

  const connection = page.getByRole("tabpanel", { name: "MCP", exact: true });
  const url = connection.getByRole("textbox", { name: "MCP server URL" });
  const copy = connection.getByRole("button", { name: "Copy configuration" });
  await url.fill("ftp://example.internal/mcp");
  await expect(copy).toBeDisabled();
  await expect(connection).toContainText("Enter an HTTP or HTTPS URL ending in /mcp.");

  await url.fill("https://example.internal/api");
  await expect(copy).toBeDisabled();

  await url.fill("https://example.internal/gauntlet/mcp");
  await expect(copy).toBeEnabled();
});

test("MCP section opens directly while settings controls remain reachable on a short screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  await installApiFixture(page, { operation: desktopOperation, scenario: "mobile" });
  await page.goto("/");
  await openSettings(page);

  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "MCP", exact: true }).click();
  await expect(settings.getByRole("tabpanel", { name: "MCP", exact: true })).toBeVisible();
  await expect(settings.getByRole("radio", { name: "Light" })).toBeHidden();
  await expect(settings.getByRole("button", { name: "Done" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  const content = settings.locator(".overflow-y-auto");
  await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
});

test("MCP address survives switching settings sections", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("tab", { name: "MCP", exact: true }).click();
  const url = settings.getByRole("textbox", { name: "MCP server URL" });
  await url.fill("https://gauntlet.internal.example/mcp");
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  await settings.getByRole("tab", { name: "MCP", exact: true }).click();
  await expect(url).toHaveValue("https://gauntlet.internal.example/mcp");
});

test("user settings apply and persist theme, motion and sidebar preferences", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("radio", { name: "Dark", exact: true }).check();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  expect(await page.locator("main").evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  await settings.getByRole("switch", { name: "Reduce motion", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  // Focus goes back to where it was: the sidebar button, or the navigation toggle when it was a sheet.
  await expect(page.getByRole("button", { name: testInfo.project.name === "desktop" ? "Settings" : "Toggle navigation", exact: true })).toBeFocused();
  await openSettings(page);
  await settings.getByRole("switch", { name: "Collapsed navigation", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  if (testInfo.project.name === "desktop") await expect(page.locator("#gauntlet-navigation")).toHaveJSProperty("inert", true);
  const animation = await page.evaluate(() => {
    const cursor = document.createElement("span");
    cursor.className = "activity-dot";
    document.body.append(cursor);
    const animationName = getComputedStyle(cursor).animationName;
    cursor.remove();
    return animationName;
  });
  expect(animation).toBe("none");
  await openSettings(page);
  await expect(settings.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(settings.getByRole("switch", { name: "Reduce motion", exact: true })).toBeChecked();
  await settings.getByRole("radio", { name: "System", exact: true }).check();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await settings.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  await expect(settings).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
});

test("settings retain an unfinished operation and keep search behind the dialog", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${destructiveOperation.id}`);
  const viewer = page.getByRole("group", { name: "Role" }).getByRole("checkbox", { name: "viewer" });
  await viewer.click();
  await expect(viewer).toBeChecked();
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search operations", exact: true })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(viewer).toBeChecked();
});

test("system theme follows the operating system live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await openSettings(page);
  await page.getByRole("radio", { name: "System", exact: true }).check();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});
