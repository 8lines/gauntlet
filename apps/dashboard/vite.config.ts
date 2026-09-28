import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The dashboard talks only to the control plane API (`/api/v1/...`).
 * In development mode requests go to the local Fastify server.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: {
      "/api": { target: process.env.GAUNTLET_API ?? "http://127.0.0.1:8080", changeOrigin: true },
      "/health": { target: process.env.GAUNTLET_API ?? "http://127.0.0.1:8080", changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
