import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Gauntlet widget panel: a separate entry point served by the server under
 * `/widget/` (GAUNTLET_WIDGET_DIR = { index.html, loader.js, assets/ }).
 * The built loader from packages/widget-loader is placed next to the panel,
 * so a single directory is enough to deploy.
 */
const root = fileURLToPath(new URL("./widget", import.meta.url));
const outDir = fileURLToPath(new URL("./dist-widget", import.meta.url));
const loaderSource = fileURLToPath(new URL("../../packages/widget-loader/dist/loader.js", import.meta.url));

function copyLoader(): Plugin {
  return {
    name: "gauntlet-copy-widget-loader",
    apply: "build",
    closeBundle() {
      if (!existsSync(loaderSource)) {
        throw new Error(`Build @8lines/gauntlet-widget-loader first (missing ${loaderSource})`);
      }
      mkdirSync(outDir, { recursive: true });
      copyFileSync(loaderSource, join(outDir, "loader.js"));
    },
  };
}

const api = process.env.GAUNTLET_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  root,
  base: "/widget/",
  plugins: [react(), tailwindcss(), copyLoader()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5274,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/health": { target: api, changeOrigin: true },
      "/widget/config.json": { target: api, changeOrigin: true },
    },
  },
  build: { outDir, emptyOutDir: true },
});
