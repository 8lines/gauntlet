import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import dashboardPackage from "./package.json" with { type: "json" };

const apiOrigin = process.env.GAUNTLET_API ?? "http://127.0.0.1:8080";

/**
 * The dashboard talks only to the control plane API (`/api/v1/...`).
 * In development mode requests go to the local Fastify server.
 * Asset URLs are relative (`base: "./"`), so one build works under any base path: the server
 * injects `<base href>` and the `gauntlet-base-path` meta element into index.html (see src/base-path.ts).
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: {
    __GAUNTLET_VERSION__: JSON.stringify(dashboardPackage.version),
    __GAUNTLET_DEV_MCP_URL__: JSON.stringify(new URL("/mcp", apiOrigin).href),
  },
  server: {
    port: 5273,
    proxy: {
      "/api": { target: apiOrigin, changeOrigin: true },
      "/health": { target: apiOrigin, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
