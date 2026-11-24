import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone build containing only the landing page (no desktop editor, PWA manifest, or SW).
export default defineConfig({
  root: resolve(__dirname, "landing"),
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      "/src": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist-landing"),
    emptyOutDir: true,
  },
});
