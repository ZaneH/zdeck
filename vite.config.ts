import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceWorkerPlugin } from "./build/serviceWorkerPlugin";

export default defineConfig({
  plugins: [react(), serviceWorkerPlugin()],
  server: {
    port: 1420,
    strictPort: true,
  },
});
