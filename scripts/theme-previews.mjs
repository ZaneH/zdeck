#!/usr/bin/env node
// Export the standard theme preview stories (src/components/ThemePreview.stories.tsx) to PNG.
// Usage: node scripts/theme-previews.mjs --url http://127.0.0.1:6006 --out /tmp/zdeck-theme-previews [--themes glass,terminal]
// The Storybook server must be started separately (npm run storybook); only local URLs are accepted.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const BUILT_IN_THEMES = ["dark", "light", "glass", "terminal", "macintosh"];
const PRESENTATIONS = ["button", "slider", "dial", "toggle-switch", "toggle-button", "value"];
const VIEWPORTS = { desktop: { width: 1200, height: 800 }, phone: { width: 390, height: 844 } };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const STORY_ID = (theme, viewport) => `themes-theme-preview--${theme}-${viewport}`;
const MACOS_BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

function usage(message) {
  if (message) console.error(`theme-previews: ${message}`);
  console.error("usage: node scripts/theme-previews.mjs --url <local storybook url> --out <folder> [--themes glass,terminal]");
  process.exit(1);
}

const options = { themes: BUILT_IN_THEMES };
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--url", "--out", "--themes"].includes(flag) || value === undefined) usage(`unknown argument ${flag}`);
  index += 1;
  if (flag === "--url") options.url = value;
  else if (flag === "--out") options.out = value;
  else options.themes = value.split(",").map(theme => theme.trim()).filter(Boolean);
}
if (!options.url || !options.out) usage("--url and --out are required");

let base;
try {
  base = new URL(options.url);
} catch {
  usage(`--url is not a URL: ${options.url}`);
}
if (!LOCAL_HOSTS.has(base.hostname) || base.username || base.password) usage("use a local Storybook URL without credentials");
if (!["http:", "https:"].includes(base.protocol)) usage(`unsupported protocol ${base.protocol}`);
const unknown = options.themes.filter(theme => !BUILT_IN_THEMES.includes(theme));
if (unknown.length || !options.themes.length) usage(`unknown theme id(s): ${unknown.join(", ") || "(none given)"} — built in: ${BUILT_IN_THEMES.join(", ")}`);

const outDir = resolve(options.out);
const browserPath = process.env.CHROME_BIN || (process.platform === "darwin" ? MACOS_BRAVE : "");
if (!browserPath) usage("set CHROME_BIN to a Chromium-based browser executable on this platform");
if (!existsSync(browserPath)) usage(`browser executable not found: ${browserPath}`);

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const files = [];
try {
  for (const theme of options.themes) {
    for (const [viewport, size] of Object.entries(VIEWPORTS)) {
      const storyId = STORY_ID(theme, viewport);
      const url = new URL("iframe.html", base);
      url.searchParams.set("id", storyId);
      url.searchParams.set("viewMode", "story");
      // The decorator applies the global theme; passing both keeps the page backdrop and args in step.
      url.searchParams.set("globals", `theme:${theme}`);
      url.searchParams.set("args", `theme:${theme}`);
      const context = await browser.newContext({
        viewport: size, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block",
        locale: "en-US", timezoneId: "UTC", colorScheme: theme === "light" ? "light" : "dark",
      });
      try {
        await context.route("**/*", route => {
          const request = new URL(route.request().url());
          return request.origin === base.origin ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        await page.goto(url.href, { waitUntil: "networkidle" });
        await page.waitForSelector('[data-testid="theme-preview"]');
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        });
        // Desktop fits the content group uniformly inside the fixed frame and centers it, so controls
        // fill the picture without cropping. Phone keeps its natural 390x844 layout.
        const framing = await page.evaluate(() => {
          const content = document.querySelector('[data-testid="theme-preview-content"]');
          if (!content) return null;
          const margin = 28;
          const box = content.getBoundingClientRect();
          const availableWidth = window.innerWidth - margin * 2;
          const availableHeight = window.innerHeight - margin * 2;
          const scale = Math.min(availableWidth / box.width, availableHeight / box.height);
          content.style.position = "fixed";
          content.style.left = `${margin + (availableWidth - box.width * scale) / 2}px`;
          content.style.top = `${margin + (availableHeight - box.height * scale) / 2}px`;
          content.style.margin = "0";
          content.style.transformOrigin = "top left";
          content.style.transform = `scale(${scale})`;
          return { scale: Number(scale.toFixed(3)), width: Math.round(box.width), height: Math.round(box.height) };
        });
        const rendered = await page.evaluate(() => {
          const fixture = document.querySelector('[data-testid="theme-preview"]');
          const section = fixture?.querySelector(".deck-section, .phone-section");
          const content = document.querySelector('[data-testid="theme-preview-content"]');
          const tiles = Array.from(document.querySelectorAll(".control-tile"));
          // A clipped tile would ship a wrong picture: every tile must be fully inside the viewport.
          const clipped = tiles.some(tile => {
            const box = tile.getBoundingClientRect();
            return box.left < -1 || box.top < -1 || box.right > window.innerWidth + 1 || box.bottom > window.innerHeight + 1;
          });
          const contentBox = content?.getBoundingClientRect();
          const clippedContent = contentBox ? contentBox.left < -1 || contentBox.top < -1 || contentBox.right > window.innerWidth + 1 || contentBox.bottom > window.innerHeight + 1 : false;
          return {
            fixtureTheme: fixture?.dataset.theme,
            tileRadius: section ? getComputedStyle(section).getPropertyValue("--tile-radius").trim() : "",
            presentations: tiles.map(tile => tile.dataset.presentation),
            overflow: clipped || clippedContent || document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
        if (rendered.fixtureTheme !== theme) throw new Error(`${storyId}: rendered theme ${rendered.fixtureTheme}, expected ${theme}`);
        if (!rendered.tileRadius) throw new Error(`${storyId}: no theme tokens resolved on the fixture`);
        const missing = PRESENTATIONS.filter(presentation => !rendered.presentations.includes(presentation));
        if (missing.length) throw new Error(`${storyId}: missing presentations ${missing.join(", ")}`);
        if (rendered.overflow) throw new Error(`${storyId}: content overflows the ${size.width}px viewport`);
        const file = `zdeck-theme-${theme}-${viewport}.png`;
        const path = join(outDir, file);
        await page.screenshot({ path, animations: "disabled" });
        const bytes = readFileSync(path);
        files.push({
          theme, viewport, storyId, file, width: size.width, height: size.height,
          contentScale: framing?.scale ?? 1,
          bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        console.log(`${file} — ${size.width}x${size.height} (${bytes.length} bytes)${framing ? `, content ${framing.width}x${framing.height} at ${framing.scale}x` : ""}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify({
  generatedBy: "scripts/theme-previews.mjs",
  storybook: { url: base.origin, storyIds: Object.fromEntries(options.themes.map(theme => [theme, Object.fromEntries(Object.keys(VIEWPORTS).map(viewport => [viewport, STORY_ID(theme, viewport)]))])) },
  fixture: "zdeck-sample-deck-1",
  fixtureSource: "src/components/ThemePreview.stories.tsx",
  presentations: PRESENTATIONS,
  viewports: VIEWPORTS,
  files,
}, null, 2)}\n`);
console.log(`\n${files.length} files in ${outDir}`);
console.log(`dimensions: ${Object.entries(VIEWPORTS).map(([name, size]) => `${name} ${size.width}x${size.height}`).join(", ")}`);
