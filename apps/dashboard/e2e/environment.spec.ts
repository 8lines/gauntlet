import { expect, test } from "@playwright/test";
import { destructiveOperation, installApiFixture } from "./api-fixture.ts";

test("environment dropdown preserves the current form and switches to another target", async ({ page }) => {
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
  const viewer = page.getByRole("group", { name: "Role" }).getByRole("button", { name: "viewer", exact: true });
  await viewer.click();
  const trigger = page.getByRole("button", { name: /^Choose environment:/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dropdown = page.getByRole("dialog", { name: "Environments", exact: true });
  await expect(dropdown).toBeVisible();
  await expect(dropdown.getByRole("button", { name: /Browser environment/ })).toBeFocused();
  const box = (await dropdown.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(dropdown).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(viewer).toHaveAttribute("aria-pressed", "true");
  await trigger.click();
  await dropdown.getByRole("button", { name: /Browser environment/ }).click();
  await expect(dropdown).toBeHidden();
  await expect(viewer).toHaveAttribute("aria-pressed", "true");
  await trigger.click();
  await expect(dropdown.getByRole("button", { name: /Second environment/ })).toContainText("unavailable");
  await dropdown.getByRole("button", { name: /Second environment/ }).click();
  await expect(page).toHaveURL(/\/t\/offline-target$/);
  await expect(page.getByRole("heading", { name: "Second environment", exact: true })).toBeVisible();
  await expect(dropdown).toBeHidden();
  await expect(trigger).toHaveAccessibleName("Choose environment: Second environment");
  await page.goBack();
  await expect(trigger).toHaveAccessibleName("Choose environment: Browser environment");
});

test("sidebar describes operation impact and confirmation without duplicating the environment", async ({ page }, testInfo) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.goto("/");
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.locator("#gauntlet-navigation");
  await expect(sidebar.getByRole("button", { name: destructiveOperation.label, exact: true })).toContainText("Deletes data · Confirmation");
  await expect(sidebar.getByText("Browser environment")).toHaveCount(0);
  await expect(sidebar.getByText(/Refreshed/)).toHaveCount(0);
});

test("unavailable operation metadata never claims an operation is read-only", async ({ page }, testInfo) => {
  await installApiFixture(page, { operation: destructiveOperation, scenario: "mobile" });
  await page.context().route(`**/operations/${destructiveOperation.id}`, (route) => route.fulfill({
    status: 503, json: { type: "urn:gauntlet:problem:unavailable", title: "Unavailable", status: 503 },
  }));
  await page.goto("/");
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  const operation = page.locator("#gauntlet-navigation").getByRole("button", { name: destructiveOperation.label, exact: true });
  await expect(operation).toContainText("Details unavailable");
  await expect(operation).not.toContainText("Read only");
});
