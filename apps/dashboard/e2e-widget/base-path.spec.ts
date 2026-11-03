import { expect, test, type Page } from "@playwright/test";

// The third control plane of e2e-widget/stack.mjs: served below /tester, with a shared password.
const HOST = "http://127.0.0.1:4416";
const ORIGIN = "http://localhost:4415";
const GAUNTLET = `${ORIGIN}/tester`;
const PASSWORD = "widget-password";
const APPLICATION = "11111111-1111-4111-8111-111111111111";

/** The loader's launcher lives in a closed shadow root, so click the host element's centre. */
async function toggleWidget(page: Page): Promise<void> {
  const launcher = page.locator("[data-gauntlet-widget]");
  await expect(launcher).toBeVisible();
  const box = await launcher.boundingBox();
  if (box === null) throw new Error("the widget launcher has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Every request the page sends to Gauntlet's origin, by path. */
function gauntletPaths(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === ORIGIN) paths.push(url.pathname);
  });
  return paths;
}

test("the widget loaded from below a base path opens its panel, signs in and lists operations there", async ({ page }) => {
  const paths = gauntletPaths(page);
  await page.goto(`${HOST}/applications/${APPLICATION}`);
  await toggleWidget(page);
  await expect(page.locator("iframe[data-gauntlet-panel]")).toHaveAttribute("src", `${GAUNTLET}/widget/`);
  const panel = page.frameLocator("iframe[data-gauntlet-panel]");
  const password = panel.getByLabel("Password");
  await password.fill(PASSWORD);
  await password.press("Enter");
  await expect(panel.getByRole("heading", { name: "On this page", exact: true })).toBeVisible();
  const open = panel.getByRole("link", { name: "Open in Gauntlet" }).first();
  await expect(open).toHaveAttribute("href", /^\/tester\/t\/shop\/o\//);

  expect(paths).toContain("/tester/widget/loader.js");
  expect(paths).toContain("/tester/widget/config.json");
  expect(paths).toContain("/tester/api/v1/auth/login");
  expect(paths.filter((path) => !path.startsWith("/tester/"))).toEqual([]);
});

test("the dashboard below a base path signs in, routes and reloads deep links there", async ({ page }) => {
  const paths = gauntletPaths(page);
  await page.goto(GAUNTLET);
  await expect(page).toHaveURL(`${GAUNTLET}/`);
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Gauntlet" })).toHaveCount(0);
  const operation = page.getByRole("link", { name: "Finalize agency application" }).first();
  await expect(operation).toHaveAttribute("href", /^\/tester\/t\/shop\/o\//);
  await operation.click();
  await expect(page).toHaveURL(new RegExp(`^${GAUNTLET}/t/shop/o/`));

  // A reload of a client-side route still finds the relative assets through <base href>.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Finalize agency application", exact: true })).toBeVisible();
  expect(paths.filter((path) => !path.startsWith("/tester/") && path !== "/tester")).toEqual([]);

  const outside = await page.request.get(`${ORIGIN}/api/v1/targets`);
  expect(outside.status()).toBe(404);
});
