import { fileURLToPath } from "node:url";
import { argosVitestPlugin } from "@argos-ci/storybook/vitest-plugin";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.ts"],
        },
      },
      {
        optimizeDeps: { include: ["react/jsx-dev-runtime"] },
        plugins: [
          storybookTest({ configDir: fileURLToPath(new URL(".storybook", import.meta.url)) }),
          argosVitestPlugin({ uploadToArgos: !!process.env.CI && !!process.env.ARGOS_TOKEN }),
        ],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                args: ["--disable-lcd-text", "--font-render-hinting=none"],
              },
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
