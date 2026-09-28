import { defineConfig } from "@playwright/test";

const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? "chromium";

/** End-to-end suite for the widget: built loader, control plane, panel and example adapter. */
export default defineConfig({
  testDir: "./e2e-widget",
  outputDir: "../../node_modules/.cache/gauntlet-dashboard/playwright-widget",
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: "node e2e-widget/stack.mjs",
    url: "http://localhost:4411/ready",
    reuseExistingServer: false,
  },
  use: { channel: browserChannel },
  projects: [{ name: "chromium" }],
});
