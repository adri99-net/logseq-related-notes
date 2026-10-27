import { defineConfig } from "vite";

// Logseq loads the plugin from file://-style URLs, so every asset path must be relative.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 5000,
  },
});
