import { expect, test } from "@playwright/test";
import { desktopOperation, destructiveOperation, installApiFixture } from "./api-fixture.ts";

test("MCP settings prepare a client connection for the chosen server URL", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });

  await page.getByRole("button", { name: "User settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "User settings", exact: true });
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  const connection = settings.getByRole("region", { name: "MCP connection" });
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
  await page.getByRole("button", { name: "User settings", exact: true }).click();
  await page.getByRole("dialog", { name: "User settings", exact: true })
    .getByRole("button", { name: "MCP", exact: true }).click();

  const connection = page.getByRole("region", { name: "MCP connection" });
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
  await page.getByRole("button", { name: "User settings", exact: true }).click();

  const settings = page.getByRole("dialog", { name: "User settings", exact: true });
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  await expect(settings.getByRole("region", { name: "MCP connection" })).toBeVisible();
  await expect(settings.getByRole("radio", { name: "Light" })).toBeHidden();
  await expect(settings.getByRole("button", { name: "Done" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  const content = settings.locator(".overflow-y-auto");
  await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
});

test("MCP address survives switching settings sections", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await page.getByRole("button", { name: "User settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "User settings", exact: true });
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  const url = settings.getByRole("textbox", { name: "MCP server URL" });
  await url.fill("https://gauntlet.internal.example/mcp");
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  await expect(url).toHaveValue("https://gauntlet.internal.example/mcp");
});

test("user settings apply and persist theme, motion and sidebar preferences", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "User settings", exact: true });
  await expect(trigger).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await trigger.click();
  const settings = page.getByRole("dialog", { name: "User settings", exact: true });
  await settings.getByRole("radio", { name: "Dark", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.getByRole("main").evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  await settings.getByRole("switch", { name: "Reduce motion", exact: true }).check();
  await settings.getByRole("switch", { name: "Collapsed navigation", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (testInfo.project.name === "desktop") await expect(page.locator("#gauntlet-navigation")).toBeHidden();
  const animation = await page.evaluate(() => {
    const cursor = document.createElement("span");
    cursor.className = "activity-dot";
    document.body.append(cursor);
    const animationName = getComputedStyle(cursor).animationName;
    cursor.remove();
    return animationName;
  });
  expect(animation).toBe("none");
  await trigger.click();
  await expect(settings.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(settings.getByRole("switch", { name: "Reduce motion", exact: true })).toBeChecked();
  await settings.getByRole("radio", { name: "System", exact: true }).check();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  await expect(settings).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
});

test("settings retain an unfinished operation and keep search behind the dialog", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto(`/t/browser-target/o/${destructiveOperation.id}`);
  const viewer = page.getByRole("group", { name: "Role" }).getByRole("button", { name: "viewer", exact: true });
  await viewer.click();
  await expect(viewer).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "User settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "User settings", exact: true });
  await settings.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search operations", exact: true })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(viewer).toHaveAttribute("aria-pressed", "true");
});
