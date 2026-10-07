import { expect, test, type Page } from "@playwright/test";
import { desktopOperation, destructiveOperation, installApiFixture, recordedState } from "./api-fixture.ts";

/** On mobile the sidebar is a sheet behind the navigation toggle. */
async function openNavigation(page: Page, mobile: boolean) {
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible();
  if (mobile) await toggle.click();
}

async function pinRequests(page: Page) {
  return (await recordedState(page)).requests.filter(({ method }) => method === "PUT" || method === "DELETE");
}

function groups(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Operations" });
  return {
    navigation,
    pinned: navigation.getByRole("list", { name: "Pinned", exact: true }),
    security: navigation.getByRole("list", { name: "Security", exact: true }),
  };
}

test("pinning from the sidebar moves the operation into Pinned and unpinning moves it back", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  await installApiFixture(page, {
    operation: desktopOperation,
    additionalOperations: [destructiveOperation],
    scenario: mobile ? "mobile" : "desktop",
  });
  await page.goto("/");
  await openNavigation(page, mobile);
  const { pinned, security } = groups(page);

  await expect(security.getByRole("button", { name: destructiveOperation.label, exact: true })).toBeVisible();
  await expect(pinned).toHaveCount(0);

  await security.getByRole("button", { name: `Pin ${destructiveOperation.label}`, exact: true }).click();
  await expect(pinned.getByRole("button", { name: destructiveOperation.label, exact: true })).toBeVisible();
  await expect(security.getByRole("button", { name: destructiveOperation.label, exact: true })).toHaveCount(0);
  await expect(security.getByRole("button", { name: desktopOperation.label, exact: true })).toBeVisible();
  expect(await pinRequests(page)).toEqual([
    { method: "PUT", path: `/api/v1/targets/browser-target/pins/${destructiveOperation.id}` },
  ]);
  // Pinned sits above the feature groups.
  expect((await pinned.boundingBox())!.y).toBeLessThan((await security.boundingBox())!.y);

  // The pin is stored by the server, so it is still there after a reload (which also resets the recorded requests).
  await page.reload();
  await openNavigation(page, mobile);
  await expect(pinned.getByRole("button", { name: destructiveOperation.label, exact: true })).toBeVisible();

  await pinned.getByRole("button", { name: `Unpin ${destructiveOperation.label}`, exact: true }).click();
  await expect(pinned).toHaveCount(0);
  await expect(security.getByRole("button", { name: destructiveOperation.label, exact: true })).toBeVisible();
  await expect(security.getByRole("button", { name: `Pin ${destructiveOperation.label}`, exact: true })).toBeVisible();
  expect(await pinRequests(page)).toEqual([
    { method: "DELETE", path: `/api/v1/targets/browser-target/pins/${destructiveOperation.id}` },
  ]);
});

test("a pin the server refuses is undone and explained", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  await installApiFixture(page, {
    operation: desktopOperation,
    additionalOperations: [destructiveOperation],
    scenario: mobile ? "mobile" : "desktop",
    pinFailureStatus: 500,
  });
  await page.goto("/");
  await openNavigation(page, mobile);
  const { navigation, pinned, security } = groups(page);

  await security.getByRole("button", { name: `Pin ${destructiveOperation.label}`, exact: true }).click();
  await expect(navigation.getByRole("alert")).toHaveText("Could not pin the operation.");
  await expect(pinned).toHaveCount(0);
  await expect(security.getByRole("button", { name: destructiveOperation.label, exact: true })).toBeVisible();
});
