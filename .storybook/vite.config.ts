import { defineConfig } from "vite";

// Keep the app's PWA build plugin and public manifest out of this isolated preview.
export default defineConfig({ publicDir: false });
