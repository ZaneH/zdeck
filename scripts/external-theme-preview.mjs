#!/usr/bin/env node
// Capture the external Midnight Maze package preview stories to fixed 1200x800 and 390x844 PNGs.
// Usage: node scripts/external-theme-preview.mjs --url http://127.0.0.1:6006 [--out /tmp]
// The Storybook server must be started separately (npm run storybook); only local URLs are accepted.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const STORIES = {
  desktop: "themes-external-theme-preview--midnight-maze-package-desktop",
  phone: "themes-external-theme-preview--midnight-maze-package-phone",
};
const VIEWPORTS = { desktop: { width: 1200, height: 800 }, phone: { width: 390, height: 844 } };
const PRESENTATIONS = ["button", "slider", "dial", "toggle-switch", "toggle-button", "value"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MACOS_BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const MAX_BYTES = 2 * 1024 * 1024;

function usage(message) {
  if (message) console.error(`external-theme-preview: ${message}`);
  console.error("usage: node scripts/external-theme-preview.mjs --url <local storybook url> [--out <folder>]");
  process.exit(1);
}

const options = { out: "/tmp" };
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--url", "--out"].includes(flag) || value === undefined) usage(`unknown argument ${flag}`);
  index += 1;
  if (flag === "--url") options.url = value;
  else options.out = value;
}
if (!options.url) usage("--url is required");

let base;
try {
  base = new URL(options.url);
} catch {
  usage(`--url is not a URL: ${options.url}`);
}
if (!LOCAL_HOSTS.has(base.hostname) || base.username || base.password) usage("use a local Storybook URL without credentials");
if (!["http:", "https:"].includes(base.protocol)) usage(`unsupported protocol ${base.protocol}`);

const outDir = resolve(options.out);
const browserPath = process.env.CHROME_BIN || (process.platform === "darwin" ? MACOS_BRAVE : "");
if (!browserPath) usage("set CHROME_BIN to a Chromium-based browser executable on this platform");
if (!existsSync(browserPath)) usage(`browser executable not found: ${browserPath}`);

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  for (const [viewport, size] of Object.entries(VIEWPORTS)) {
    const storyId = STORIES[viewport];
    const url = new URL("iframe.html", base);
    url.searchParams.set("id", storyId);
    url.searchParams.set("viewMode", "story");
    // Keep the page backdrop and the story's base appearance in step.
    url.searchParams.set("globals", "theme:dark");
    const context = await browser.newContext({
      viewport: size, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block",
      locale: "en-US", timezoneId: "UTC", colorScheme: "dark",
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
      // Same framing as scripts/theme-previews.mjs: desktop uniformly fits and centers the group;
      // phone keeps its natural 390x844 layout. No image resize.
      const framing = viewport === "desktop" ? await page.evaluate(() => {
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
      }) : null;
      const rendered = await page.evaluate(() => {
        const fixture = document.querySelector('[data-testid="theme-preview"]');
        const section = fixture?.querySelector(".deck-section, .phone-section");
        const content = document.querySelector('[data-testid="theme-preview-content"]');
        const tiles = Array.from(document.querySelectorAll(".control-tile"));
        const clipped = tiles.some(tile => {
          const box = tile.getBoundingClientRect();
          return box.left < -1 || box.top < -1 || box.right > window.innerWidth + 1 || box.bottom > window.innerHeight + 1;
        });
        const contentBox = content?.getBoundingClientRect();
        const clippedContent = contentBox ? contentBox.left < -1 || contentBox.top < -1 || contentBox.right > window.innerWidth + 1 || contentBox.bottom > window.innerHeight + 1 : false;
        return {
          customTheme: fixture?.dataset.customTheme,
          customMotif: fixture?.dataset.customMotif,
          tileRadius: section ? getComputedStyle(section).getPropertyValue("--tile-radius").trim() : "",
          presentations: tiles.map(tile => tile.dataset.presentation),
          overflow: clipped || clippedContent || document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      if (rendered.customTheme !== "true" || rendered.customMotif !== "maze") throw new Error(`${storyId}: custom theme attributes missing`);
      if (rendered.tileRadius !== "8px") throw new Error(`${storyId}: expected 8px package tile radius, got ${rendered.tileRadius || "(none)"}`);
      const missing = PRESENTATIONS.filter(presentation => !rendered.presentations.includes(presentation));
      if (missing.length) throw new Error(`${storyId}: missing presentations ${missing.join(", ")}`);
      if (rendered.overflow) throw new Error(`${storyId}: content overflows the ${size.width}x${size.height} viewport`);
      const file = `zdeck-midnight-package-${viewport}.png`;
      const path = join(outDir, file);
      await page.screenshot({ path, animations: "disabled" });
      const bytes = readFileSync(path);
      const actual = pngSize(bytes);
      if (actual.width !== size.width || actual.height !== size.height) {
        throw new Error(`${file}: ${actual.width}x${actual.height}, expected ${size.width}x${size.height}`);
      }
      if (bytes.length > MAX_BYTES) throw new Error(`${file}: ${bytes.length} bytes exceeds 2 MiB`);
      console.log(`${file} — ${actual.width}x${actual.height} (${bytes.length} bytes)${framing ? `, content ${framing.width}x${framing.height} at ${framing.scale}x` : ""} sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
