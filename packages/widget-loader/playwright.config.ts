import { defineConfig } from "@playwright/test";

const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? "chromium";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../node_modules/.cache/gauntlet-widget-loader/playwright",
  fullyParallel: false,
  webServer: {
    command: "node e2e/fixture-server.mjs",
    url: "http://localhost:4391/widget/config.json",
    reuseExistingServer: false,
  },
  use: { channel: browserChannel },
  projects: [{ name: "chromium" }],
});
