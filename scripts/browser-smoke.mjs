#!/usr/bin/env node
// Headless Chrome smoke test over raw CDP. No browser dependency: Node 22 fetch/WebSocket only.
// Usage: node scripts/browser-smoke.mjs [--keep]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { readFile, stat } from "node:fs/promises";

const ROOT = process.cwd();
const CHROME = process.env.CHROME_BIN || "google-chrome";
const KEEP = process.argv.includes("--keep");
const results = [];
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function removeWithRetry(path) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}

// ---------------------------------------------------------------- static server
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};
let serveRoot = "";
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  let filePath = join(serveRoot, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(serveRoot, "index.html");
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- CDP client
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else {
        for (const listener of [...this.listeners]) listener(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(listener) {
    this.listeners.push(listener);
  }
  waitFor(method, timeout, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeout);
      const listener = (msg) => {
        if (msg.method !== method || (sessionId && msg.sessionId !== sessionId)) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== listener);
        resolve(msg.params);
      };
      this.listeners.push(listener);
    });
  }
}

class Page {
  constructor(cdp, sessionId, label) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.label = label;
    this.errors = [];
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.errors.push(`exception: ${d?.exception?.description || d?.text}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push(
          `console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`,
        );
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        this.errors.push(`log: ${msg.params.entry.text}`);
      }
    });
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }
  async navigate(url, timeout = 20000) {
    const load = this.cdp.waitFor("Page.loadEventFired", timeout, this.sessionId).catch(() => {});
    await this.send("Page.navigate", { url });
    await load;
  }
  async reload(timeout = 20000) {
    const load = this.cdp.waitFor("Page.loadEventFired", timeout, this.sessionId).catch(() => {});
    await this.send("Page.reload", {});
    await load;
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`,
      );
    }
    return r.result.value;
  }
  async waitFor(expression, timeout = 10000) {
    const start = Date.now();
    for (;;) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        // execution context may be replaced during navigation
      }
      if (Date.now() - start > timeout) return false;
      await sleep(100);
    }
  }
  async screenshot(path) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  }
}

// ---------------------------------------------------------------- chrome
const chromeDir = mkdtempSync(join(tmpdir(), "deck-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    `--user-data-dir=${chromeDir}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"], detached: true },
);
let chromeStderr = "";
chrome.stderr.on("data", (d) => {
  chromeStderr += d.toString();
});

const activePortFile = join(chromeDir, "DevToolsActivePort");
let devtoolsPort = 0;
for (let i = 0; i < 150 && !devtoolsPort; i += 1) {
  if (existsSync(activePortFile)) {
    const first = readFileSync(activePortFile, "utf8").split("\n")[0];
    devtoolsPort = Number(first) || 0;
    if (!devtoolsPort) await sleep(50);
  } else {
    await sleep(100);
  }
}
if (!devtoolsPort) {
  console.error("Chrome did not expose a debugging port.\n", chromeStderr);
  process.exit(1);
}
const versionInfo = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
const cdp = new Cdp(ws);

async function openPage(label, url, viewport) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId, label);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");
  if (viewport) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale ?? 1,
      mobile: Boolean(viewport.mobile),
    });
    if (viewport.mobile) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }
  if (url) await page.navigate(url);
  return page;
}

const click = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
const clickText = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`;
// Native value setter so React's value tracker sees the change for controlled inputs.
const setValue = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); el.blur(); return true; })()`;

// ---------------------------------------------------------------- build two versions
const buildA = mkdtempSync(join(tmpdir(), "deck-build-a-"));
const buildB = mkdtempSync(join(tmpdir(), "deck-build-b-"));
console.log("Building two frontend versions...");
execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
cpSync(join(ROOT, "dist"), buildA, { recursive: true });
execFileSync("npm", ["run", "build"], {
  cwd: ROOT,
  stdio: "ignore",
  env: { ...process.env, VITE_BUILD_MARKER: "two" },
});
cpSync(join(ROOT, "dist"), buildB, { recursive: true });
const swVersion = (dir) =>
  readFileSync(join(dir, "sw.js"), "utf8").match(/CACHE_PREFIX \+ "([^"]+)"/)[1];
const versionA = swVersion(buildA);
const versionB = swVersion(buildB);
check("two builds produce distinct service-worker cache versions", versionA !== versionB, `${versionA} vs ${versionB}`);

serveRoot = buildA;

try {
  // ------------------------------------------------------------ editor flow
  const editor = await openPage("editor", `${BASE}/`, { width: 1440, height: 1000 });
  check("editor shell renders", await editor.waitFor("!!document.querySelector('.app-shell')"));
  check("self-hosted font loads", await editor.eval("document.fonts.ready.then(() => document.fonts.check('12px Geist'))"));
  check("desktop workspace has no horizontal overflow", await editor.eval("document.documentElement.scrollWidth <= innerWidth"));
  check("deck is the dominant editor surface", await editor.eval("document.querySelector('.canvas-panel').clientWidth > document.querySelector('.right-panel').clientWidth * 2"));

  const pagesBefore = await editor.eval("document.querySelectorAll('.page-item').length");
  await editor.eval(click('[aria-label="Add page"]'));
  await editor.waitFor(`document.querySelectorAll('.page-item').length === ${pagesBefore + 1}`);
  check("add page", (await editor.eval("document.querySelectorAll('.page-item').length")) === pagesBefore + 1);

  const headingAfterPage = await editor.eval("document.querySelector('#page-title').textContent");
  check("new page becomes active", /Page/.test(headingAfterPage), headingAfterPage);

  await editor.eval(clickText(".action-row", "OBS scene"));
  await editor.waitFor("document.querySelectorAll('.control-tile').length === 1");
  check("add control to page", (await editor.eval("document.querySelectorAll('.control-tile').length")) === 1);

  await editor.eval(clickText(".action-row", "Microphone mute"));
  await editor.eval(clickText(".action-row", "Play / pause"));
  await editor.waitFor("document.querySelectorAll('.control-tile').length === 3");

  // rename/edit selected control (last added is selected)
  await editor.eval(clickText(".control-tile .tile-primary", "Play / pause"));
  await editor.eval(setValue('.inspector-form .field input[type="text"]', "Smoke label"));
  await editor.waitFor(
    "document.querySelector('.inspector-form .field input[type=\"text\"]').value === 'Smoke label'",
  );
  check(
    "rename selected control persists in inspector",
    (await editor.eval("document.querySelector('.inspector-form .field input[type=\"text\"]').value")) ===
      "Smoke label",
  );

  // reorder the first control down; order is tracked by the selected tile's label position
  const orderBefore = await editor.eval(
    "[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')",
  );
  await editor.eval(
    `(() => { const tile = document.querySelector('.control-tile[data-action="obs-scene"]'); tile.querySelector('[title="Move down"]').click(); return true; })()`,
  );
  const orderAfter = await editor.eval(
    "[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')",
  );
  check("reorder control changes order", orderBefore !== orderAfter, `${orderBefore} -> ${orderAfter}`);

  await editor.screenshot("/tmp/deck-smoke-editor-desktop.png");
  await editor.eval("document.querySelector('.control-tile button[title=\"Move down\"]').focus()");
  check("keyboard focus reveals key reorder tools", await editor.eval("getComputedStyle(document.activeElement.closest('.tile-tools')).opacity === '1'"));

  // refresh persistence
  await editor.reload();
  await editor.waitFor("!!document.querySelector('.app-shell')");
  const persisted = await editor.eval(
    "[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')",
  );
  check("refresh keeps edited deck", persisted === orderAfter, persisted);

  // dark / light
  await editor.eval(click(".theme-toggle"));
  await editor.waitFor("document.documentElement.dataset.theme === 'light'");
  check("theme toggles to light", (await editor.eval("document.documentElement.dataset.theme")) === "light");
  await editor.eval(click(".theme-toggle"));
  await editor.waitFor("document.documentElement.dataset.theme === 'dark'");
  check("theme toggles back to dark", (await editor.eval("document.documentElement.dataset.theme")) === "dark");

  // ------------------------------------------------------------ cross-tab sync
  const tabA = await openPage("sync-a", `${BASE}/`, { width: 1440, height: 1000 });
  const tabB = await openPage("sync-b", `${BASE}/`, { width: 1440, height: 1000 });
  await tabA.waitFor("!!document.querySelector('.app-shell')");
  await tabB.waitFor("!!document.querySelector('.app-shell')");
  await tabA.eval(
    `(() => { const t = [...document.querySelectorAll('.control-tile')].find((n) => n.dataset.action === 'mic-mute'); t.querySelector('.tile-primary').click(); return true; })()`,
  );
  await tabB.eval(
    `(() => { const t = [...document.querySelectorAll('.control-tile')].find((n) => n.dataset.action === 'mic-mute'); t.querySelector('.tile-primary').click(); return true; })()`,
  );
  await tabA.waitFor("!!document.querySelector('.inspector-form')");
  await tabB.waitFor("!!document.querySelector('.inspector-form')");
  await tabB.eval("window.__deckSmokeMarker = 'b-alive'");
  await tabA.eval(setValue('.inspector-form .field input[type="text"]', "Synced name"));
  await tabA.waitFor(
    "document.querySelector('.inspector-form .field input[type=\"text\"]').value === 'Synced name'",
  );
  const synced = await tabB.waitFor(
    "document.querySelector('.inspector-form .field input[type=\"text\"]').value === 'Synced name'",
  );
  check("cross-tab edit updates other tab inspector without reload", synced);
  check("other tab was not reloaded by sync", (await tabB.eval("window.__deckSmokeMarker")) === "b-alive");

  // ------------------------------------------------------------ phone preview
  const phonePortrait = await openPage("phone-portrait", `${BASE}/#/phone`, {
    width: 390,
    height: 844,
    mobile: true,
  });
  check("phone shell renders", await phonePortrait.waitFor("!!document.querySelector('.phone-shell')"));
  const tabs = await phonePortrait.eval("document.querySelectorAll('.phone-page-tab').length");
  check("phone shows deck pages", tabs === 3, `tabs=${tabs}`);
  await phonePortrait.eval(clickText(".phone-page-tab", "Media"));
  await phonePortrait.waitFor("document.querySelector('.phone-page-heading h1').textContent === 'Media'");
  check(
    "phone page switching",
    (await phonePortrait.eval("document.querySelector('.phone-page-heading h1').textContent")) === "Media",
  );
  await phonePortrait.eval(setValue('.phone-grid .tile-volume input[type="range"]', "70"));
  const volume = await phonePortrait.eval(
    "document.querySelector('.phone-grid .tile-volume .volume-readout').textContent",
  );
  check("phone volume preview updates", volume === "70%", volume);
  const portraitOverflow = await phonePortrait.eval(
    "document.documentElement.scrollWidth - window.innerWidth",
  );
  check("phone portrait has no horizontal overflow", portraitOverflow <= 1, `overflow=${portraitOverflow}px`);
  check("phone page navigation stays in thumb reach", await phonePortrait.eval("Math.abs(document.querySelector('.phone-footer').getBoundingClientRect().bottom - innerHeight) <= 1"));
  check("phone page targets are at least 44px", await phonePortrait.eval("[...document.querySelectorAll('.phone-page-tab')].every(el => el.getBoundingClientRect().height >= 44)"));
  check("phone slider spans the control grid", await phonePortrait.eval("document.querySelector('.phone-grid [data-action=\"volume\"]').clientWidth >= document.querySelector('.phone-grid').clientWidth - 3"));
  await phonePortrait.screenshot("/tmp/deck-smoke-phone-portrait.png");

  const phoneLandscape = await openPage("phone-landscape", `${BASE}/#/phone`, {
    width: 844,
    height: 390,
    mobile: true,
  });
  await phoneLandscape.waitFor("!!document.querySelector('.phone-shell')");
  const landscapeOverflow = await phoneLandscape.eval(
    "document.documentElement.scrollWidth - window.innerWidth",
  );
  check("phone landscape has no horizontal overflow", landscapeOverflow <= 1, `overflow=${landscapeOverflow}px`);
  await phoneLandscape.screenshot("/tmp/deck-smoke-phone-landscape.png");

  // ------------------------------------------------------------ service worker offline shell
  const offline = await openPage("offline", `${BASE}/`, { width: 1440, height: 1000 });
  await offline.waitFor("!!document.querySelector('.app-shell')");
  await offline.eval("navigator.serviceWorker.ready.then(() => true)");
  if (!(await offline.eval("!!navigator.serviceWorker.controller"))) await offline.reload();
  await offline.waitFor("!!navigator.serviceWorker.controller");
  check("service worker controls the page", await offline.eval("!!navigator.serviceWorker.controller"));

  const cacheState = await offline.eval(`(async () => {
    const keys = await caches.keys();
    const name = keys.find((k) => k.startsWith('deck-shell-'));
    const cache = await caches.open(name);
    const paths = (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
    return { keys, paths };
  })()`);
  check(
    "cache is scoped to one versioned deck-shell cache",
    cacheState.keys.filter((k) => k.startsWith("deck-shell-")).length === 1,
    JSON.stringify(cacheState.keys),
  );
  check(
    "cache holds exact shell assets only",
    cacheState.paths.includes("/index.html") &&
      cacheState.paths.includes("/manifest.webmanifest") &&
      cacheState.paths.every((p) => !p.includes("?") && !p.startsWith("/api")),
    JSON.stringify(cacheState.paths),
  );

  // Fetch an API-shaped path and a query variant; neither should enter the cache.
  await offline.eval("fetch('/api/status').catch(() => null)");
  await offline.eval("fetch('/index.html?fresh=1').catch(() => null)");
  const afterProbe = await offline.eval(`(async () => {
    const name = (await caches.keys()).find((k) => k.startsWith('deck-shell-'));
    const cache = await caches.open(name);
    return (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
  })()`);
  check(
    "API and query paths are never cached",
    afterProbe.every((p) => !p.startsWith("/api") && !p.includes("?")),
    JSON.stringify(afterProbe),
  );

  await offline.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await offline.reload();
  const offlineShell = await offline.waitFor("!!document.querySelector('.app-shell')", 15000);
  check("offline shell loads from cache", offlineShell);
  await offline.screenshot("/tmp/deck-smoke-offline-shell.png");
  await offline.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  // ------------------------------------------------------------ two-build update lifecycle
  const update = await openPage("update", `${BASE}/`, { width: 1440, height: 1000 });
  await update.waitFor("!!document.querySelector('.app-shell')");
  await update.eval("navigator.serviceWorker.ready.then(() => true)");
  if (!(await update.eval("!!navigator.serviceWorker.controller"))) await update.reload();
  await update.waitFor("!!navigator.serviceWorker.controller");
  await update.eval("window.__deckSmokeMarker = 'old-alive'");

  serveRoot = buildB;
  await update.eval("navigator.serviceWorker.getRegistration().then((r) => r.update())");
  const bannerShown = await update.waitFor("!!document.querySelector('.update-banner')", 15000);
  check("new build shows the update banner", bannerShown);
  const noAutoReload = (await update.eval("window.__deckSmokeMarker")) === "old-alive";
  const stillOldBuild = (await update.eval("document.querySelector('.app-shell').dataset.build || ''")) === "";
  check("old build stays live until the user applies the update", noAutoReload && stillOldBuild);

  const bothCaches = await update.eval("caches.keys()");
  check(
    "new build installs into a distinct cache",
    bothCaches.filter((k) => k.startsWith("deck-shell-")).length === 2,
    JSON.stringify(bothCaches),
  );
  await update.screenshot("/tmp/deck-smoke-update-banner.png");

  await update.eval(click(".update-banner button"));
  await update.waitFor("document.querySelector('.app-shell') && document.querySelector('.app-shell').dataset.build === 'two'", 20000);
  check(
    "applying the update serves the new build",
    (await update.eval("document.querySelector('.app-shell').dataset.build")) === "two",
  );
  const finalCaches = await update.eval("caches.keys()");
  check(
    "old build cache is cleaned up after activation",
    finalCaches.filter((k) => k.startsWith("deck-shell-")).length === 1 &&
      finalCaches.some((k) => k.endsWith(versionB)),
    JSON.stringify(finalCaches),
  );
  check("update reload was user-triggered", (await update.eval("window.__deckSmokeMarker")) === undefined);
  await update.screenshot("/tmp/deck-smoke-after-update.png");

  // ------------------------------------------------------------ console errors
  const noisy = [editor, tabA, tabB, phonePortrait, phoneLandscape, offline, update];
  for (const page of noisy) {
    const errors = page.errors.filter((e) => !/favicon/i.test(e));
    check(`no runtime/console errors on ${page.label}`, errors.length === 0, errors.join(" | "));
  }
} catch (error) {
  check("smoke run completed without harness error", false, error?.stack || String(error));
} finally {
  console.log("\nScreenshots:");
  for (const name of [
    "deck-smoke-editor-desktop.png",
    "deck-smoke-phone-portrait.png",
    "deck-smoke-phone-landscape.png",
    "deck-smoke-offline-shell.png",
    "deck-smoke-update-banner.png",
    "deck-smoke-after-update.png",
  ]) {
    const path = `/tmp/${name}`;
    if (existsSync(path)) console.log(`  ${path}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  try {
  ws.close();
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {
    chrome.kill("SIGKILL");
  }
  await new Promise((resolve) => {
    if (chrome.exitCode !== null) resolve();
    else chrome.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  server.close();
  // Leave dist/ as the unmarked build, not the marker build used for the update test.
  if (existsSync(join(buildA, "index.html"))) {
    rmSync(join(ROOT, "dist"), { recursive: true, force: true });
    cpSync(buildA, join(ROOT, "dist"), { recursive: true });
  }
  if (!KEEP) {
    await removeWithRetry(chromeDir);
    await removeWithRetry(buildA);
    await removeWithRetry(buildB);
  }
  } catch (cleanupError) {
    console.error("cleanup warning:", cleanupError?.message || cleanupError);
  }
  process.exit(failures === 0 ? 0 : 1);
}
