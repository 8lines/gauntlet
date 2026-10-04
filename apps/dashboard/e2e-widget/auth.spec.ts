import { expect, test, type Frame, type Page } from "@playwright/test";

const HOST = "http://127.0.0.1:4414";
const PANEL_URL = "http://localhost:4413/widget/";
const PASSWORD = "widget-password";
const TOKEN_KEY = "gauntlet.session.v1";

/** The loader's launcher lives in a closed shadow root, so click the host element's centre. */
async function toggleWidget(page: Page): Promise<void> {
  const launcher = page.locator("[data-gauntlet-widget]");
  await expect(launcher).toBeVisible();
  const box = await launcher.boundingBox();
  if (box === null) throw new Error("the widget launcher has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function panelFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frame.url() === PANEL_URL)).toBe(true);
  return page.frames().find((frame) => frame.url() === PANEL_URL)!;
}

const storedToken = (frame: Frame) => frame.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);

test("a cross-site host over HTTP signs in inside the panel and stays signed in", async ({ page }) => {
  await page.goto(`${HOST}/applications/11111111-1111-4111-8111-111111111111`);
  await toggleWidget(page);
  const panel = page.frameLocator("iframe[data-gauntlet-panel]");
  await expect(panel.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();

  const password = panel.getByLabel("Password");
  await password.fill("wrong");
  await password.press("Enter");
  await expect(panel.getByRole("alert")).toContainText("Incorrect password.");

  await password.fill(PASSWORD);
  await password.press("Enter");
  await expect(panel.getByRole("heading", { name: "On this page", exact: true })).toBeVisible();
  // Plain HTTP: the browser refuses SameSite=None cookies, so the panel keeps a bearer token.
  expect(await storedToken(await panelFrame(page))).toMatch(/^g1\.s\./);

  await page.reload();
  await toggleWidget(page);
  await expect(panel.getByRole("heading", { name: "On this page", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Sign in to Gauntlet" })).toHaveCount(0);

  await panel.getByRole("button", { name: "Log out" }).press("Enter");
  await expect(panel.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();
  expect(await storedToken(await panelFrame(page))).toBeNull();
});

test("a stale token returns the panel to sign-in", async ({ page }) => {
  await page.goto(`${HOST}/applications/11111111-1111-4111-8111-111111111111`);
  await toggleWidget(page);
  const frame = await panelFrame(page);
  await frame.evaluate((key) => localStorage.setItem(key, "g1.s.e30.c3RhbGU"), TOKEN_KEY);
  await page.reload();
  await toggleWidget(page);
  const panel = page.frameLocator("iframe[data-gauntlet-panel]");
  await expect(panel.getByRole("heading", { name: "Sign in to Gauntlet" })).toBeVisible();
  const password = panel.getByLabel("Password");
  await password.fill(PASSWORD);
  await password.press("Enter");
  await expect(panel.getByRole("heading", { name: "On this page", exact: true })).toBeVisible();
  expect(await storedToken(await panelFrame(page))).toMatch(/^g1\.s\./);
});
