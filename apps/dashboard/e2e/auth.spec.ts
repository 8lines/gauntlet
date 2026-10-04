import { expect, test, type Page } from "@playwright/test";
import { desktopOperation, installApiFixture } from "./api-fixture.ts";

const operationPath = `/t/browser-target/o/${desktopOperation.id}`;

async function openNavigation(page: Page) {
  // The shell mounts once sign-in answers; checking the sidebar before that would toggle an open one closed.
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible();
  const reachable = await page.locator("#gauntlet-navigation").evaluateAll(
    (nodes) => nodes.some((node) => !(node as HTMLElement).inert && getComputedStyle(node).display !== "none"),
  );
  if (!reachable) await toggle.click();
}

test("a protected Gauntlet asks for the password and keeps the requested page", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop", auth: { password: "letmein" } });
  await page.goto(operationPath);

  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();
  const password = page.getByLabel("Password");
  await expect(password).toBeFocused();
  await expect(page.getByLabel("Username")).toHaveCount(0);

  await password.fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect password.");
  await expect(password).toHaveValue("");

  await password.fill("letmein");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toHaveCount(0);
  await expect(page).toHaveURL(operationPath);
  await expect(page.getByRole("heading", { name: desktopOperation.label, exact: true })).toBeVisible();
});

test("per-user sign-in asks for a username too", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop", auth: { username: "anna", password: "letmein" } });
  await page.goto("/");
  await page.getByLabel("Username").fill("anna");
  await page.getByLabel("Password").fill("nope");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect username or password.");
  await page.getByLabel("Password").fill("letmein");
  await page.getByRole("button", { name: "Sign in" }).click();
  await openNavigation(page);
  await expect(page.getByText("Signed in as anna")).toBeVisible();
});

test("an expired session returns to sign-in on the same page", async ({ page }) => {
  const fixture = await installApiFixture(page, { operation: desktopOperation, scenario: "desktop", auth: { password: "letmein" } });
  await page.goto("/");
  await page.getByLabel("Password").fill("letmein");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toHaveCount(0);

  fixture.expireSession();
  await page.goto(operationPath);
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();
  await page.getByLabel("Password").fill("letmein");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(operationPath);
  await expect(page.getByRole("heading", { name: desktopOperation.label, exact: true })).toBeVisible();
});

test("log out returns to sign-in", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop", auth: { password: "letmein", loginDelayMs: 500 } });
  await page.goto("/");
  await page.getByLabel("Password").fill("letmein");
  await page.getByRole("button", { name: "Sign in" }).click();
  await openNavigation(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();
});

test("without authentication there is no sign-in and no log out", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop" });
  await page.goto("/");
  await openNavigation(page);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toHaveCount(0);
});

test("a log out the server refuses keeps the user signed in", async ({ page }) => {
  await installApiFixture(page, { operation: desktopOperation, scenario: "desktop", auth: { password: "letmein", logoutStatus: 403, loginDelayMs: 500 } });
  await page.goto("/");
  await page.getByLabel("Password").fill("letmein");
  await page.getByRole("button", { name: "Sign in" }).click();
  await openNavigation(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not log out");
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toHaveCount(0);
});
