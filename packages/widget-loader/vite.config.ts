import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    lib: { entry: "src/index.ts", formats: ["iife"], name: "GauntletWidgetLoader", fileName: () => "loader.js" },
  },
});
