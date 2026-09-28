import { defineConfig } from "@playwright/test";

const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? "chromium";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../node_modules/.cache/gauntlet-dashboard/playwright",
  fullyParallel: false,
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: false,
  },
  use: { baseURL: "http://127.0.0.1:4173", channel: browserChannel },
  projects: [
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
  ],
});
