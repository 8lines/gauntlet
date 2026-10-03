import { expect, type Page } from "@playwright/test";

/** Matches the `md` breakpoint at which the shell swaps the mobile sheet for the sidebar. */
const desktopBreakpoint = 768;

/**
 * Resolves once the layout has stopped changing: no animation is running and the
 * geometry of every element is identical across several consecutive frames.
 * `document.getAnimations()` alone is not enough, because crossing a breakpoint
 * changes the shell through a React state update that can land after the check.
 */
export async function waitForStableLayout(page: Page, stableFrames = 4, timeoutMs = 5_000) {
  await page.evaluate(
    ({ stableFrames, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + timeoutMs;
        const snapshot = () => {
          const rects = [`${window.innerWidth}x${window.innerHeight}`];
          for (const element of document.body.querySelectorAll("*")) {
            const { x, y, width, height } = element.getBoundingClientRect();
            rects.push(`${x},${y},${width},${height}`);
          }
          return rects.join("|");
        };
        const running = () => document.getAnimations().some((animation) => animation.playState === "running");
        let previous = "";
        let stable = 0;
        const frame = () => {
          const current = snapshot();
          stable = current === previous && !running() ? stable + 1 : 0;
          previous = current;
          if (stable >= stableFrames) return resolve();
          if (performance.now() > deadline) return reject(new Error("layout did not settle"));
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    { stableFrames, timeoutMs },
  );
}

/** Resizes the viewport and waits for the shell state that matches it before layout is measured. */
export async function resizeViewport(page: Page, width: number, height = 800) {
  await page.setViewportSize({ width, height });
  const sidebar = page.locator("#gauntlet-navigation");
  if (width >= desktopBreakpoint) await expect(sidebar).toBeVisible();
  else await expect(sidebar).toHaveCount(0);
  await waitForStableLayout(page);
}
