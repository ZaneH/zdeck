#!/usr/bin/env node
// Headless Chrome smoke test over raw CDP. No browser dependency: Node 22 fetch/WebSocket only.
// Usage: node scripts/browser-smoke.mjs [--keep]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { readFile, stat } from "node:fs/promises";

const ROOT = process.cwd();
const CHROME = process.env.CHROME_BIN || (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "google-chrome");
const KEEP = process.argv.includes("--keep");
// Optional: SMOKE_ARTIFACT_DIR=<dir> writes a screenshot, the full AX tree and console errors per screen.
const ARTIFACT_DIR = process.env.SMOKE_ARTIFACT_DIR || "";
if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });
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
  ".ttf": "font/ttf",
};
let serveRoot = "";
let landingRoot = "";
function createStaticServer(rootRef) {
  return createServer(async (req, res) => {
    const root = rootRef();
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    let filePath = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, "index.html");
    } catch {
      filePath = join(root, "index.html");
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
}
const server = createStaticServer(() => serveRoot);
const landingServer = createStaticServer(() => landingRoot);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await new Promise((r) => landingServer.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const LANDING_BASE = `http://127.0.0.1:${landingServer.address().port}`;

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
    await this.eval("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(resolve))).then(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))");
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  }
  // Optional artifact bundle for one screen. No-op unless SMOKE_ARTIFACT_DIR is set.
  async captureArtifacts(name) {
    if (!ARTIFACT_DIR) return;
    await this.screenshot(join(ARTIFACT_DIR, `${name}.png`));
    await this.send("Accessibility.enable").catch(() => {});
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    writeFileSync(join(ARTIFACT_DIR, `${name}.ax.json`), JSON.stringify(nodes, null, 2));
    writeFileSync(join(ARTIFACT_DIR, `${name}.console.json`), JSON.stringify(this.errors, null, 2));
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

async function openPage(label, url, viewport, browserContextId) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId, label);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");
  // Keep the page focused the way a real user window is; without this, headless windows blur mid-test.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
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
const setSelect = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;
// Real input avoids synthetic change/blur racing submission in controlled rename forms.
async function typeInput(page, selector, text) {
  if (!await page.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`)) throw new Error(`Input did not mount: ${selector}`);
  await page.send('Page.bringToFront');
  await page.eval(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await page.send('Input.insertText', { text });
}
async function pressKey(page, key, code, vk, text) {
  await page.send("Page.bringToFront").catch(() => {});
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send("Input.dispatchKeyEvent", { type: text === undefined ? "rawKeyDown" : "keyDown", ...base, ...(text === undefined ? {} : { text }) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function pointerClick(page, x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 1 });
}
async function chooseSetupAction(page, kind) {
  if (!await page.eval("document.querySelector('.setup-action-change').open")) {
    await page.eval(click('[aria-label="Change action"]'));
  }
  await page.eval(click(`.setup-choice input[value="${kind}"]`));
}
const rectOf = (selector) =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`;

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

const landingDir = mkdtempSync(join(tmpdir(), "deck-landing-"));
console.log("Building landing page...");
execFileSync("npm", ["run", "landing:build"], { cwd: ROOT, stdio: "ignore" });
cpSync(join(ROOT, "dist-landing"), landingDir, { recursive: true });
landingRoot = landingDir;

serveRoot = buildA;
const livePages = [];

try {
  // ------------------------------------------------------------ landing page mini deck
  const landingDesktop = await openPage("landing-desktop", `${LANDING_BASE}/`, { width: 1280, height: 900 });
  livePages.push(landingDesktop);
  await landingDesktop.waitFor("!!document.querySelector('.lp-deck-grid')");
  const landingStatus = () => landingDesktop.eval("document.querySelector('.lp-status-pill').textContent.trim()");
  const heldKey = "document.querySelector('.lp-deck-grid .control-tile.is-pressed')";
  check("landing mini deck renders its essential controls", await landingDesktop.eval("[...document.querySelectorAll('.lp-deck-grid button')].length === 4 && !!document.querySelector('.lp-deck-grid input[type=range]')"));
  check("landing desktop has no horizontal overflow", await landingDesktop.eval("document.documentElement.scrollWidth <= innerWidth"));
  await landingDesktop.captureArtifacts("landing-desktop");

  // Press holds the key; releasing off the key must clear it and never stick.
  const sceneButton = await landingDesktop.eval(rectOf('.lp-deck-grid button[aria-label^="Press"]'));
  await landingDesktop.send("Input.dispatchMouseEvent", { type: "mousePressed", x: sceneButton.cx, y: sceneButton.cy, button: "left", clickCount: 1, buttons: 1 });
  check("landing pointer press shows the held state", await landingDesktop.waitFor(`!!${heldKey}`));
  await landingDesktop.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.max(2, sceneButton.left - 20), y: Math.min(890, sceneButton.bottom + 40), button: "left", buttons: 1 });
  await landingDesktop.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.max(2, sceneButton.left - 20), y: Math.min(890, sceneButton.bottom + 40), button: "left", clickCount: 1, buttons: 1 });
  check("landing release outside the key clears the held state", await landingDesktop.waitFor(`!${heldKey}`));

  // A number shortcut fires once and ignores auto-repeat; release clears the held state.
  await landingDesktop.reload();
  await landingDesktop.waitFor("!!document.querySelector('.lp-deck-grid')");
  await landingDesktop.send("Page.bringToFront").catch(() => {});
  const digitKey = (type, repeat) => landingDesktop.send("Input.dispatchKeyEvent", { type, key: "1", code: "Digit1", windowsVirtualKeyCode: 49, nativeVirtualKeyCode: 49, ...(repeat ? { autoRepeat: true } : {}) });
  await digitKey("rawKeyDown", false);
  check("number shortcut holds the matching key", await landingDesktop.waitFor(`!!${heldKey}`));
  await digitKey("rawKeyDown", true);
  check("number shortcut ignores auto-repeat", (await landingStatus()) === "Scene: Desktop", await landingStatus());
  await digitKey("keyUp", false);
  check("releasing the number clears the held state", await landingDesktop.waitFor(`!${heldKey}`));

  // One Enter press on a focused key activates exactly once.
  await landingDesktop.eval("document.querySelector('.lp-deck-grid button').focus()");
  await pressKey(landingDesktop, "Enter", "Enter", 13, "\r");
  check("Enter activates a focused landing key once", (await landingStatus()) === "Scene: Be right back", await landingStatus());

  // Slider commit fires on release, not while the key gesture is in flight.
  await landingDesktop.eval("document.querySelector('.lp-deck-grid input[type=range]').focus()");
  await landingDesktop.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  check("landing slider does not commit during the key gesture", !(await landingStatus()).startsWith("Speakers"), await landingStatus());
  await landingDesktop.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  check("landing slider commits on release", (await landingStatus()).startsWith("Speakers"), await landingStatus());

  // Narrow phone: same controls, no overflow, and a cancelled touch never commits.
  const landingPhone = await openPage("landing-phone", `${LANDING_BASE}/`, { width: 390, height: 844, mobile: true });
  livePages.push(landingPhone);
  await landingPhone.waitFor("!!document.querySelector('.lp-deck-grid')");
  check("landing phone fits without horizontal overflow", await landingPhone.eval("document.documentElement.scrollWidth <= innerWidth"));
  check("landing phone keeps the essential mini deck controls", await landingPhone.eval("[...document.querySelectorAll('.lp-deck-grid button')].length === 4 && !!document.querySelector('.lp-deck-grid input[type=range]')"));
  await landingPhone.captureArtifacts("landing-phone");

  const phoneStatus = () => landingPhone.eval("document.querySelector('.lp-status-pill').textContent.trim()");
  const phoneSlider = await landingPhone.eval(rectOf(".lp-deck-grid input[type=range]"));
  const sliderX = (fraction) => phoneSlider.left + (phoneSlider.right - phoneSlider.left) * fraction;
  const touchSlider = (type, x) => landingPhone.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y: phoneSlider.cy }],
  });
  const statusBeforeCancel = await phoneStatus();
  await touchSlider("touchStart", sliderX(0.15));
  await touchSlider("touchMove", sliderX(0.85));
  await touchSlider("touchCancel");
  check("cancelled slider touch does not commit", (await phoneStatus()) === statusBeforeCancel, `${statusBeforeCancel} -> ${await phoneStatus()}`);
  await touchSlider("touchStart", sliderX(0.15));
  await touchSlider("touchMove", sliderX(0.85));
  await touchSlider("touchEnd");
  check("released slider touch commits", (await phoneStatus()).startsWith("Speakers"), await phoneStatus());

  // ------------------------------------------------------------ editor shell + onboarding
  const editor = await openPage("editor", `${BASE}/`, { width: 960, height: 680 });
  livePages.push(editor);
  check("first-run setup fills the window", await editor.waitFor("!!document.querySelector('.setup-shell')"));
  check("setup starts on welcome with the heading focused", await editor.eval("document.querySelector('.setup-story').classList.contains('setup-welcome') && document.querySelector('#setup-title').textContent === 'Start with one button.' && document.activeElement.id === 'setup-title'"));
  check("setup replaces the editor chrome without the old guide", await editor.eval("!document.querySelector('.app-shell, .topbar, .setup-guide') && document.querySelectorAll('.setup-shell').length === 1"));
  check("setup welcome offers all four rehearsal keys", await editor.eval("(() => { const keys = [...document.querySelectorAll('.setup-demo-key')]; return keys.length === 4 && keys.map((key) => key.getAttribute('aria-label')).join('|') === 'Rehearse OBS scene|Rehearse Microphone mute|Rehearse Play / pause|Rehearse Volume slider'; })()"));
  check("setup welcome starts untouched", await editor.eval("document.querySelector('.setup-hint').textContent === 'Try a key. This is just a rehearsal.' && !document.querySelector('.rehearsal.is-active')"));
  await editor.screenshot("/tmp/deck-design-onboarding.png");
  await sleep(500);
  await editor.screenshot("/tmp/deck-design-setup-welcome.png");
  await editor.eval(clickText('.setup-header .button', 'Skip setup'));
  check("skip closes setup and shows the editor", await editor.waitFor("!!document.querySelector('.app-shell') && !document.querySelector('.setup-shell')"));
  const skipState = await editor.eval("({ deck: localStorage.getItem('deck.local.v1'), setup: localStorage.getItem('deck.setup.v1') })");
  check("skip stores only the setup flag, never a deck", skipState.deck === null && skipState.setup === 'dismissed', JSON.stringify(skipState));
  check("skip returns focus to the editor page title", await editor.waitFor("document.activeElement.id === 'page-title'"));
  await editor.reload();
  check("a skipped setup stays closed after reload", await editor.waitFor("!!document.querySelector('.app-shell') && !document.querySelector('.setup-shell')"));
  check("skipped first run still shows the sample deck", await editor.eval("document.querySelectorAll('.control-tile').length === 4 && !localStorage.getItem('deck.local.v1')"));
  check("self-hosted Geist font loads", await editor.eval("document.fonts.ready.then(() => [...document.fonts].some(face => face.family === 'Geist' && face.status === 'loaded'))"));
  check("display branding uses zDeck in the title, meta, and PWA fields", await editor.eval("document.title === 'zDeck' && document.querySelector('meta[name=\"description\"]').content.startsWith('zDeck') && document.querySelector('meta[name=\"apple-mobile-web-app-title\"]').content === 'zDeck'"));
  check("navbar logo is the zDeck brand mark labelled as the editor", await editor.eval("(() => { const a = document.querySelector('.topbar .brand'); return a.getAttribute('aria-label') === 'zDeck editor' && !!a.querySelector('svg[aria-label=\"zDeck\"]'); })()"));
  const webManifest = await editor.eval("fetch('/manifest.webmanifest').then((response) => response.json())");
  check("PWA manifest keeps the zDeck display name", webManifest.name === 'zDeck' && webManifest.short_name === 'zDeck', JSON.stringify({ name: webManifest.name, short_name: webManifest.short_name }));
  const tauriConfig = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  check("Tauri display names use zDeck while the identifier stays put", tauriConfig.productName === 'zDeck' && tauriConfig.app.windows[0].title === 'zDeck' && tauriConfig.identifier === 'com.deck.local', JSON.stringify({ productName: tauriConfig.productName, title: tauriConfig.app.windows[0].title, identifier: tauriConfig.identifier }));
  check("desktop workspace has no horizontal overflow", await editor.eval("document.documentElement.scrollWidth <= innerWidth"));
  check("single topbar carries the editor chrome", await editor.eval("document.querySelectorAll('.topbar').length === 1"));
  check("no sidebar or floating deck frame", await editor.eval("!document.querySelector('.sidebar, .deck-frame, .right-panel')"));
  check("no global theme toggle remains", await editor.eval("!document.querySelector('.theme-toggle')"));
  check("desktop inspector sits beside the control grid", await editor.eval("(() => { const grid = document.querySelector('.control-grid').getBoundingClientRect(); const dock = document.querySelector('.inspector-dock').getBoundingClientRect(); return dock.left >= grid.right - 1 && dock.top < grid.bottom; })()"));
  check("control keys use 7px corners", await editor.eval("[...document.querySelectorAll('.control-tile')].every(el => getComputedStyle(el).borderRadius === '7px')"));
  check("control keys keep a shallow physical depth", await editor.eval("(() => { const shadow = getComputedStyle(document.querySelector('.control-tile')).boxShadow; return shadow.includes('0px 3px 0px') && !shadow.includes('0px 3px 0px 4px'); })()"), await editor.eval("getComputedStyle(document.querySelector('.control-tile')).boxShadow"));
  check("page switcher lists the deck pages", await editor.eval("document.querySelectorAll('#page-switcher option').length === 2"));
  await editor.screenshot("/tmp/deck-design-desktop.png");
  await editor.captureArtifacts("editor-desktop");

  // page switcher drives the active page
  await editor.eval(setSelect("#page-switcher", "page_media"));
  check("page switcher changes the active page", await editor.waitFor("document.querySelector('#page-title').textContent === 'Media'"));
  await editor.eval(setSelect("#page-switcher", "page_stream"));
  await editor.waitFor("document.querySelector('#page-title').textContent === 'Stream'");

  // ------------------------------------------------------------ action picker dialog
  await editor.eval("document.querySelector('.add-control').focus()");
  await editor.eval(click(".add-control"));
  check("action picker opens as a native dialog", await editor.eval("document.querySelector('.action-library').open"));
  const initialFocus = await editor.eval("({ id: document.activeElement?.id || '', label: document.activeElement?.getAttribute('aria-label') || '', inside: document.querySelector('.action-library').contains(document.activeElement) })");
  check("action picker initially focuses search", initialFocus.inside && initialFocus.id === 'action-search', JSON.stringify(initialFocus));
  check("every background control is inert while the modal is open", await editor.eval(`(() => { const controls = [...document.querySelectorAll('.topbar button, .topbar a, .control-tile .tile-primary, .add-control')]; return controls.length > 0 && controls.every((el) => { el.focus(); return document.querySelector('.action-library').contains(document.activeElement); }); })()`));
  await editor.screenshot("/tmp/deck-design-actions.png");

  await editor.eval(setValue("#action-search", "volume"));
  check("search filters to the matching action", await editor.eval("document.querySelectorAll('.action-library .action-row').length === 1 && document.querySelector('.action-row-name').textContent.includes('Volume')"));
  await editor.eval(setValue("#action-search", "zzzz"));
  check("search no-match state names the query", await editor.eval("!!document.querySelector('.action-library .empty-note')?.textContent.includes('zzzz') && document.querySelectorAll('.action-library .action-row').length === 0"));
  await editor.eval(setValue("#action-search", ""));
  check("clearing search resets the full list", await editor.eval("document.querySelectorAll('.action-library .action-row').length === 4"));
  check("picker groups actions under their catalog categories", await editor.eval("[...document.querySelectorAll('.action-group-title')].map((n) => n.textContent).join('|') === 'OBS|System|Media'"));
  await editor.eval(clickText('.action-category', 'System'));
  check("category button filters the list and marks itself pressed", await editor.eval("document.querySelector('.action-category[aria-pressed=\"true\"]').textContent === 'System' && document.querySelectorAll('.action-library .action-row').length === 1 && document.querySelector('.action-row-name').textContent.includes('Microphone')"));
  await editor.eval(setValue("#action-search", "volume"));
  check("search combines with the active category filter", await editor.eval("document.querySelectorAll('.action-library .action-row').length === 0 && !!document.querySelector('.action-library .empty-note')"));
  await editor.eval(clickText('.action-category', 'All'));
  check("All restores the searched list across categories", await editor.eval("document.querySelectorAll('.action-library .action-row').length === 1 && document.querySelector('.action-row-name').textContent.includes('Volume')"));
  await editor.eval(setValue("#action-search", ""));

  await editor.eval("document.querySelector('#action-search').focus()");
  await pressKey(editor, "Tab", "Tab", 9);
  await sleep(40);
  check("Tab moves focus from search into the category controls", await editor.eval("document.querySelector('.action-library').contains(document.activeElement) && document.activeElement.classList.contains('action-category')"));
  const visited = new Set();
  let enteredBackground = false;
  // Chrome may hand Tab to browser chrome between cycles; app controls must remain inert.
  for (let index = 0; index < 16; index += 1) {
    await pressKey(editor, "Tab", "Tab", 9);
    const focus = await editor.eval("({ inside: document.querySelector('.action-library').contains(document.activeElement), tag: document.activeElement.tagName, name: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim() })");
    if (focus.inside) visited.add(focus.name);
    else if (focus.tag !== 'BODY') enteredBackground = true;
  }
  check("Tab reaches every picker control without entering the background app", !enteredBackground && visited.size === 10, JSON.stringify([...visited]));
  await editor.eval("[...document.querySelectorAll('.action-category')].find((button) => button.textContent === 'Media').focus()");
  await pressKey(editor, "Enter", "Enter", 13, "\r");
  check("category buttons are keyboard operable", await editor.eval("document.querySelector('.action-category[aria-pressed=\"true\"]').textContent === 'Media' && document.querySelectorAll('.action-library .action-row').length === 2"));
  await editor.eval(clickText('.action-category', 'All'));
  await pressKey(editor, "Escape", "Escape", 27);
  check("Escape closes the action picker", await editor.waitFor("!document.querySelector('.action-library').open"));
  check("focus returns to the Add control button", await editor.eval("document.activeElement.classList.contains('add-control')"));

  // Native backdrop dismissal driven by real pointer input.
  await editor.eval(click('.add-control'));
  await editor.waitFor("document.querySelector('.action-library').open");
  const pickerBox = await editor.eval(rectOf('.action-library'));
  await pointerClick(editor, pickerBox.cx, pickerBox.top + 6);
  check("clicking inside the action picker padding keeps it open", await editor.eval("document.querySelector('.action-library').open"));
  const dragBox = await editor.eval(rectOf('.action-library'));
  await editor.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragBox.cx, y: dragBox.cy, button: "left", clickCount: 1, buttons: 1 });
  await editor.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.max(5, dragBox.left - 60), y: dragBox.cy, button: "left", clickCount: 1, buttons: 1 });
  check("a drag starting inside the picker and ending outside keeps it open", await editor.eval("document.querySelector('.action-library').open"));
  await pointerClick(editor, Math.max(5, pickerBox.left - 40), pickerBox.cy);
  check("a backdrop click closes the action picker", await editor.waitFor("!document.querySelector('.action-library').open"));

  await editor.eval(click('.add-control'));
  check("reopening the picker focuses search again", await editor.eval("document.activeElement.id === 'action-search'"));
  await editor.eval(setValue('#action-search', 'volume'));
  await editor.eval(clickText('.action-category', 'Media'));
  await editor.eval(click('[aria-label="Close action picker"]'));
  await editor.waitFor("document.getElementById('action-search').value === ''");
  await editor.eval(click('.add-control'));
  check("closing the picker resets search and category", await editor.waitFor("document.getElementById('action-search').value === '' && document.querySelector('.action-category[aria-pressed=\"true\"]').textContent === 'All' && document.querySelectorAll('.action-row').length === 4"), await editor.eval("JSON.stringify({query:document.getElementById('action-search').value,category:document.querySelector('.action-category[aria-pressed=\"true\"]').textContent,rows:document.querySelectorAll('.action-row').length})"));
  await editor.eval(click('[aria-label="Close action picker"]'));

  // ------------------------------------------------------------ clean phone + volume (before fixture edits)
  const designPhone = await openPage('design-phone', `${BASE}/#/phone`, { width: 390, height: 844, mobile: true });
  livePages.push(designPhone);
  await designPhone.waitFor("!!document.querySelector('.phone-shell')");
  check("phone header shows the zDeck brand mark, not a wordmark", await designPhone.eval("!!document.querySelector('.phone-header .phone-brand svg[aria-label=\"zDeck\"]')"));
  check("real phone viewport hides the desktop preview chrome", await designPhone.eval("getComputedStyle(document.querySelector('.phone-preview-bar')).display === 'none'"));
  await designPhone.eval('document.fonts.ready.then(() => true)');
  await designPhone.screenshot('/tmp/deck-design-phone.png');
  await designPhone.captureArtifacts('phone-preview');
  check("clean phone preview shows the two sample pages", await designPhone.eval("document.querySelectorAll('.phone-page-tab').length === 2"));
  await designPhone.eval(clickText('.phone-page-tab', 'Media'));
  await designPhone.waitFor("document.querySelector('.phone-page-heading h1').textContent === 'Media'");
  await designPhone.eval(setValue('.tile-volume input', '70'));
  check("phone volume preview reaches 70%", await designPhone.waitFor("document.querySelector('.volume-readout').textContent === '70%'"));
  await designPhone.screenshot('/tmp/deck-design-volume.png');

  const sliderBox = await designPhone.eval("(() => { const r = document.querySelector('.tile-volume input').getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right, y: r.top + r.height / 2 }; })()");
  check("phone volume fader is horizontal with a 44px hit area", sliderBox.width > sliderBox.height && sliderBox.height >= 44, JSON.stringify(sliderBox));
  await designPhone.eval("document.querySelector('.tile-volume input').focus()");
  await pressKey(designPhone, "End", "End", 35);
  check("End key jumps the horizontal fader to 100%", await designPhone.eval("Number(document.querySelector('.tile-volume input').value) === 100"));
  await pressKey(designPhone, "Home", "Home", 36);
  check("Home key jumps the horizontal fader to 0%", await designPhone.eval("Number(document.querySelector('.tile-volume input').value) === 0"));
  await pressKey(designPhone, "ArrowRight", "ArrowRight", 39);
  check("ArrowRight nudges the horizontal fader up", await designPhone.eval("Number(document.querySelector('.tile-volume input').value) === 1"));
  await pressKey(designPhone, "ArrowLeft", "ArrowLeft", 37);
  check("ArrowLeft nudges the horizontal fader down", await designPhone.eval("Number(document.querySelector('.tile-volume input').value) === 0"));
  for (const [name, x, assertion] of [
    ['right', sliderBox.right - 4, 'Number(document.querySelector(".tile-volume input").value) > 90'],
    ['left', sliderBox.left + 4, 'Number(document.querySelector(".tile-volume input").value) < 10'],
  ]) {
    await designPhone.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: sliderBox.y }] });
    await designPhone.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(`touching the ${name} end of the horizontal fader reaches that end`, await designPhone.eval(assertion));
  }

  // ------------------------------------------------------------ editing via inspector
  await editor.eval(clickText('.control-tile .tile-primary', 'Go live'));
  await editor.waitFor("!!document.querySelector('.inspector-form')");
  check("selecting a key opens its inspector", await editor.eval("document.querySelector('.inspector-form input[type=\"text\"]').value === 'Go live'"));
  await editor.eval(click('.icon-picker:not(.action-picker) > summary'));
  check('built-in icons are grouped by category', await editor.eval("[...document.querySelectorAll('.icon-picker legend')].map(el => el.textContent).join('|') === 'Built-in / Media|Built-in / System|Built-in / General'"));
  await editor.eval(setValue('.icon-picker input[type=search]', 'star'));
  check('icon search filters choices', await editor.waitFor("document.querySelectorAll('.icon-picker-grid button').length === 1"));
  await editor.eval("document.querySelector('.icon-picker-grid button').focus()");
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  check('keyboard selects a custom icon without changing the action', await editor.waitFor("!!document.querySelector('.control-tile.is-selected .lucide-star') && document.querySelector('.action-picker [aria-pressed=\"true\"]').textContent === 'OBS scene'"));
  await editor.eval(setValue('.icon-picker input[type=search]', ''));
  await editor.screenshot('/tmp/zdeck-custom-icons-builtins.png');
  check("remove button keeps danger text with a visible tinted surface and border", await editor.eval("(() => { const cs = getComputedStyle(document.querySelector('.inspector-actions .button.danger')); return cs.color === 'rgb(239, 167, 176)' && cs.borderTopWidth === '1px' && cs.borderTopColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.boxShadow !== 'none'; })()"));
  await editor.eval(setValue('.inspector-form input[type="text"]', 'Go live edited'));
  check("inspector rename persists in the field", await editor.waitFor("document.querySelector('.inspector-form input[type=\"text\"]').value === 'Go live edited'"));

  check('sidebar has collapsible appearance, layout and action sections without reorder arrows', await editor.eval("document.querySelectorAll('.inspector-section > summary').length === 3 && !document.querySelector('.inspector-actions .move-group')"));
  await editor.eval("[...document.querySelectorAll('.inspector-section > summary')].find(el => el.textContent === 'Layout').focus()");
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  check('sidebar sections collapse with the keyboard', await editor.waitFor("(() => { const section = document.querySelector('.span-fields').parentElement; return !section.open && section.getBoundingClientRect().height <= section.querySelector('summary').getBoundingClientRect().height + 14; })()"));
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  await editor.eval("document.querySelector('.control-tile.is-selected .tile-order > summary').focus()");
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  check('keyboard opens a labelled position alternative to dragging', await editor.eval("document.querySelector('.control-tile.is-selected .tile-order').open && !!document.querySelector('.control-tile.is-selected .tile-order select[aria-label]')"));
  const orderBefore = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map(n => n.textContent).join('|')");
  await editor.eval(setSelect('.control-tile.is-selected .tile-order select', '3'));
  const orderAfter = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map(n => n.textContent).join('|')");
  check('position menu moves a control without swapping intervening controls', orderAfter === 'Starting soon|Mic mute|Play / pause|Go live edited', `${orderBefore} -> ${orderAfter}`);
  const keyboardOrderBefore = orderAfter;
  await editor.eval("document.querySelector('.control-tile.is-selected .tile-order select').focus()");
  await pressKey(editor, 'Home', 'Home', 36);
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  const keyboardOrderAfter = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map(n => n.textContent).join('|')");
  check('keyboard selection of a position reorders the control', keyboardOrderBefore !== keyboardOrderAfter, `${keyboardOrderBefore} -> ${keyboardOrderAfter}`);

  // Real pointer input catches failures that synthetic native drag events miss.
  await editor.eval("document.querySelector('.control-tile').scrollIntoView({block:'center'})");
  await editor.send('Page.bringToFront');
  const reorderGrip = await editor.eval(rectOf('.control-tile .tile-order summary'));
  const reorderTarget = await editor.eval(rectOf('.control-tile:nth-child(2)'));
  await editor.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: reorderGrip.cx, y: reorderGrip.cy, button: 'left', buttons: 1, clickCount: 1 });
  await editor.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: reorderGrip.cx + 10, y: reorderGrip.cy, button: 'left', buttons: 1 });
  await editor.waitFor("!!document.querySelector('.is-dragging')");
  await editor.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: reorderTarget.cx, y: reorderTarget.cy, button: 'left', buttons: 1 });
  check('drag handle and drop target provide clear feedback', await editor.waitFor("!!document.querySelector('.is-dragging') && !!document.querySelector('.is-drop-target')"));
  check('placement preview uses a solid translucent fill and grabbing cursor', await editor.eval("(() => { const target = document.querySelector('.is-drop-target'); const preview = getComputedStyle(target, '::after'); return preview.borderTopStyle === 'solid' && preview.borderTopWidth === '3px' && preview.backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(target).cursor === 'grabbing'; })()"));
  await editor.screenshot('/tmp/zdeck-control-drag-feedback.png');
  await editor.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: reorderTarget.cx, y: reorderTarget.cy, button: 'left', buttons: 0, clickCount: 1 });
  check('drop reorders without pressing a control', await editor.waitFor("document.querySelector('.workspace-footer').textContent.includes('Moved Go live edited to position 2') && !document.querySelector('.is-dragging') && !document.querySelector('.is-drop-target') && !document.querySelector('.is-pressed')"));
  await editor.eval(setSelect('.control-tile.is-selected .tile-order select', '0'));
  const clickGrip = await editor.eval(rectOf('.control-tile.is-selected .tile-order summary'));
  await pointerClick(editor, clickGrip.cx, clickGrip.cy);
  check('clicking the grip without dragging opens the position menu', await editor.waitFor("document.querySelector('.control-tile.is-selected .tile-order').open"));
  await pointerClick(editor, clickGrip.cx, clickGrip.cy);

  // Spans persist without forcing extra implicit columns on narrower grids.
  check('action dropdown header has no action icon', await editor.eval("!document.querySelector('.action-picker > summary .lucide:not(.icon-picker-toggle)')"));
  check('layout omits the redundant note', await editor.eval("!document.querySelector('.span-fields .field-note')"));
  check('sizing uses Width and Height without renaming persisted spans', await editor.eval("[...document.querySelectorAll('.span-fields label > span')].map(n => n.textContent).join('|') === 'Width|Height'"));
  await typeInput(editor, '.span-fields label:first-child input', '4');
  check('width updates immediately without losing focus', await editor.waitFor("getComputedStyle(document.querySelector('.control-tile.is-selected')).gridColumnStart === 'span 4' && document.activeElement === document.querySelector('.span-fields label:first-child input')"));
  await typeInput(editor, '.span-fields label:nth-child(2) input', '2');
  check('height updates immediately without losing focus', await editor.waitFor("getComputedStyle(document.querySelector('.control-tile.is-selected')).gridRowStart === 'span 2' && document.activeElement === document.querySelector('.span-fields label:nth-child(2) input')"));
  check('editor honors configured row and column spans', await editor.waitFor("getComputedStyle(document.querySelector('.control-tile.is-selected')).gridRowStart === 'span 2' && getComputedStyle(document.querySelector('.control-tile.is-selected')).gridColumnStart === 'span 4'"));
  await designPhone.eval(clickText('.phone-page-tab', 'Stream'));
  check('phone renderer honors rows and clamps columns in portrait', await designPhone.waitFor("getComputedStyle(document.querySelector('.phone-grid .control-tile')).gridRowStart === 'span 2' && getComputedStyle(document.querySelector('.phone-grid .control-tile')).gridColumnStart === 'span 2'"));
  await designPhone.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  check('phone renderer restores saved column span in landscape', await designPhone.eval("getComputedStyle(document.querySelector('.phone-grid .control-tile')).gridColumnStart === 'span 4' && document.documentElement.scrollWidth <= innerWidth"));
  await designPhone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await editor.eval(setValue('.span-fields label:first-child input', '0'));
  check('invalid span restores the last valid integer', await editor.eval("document.querySelector('.span-fields input').value === '4'"));
  await editor.reload();
  await editor.waitFor("!!document.querySelector('.control-tile')");
  check('layout spans survive reload', await editor.eval("getComputedStyle(document.querySelector('.control-tile')).gridRowStart === 'span 2'"));
  await editor.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  check('saved four-column span clamps to the two-column responsive grid', await editor.eval("getComputedStyle(document.querySelector('.control-tile')).gridColumnStart === 'span 2' && document.documentElement.scrollWidth <= innerWidth"));
  await editor.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  await editor.eval(clickText('.control-tile .tile-primary', 'Go live edited'));
  await editor.eval(setValue('.span-fields label:first-child input', '1'));
  await editor.eval(setValue('.span-fields label:nth-child(2) input', '1'));

  // refresh persistence
  await editor.reload();
  await editor.waitFor("!!document.querySelector('.app-shell')");
  const persisted = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')");
  check("refresh keeps the edited deck", persisted === keyboardOrderAfter, persisted);
  check("saved deck no longer shows onboarding", await editor.eval("!document.querySelector('.setup-shell')"));
  check('custom icon survives reload', await editor.eval("!!document.querySelector('.control-tile .lucide-star')"));
  await editor.eval(clickText('.control-tile .tile-primary', 'Go live edited'));
  await editor.eval(click('.icon-picker:not(.action-picker) > summary'));
  await editor.eval(clickText('.icon-picker:not(.action-picker) button', 'Use action default'));
  check('reset restores action default', await editor.waitFor("!!document.querySelector('.control-tile.is-selected .lucide-clapperboard') && !document.querySelector('.control-tile.is-selected .lucide-star')"));

  await editor.eval("document.querySelector('.action-picker > summary').focus()");
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  check('action dropdown opens with a keyboard and exposes its selected action', await editor.eval("document.querySelector('.action-picker').open && document.querySelector('.action-picker [aria-pressed=true]').textContent === 'OBS scene'"));
  await editor.eval("document.querySelector('.action-picker [aria-pressed=true]').focus()");
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  check('action choice closes the picker and restores focus to its trigger', await editor.waitFor("!document.querySelector('.action-picker').open && document.activeElement === document.querySelector('.action-picker > summary')"));

  // ------------------------------------------------------------ settings + theme segmented control
  await editor.eval(click('[aria-label="Open settings"]'));
  check("settings opens from the topbar", await editor.waitFor("!!document.querySelector('.settings-view')"));
  await editor.eval("window.scrollTo(0, document.documentElement.scrollHeight)");
  check('Settings back navigation remains visible while scrolling', await editor.eval("(() => { const button = document.querySelector('[aria-label=\"Back to editor\"]'); const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('a') === button; })()"));
  await editor.eval("window.scrollTo(0,0)");
  check("active settings control toggles back to the editor", await editor.eval("document.querySelector('[aria-label=\"Back to editor\"]')?.getAttribute('href') === '#/' && document.querySelector('[aria-label=\"Back to editor\"]').getAttribute('aria-current') === 'page'"));
  check("closed About this preview reserves no blank space after its summary", await editor.eval("(() => { const d = document.querySelector('.preview-scope'); const s = d.querySelector('summary'); return !d.open && getComputedStyle(d).display === 'block' && (d.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom) <= 2; })()"));
  check("closed Storage details reserves no blank space after its summary", await editor.eval("(() => { const d = document.querySelector('.storage-details'); const s = d.querySelector('summary'); return !d.open && (d.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom) <= 2; })()"));
  check("Storage and About disclosures share one row geometry and chevron", await editor.eval("(() => { const rows = [document.querySelector('.storage-details > summary'), document.querySelector('.preview-scope > summary')]; return rows.every((el) => !!el && el.classList.contains('disclosure')) && new Set(rows.map((el) => Math.round(el.getBoundingClientRect().left))).size === 1 && new Set(rows.map((el) => Math.round(el.getBoundingClientRect().height))).size === 1 && getComputedStyle(rows[0], '::before').content !== 'none' && getComputedStyle(rows[0], '::before').borderRightStyle === 'solid'; })()"));
  await editor.eval(click('[aria-label="Back to editor"]'));
  check("clicking the same settings control returns to the editor", await editor.waitFor("!!document.querySelector('.canvas-panel') && !document.querySelector('.settings-view')"));
  await editor.eval(click('[aria-label="Open settings"]'));
  await editor.waitFor("!!document.querySelector('.settings-view')");
  check("settings groups are navigable with an active General section", await editor.eval("document.querySelector('.settings-nav [aria-current=page]')?.textContent === 'General' && document.querySelectorAll('.settings-nav a').length === 3"));
  check("browser Settings does not offer native close behavior", await editor.eval("!document.getElementById('desktop-preferences-heading')"));
  await editor.eval("document.querySelector('.settings-nav a[href=\"#/settings/phone\"]').focus()");
  await pressKey(editor, 'Enter', 'Enter', 13, '\r');
  check("Phone connection navigation works with the keyboard and updates active section", await editor.waitFor("document.querySelector('.settings-nav [aria-current=page]')?.textContent === 'Phone connection' && !document.querySelector('[aria-label=\"Phone connection\"][role=region]').hidden"));
  await editor.eval(click('.settings-nav a[href="#/settings/general"]'));
  await editor.waitFor("document.querySelector('.settings-nav [aria-current=page]')?.textContent === 'General'");
  check("settings shows the segmented theme buttons", await editor.eval("document.querySelectorAll('.segmented button').length === 2"));
  await editor.eval(clickText('.segmented .button', 'Light'));
  check("theme segmented control switches to light", await editor.waitFor("document.documentElement.dataset.theme === 'light'"));
  await editor.eval("location.hash = '#/'");
  await editor.waitFor("!!document.querySelector('.canvas-panel')");
  check("light editor shows the default page", await editor.waitFor("document.querySelector('#page-title').textContent === 'Stream'"));
  await editor.screenshot("/tmp/deck-design-light.png");
  await editor.eval(click('[aria-label="Open settings"]'));
  await editor.waitFor("!!document.querySelector('.settings-view')");
  await editor.eval(clickText('.segmented .button', 'Dark'));
  await editor.waitFor("document.documentElement.dataset.theme === 'dark'");
  await editor.eval("location.hash = '#/'");
  await editor.waitFor("!!document.querySelector('.canvas-panel')");

  // ------------------------------------------------------------ onboarding walkthrough in an isolated context
  const { browserContextId: firstRunCtx } = await cdp.send('Target.createBrowserContext');
  const firstRun = await openPage('first-run', `${BASE}/`, { width: 960, height: 680 }, firstRunCtx);
  livePages.push(firstRun);
  await firstRun.waitFor("!!document.querySelector('.setup-shell')");
  check("fresh profile starts on the setup welcome step", await firstRun.eval("document.querySelector('.setup-story').classList.contains('setup-welcome')"));
  check("setup header shows the zDeck brand mark, not a wordmark", await firstRun.eval("!!document.querySelector('.setup-header .brand svg[aria-label=\"zDeck\"]')"));
  const rehearsalHint = () => firstRun.eval("document.querySelector('.setup-hint').textContent");

  // welcome: every catalog action rehearses locally, scene presses repeat safely
  await firstRun.eval("document.querySelector('[aria-label=\"Rehearse OBS scene\"]').focus()");
  await pressKey(firstRun, "Enter", "Enter", 13, "\r");
  check("scene rehearsal switches the demo once", (await rehearsalHint()) === "Rehearsal switched to Scene 1." && await firstRun.eval("document.querySelector('.rehearsal').classList.contains('is-active') && document.querySelector('.scene-after span').textContent === 'Scene 1'"));
  await firstRun.eval(click('[aria-label="Rehearse OBS scene"]'));
  check("repeating the scene press keeps the demo switched, not reset", (await rehearsalHint()) === "Rehearsal switched to Scene 1." && await firstRun.eval("document.querySelector('.rehearsal').classList.contains('is-active')"));

  await firstRun.eval(click('[aria-label="Rehearse Microphone mute"]'));
  check("mic rehearsal mutes the demo", (await rehearsalHint()) === "Rehearsal microphone muted." && await firstRun.eval("document.querySelector('.rehearsal').classList.contains('is-active') && document.querySelector('.rehearsal-audio > span').textContent === 'Microphone muted'"));
  await firstRun.eval(click('[aria-label="Rehearse Microphone mute"]'));
  check("mic rehearsal toggles back to unmuted", (await rehearsalHint()) === "Rehearsal microphone on." && await firstRun.eval("!document.querySelector('.rehearsal').classList.contains('is-active') && document.querySelector('.rehearsal-audio > span').textContent === 'Microphone on'"));

  await firstRun.eval(click('[aria-label="Rehearse Play / pause"]'));
  check("playback rehearsal starts the demo", (await rehearsalHint()) === "Rehearsal playback started." && await firstRun.eval("document.querySelector('.rehearsal-player small').textContent === 'Playing'"));
  await firstRun.eval(click('[aria-label="Rehearse Play / pause"]'));
  check("playback rehearsal toggles back to paused", (await rehearsalHint()) === "Rehearsal playback paused." && await firstRun.eval("document.querySelector('.rehearsal-player small').textContent === 'Paused'"));

  await firstRun.eval(click('[aria-label="Rehearse Volume slider"]'));
  check("volume rehearsal shows 75%", (await rehearsalHint()) === "Rehearsal volume 75%." && await firstRun.eval("document.querySelector('.rehearsal-volume strong').textContent === '75%'"));
  await firstRun.eval(click('[aria-label="Rehearse Volume slider"]'));
  check("second volume press shows 50%", (await rehearsalHint()) === "Rehearsal volume 50%." && await firstRun.eval("document.querySelector('.rehearsal-volume strong').textContent === '50%'"));

  // build: radio arrows, blank validation, draft survives Back
  await firstRun.eval(clickText('.setup-actions .button.primary', 'Make a button'));
  check("guide advances to build with the heading focused", await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-build') && document.querySelector('#setup-title').textContent === 'Make it yours.' && document.activeElement.id === 'setup-title'"));
  check("welcome rehearsal choice carries into build", await firstRun.eval("document.querySelectorAll('.setup-choice input').length === 4 && document.querySelector('.setup-choice input:checked').value === 'volume' && document.querySelector('input[name=\"label\"]').value === 'Volume' && !document.querySelector('input[name=\"scene\"]')"));
  check("configuration shows the chosen action without asking for a second selection", await firstRun.eval("!document.querySelector('.setup-action-change').open && document.querySelector('.setup-action-change summary').textContent.includes('Volume slider')"));
  await chooseSetupAction(firstRun, 'obs-scene');
  check("build step preselects the scene action and its defaults", await firstRun.eval("document.querySelector('.setup-choice input:checked').value === 'obs-scene' && document.querySelector('input[name=\"label\"]').value === '' && document.querySelector('input[name=\"scene\"]').value === 'Scene 1'"));
  await firstRun.eval("[...document.querySelectorAll('.setup-choice input')].find((el) => el.value === 'obs-scene').focus()");
  await pressKey(firstRun, "ArrowRight", "ArrowRight", 39);
  check("arrow keys move through the action radios", await firstRun.waitFor("document.querySelector('.setup-choice input:checked').value === 'mic-mute' && document.querySelector('input[name=\"label\"]').value === 'Mic mute' && !document.querySelector('input[name=\"scene\"]')"));
  await pressKey(firstRun, "ArrowLeft", "ArrowLeft", 37);
  check("arrowing back restores the scene fields", await firstRun.waitFor("document.querySelector('.setup-choice input:checked').value === 'obs-scene' && document.querySelector('input[name=\"scene\"]').value === 'Scene 1'"));

  for (const [kind, first, second] of [
    ['mic-mute', 'Rehearsal: Microphone muted.', 'Rehearsal: Microphone unmuted.'],
    ['media-play-pause', 'Rehearsal: Playback started.', 'Rehearsal: Playback paused.'],
  ]) {
    await chooseSetupAction(firstRun, kind);
    await firstRun.eval(clickText('.setup-actions .button.primary', 'Try this control'));
    await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-try')");
    check(`${kind} practice requires an interaction`, await firstRun.eval("document.querySelector('.setup-actions .primary').disabled"));
    await firstRun.eval(click('.setup-practice-key .tile-primary'));
    check(`${kind} practice reports its first toggle`, await firstRun.eval(`document.querySelector('.setup-result').textContent === ${JSON.stringify(first)} && !document.querySelector('.setup-actions .primary').disabled`));
    await firstRun.eval(click('.setup-practice-key .tile-primary'));
    check(`${kind} practice reports its second toggle`, await firstRun.eval(`document.querySelector('.setup-result').textContent === ${JSON.stringify(second)}`));
    await firstRun.eval(clickText('.setup-actions .button.quiet', 'Edit button'));
    await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-build')");
  }
  await chooseSetupAction(firstRun, 'obs-scene');

  await firstRun.eval(setValue('input[name="label"]', ''));
  check("blank OBS label allows the scene name to supply its title", await firstRun.eval("!document.querySelector('.setup-fields input[name=\"label\"]').required && !document.querySelector('.setup-actions button[type=\"submit\"]').disabled"));
  await firstRun.eval(setValue('input[name="label"]', 'Practice scene'));
  await firstRun.eval(setValue('input[name="scene"]', ''));
  check("blank scene blocks the build submit", await firstRun.eval("document.querySelector('.setup-fields input[name=\"scene\"]').validity.valueMissing && document.querySelector('.setup-actions button[type=\"submit\"]').disabled"));
  await firstRun.eval(setValue('input[name="scene"]', 'Practice'));
  check("a complete draft enables the build submit", await firstRun.eval("!document.querySelector('.setup-actions button[type=\"submit\"]').disabled"));
  await firstRun.eval(click('[aria-label="Change action"]'));
  check("closing action choices preserves the configured draft", await firstRun.eval("!document.querySelector('.setup-action-change').open && document.querySelector('input[name=\"label\"]').value === 'Practice scene'"));
  await sleep(500);
  await firstRun.screenshot("/tmp/deck-design-setup-build.png");

  await firstRun.eval(clickText('.setup-actions .button.primary', 'Try this control'));
  check("guide advances to try and requires a rehearsal", await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-try') && document.querySelector('#setup-title').textContent === 'Give it a press.'"));
  check("try step starts with Add disabled", await firstRun.eval("document.querySelector('.setup-result').textContent === 'Your button is ready to try.' && [...document.querySelectorAll('.setup-actions .button.primary')].every((button) => button.disabled)"));
  check("try step promises no desktop action", await firstRun.eval("document.querySelector('.setup-hint').textContent === 'Nothing runs on your desktop during setup.'"));
  check("try step shows the destination separately and points to phone settings", await firstRun.eval("document.querySelector('.setup-destination').textContent === 'Page: Stream' && document.querySelector('.setup-limitation').textContent === 'Connect your phone in Settings.'"));
  await sleep(500);
  await firstRun.screenshot("/tmp/deck-design-setup-try.png");
  await firstRun.eval(clickText('.setup-actions .button.quiet', 'Edit button'));
  check("Back to build preserves the draft label and scene", await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-build') && document.querySelector('input[name=\"label\"]').value === 'Practice scene' && document.querySelector('input[name=\"scene\"]').value === 'Practice' && document.querySelector('.setup-choice input:checked').value === 'obs-scene'"));
  await firstRun.eval(clickText('.setup-actions .button.primary', 'Try this control'));
  await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-try')");

  await firstRun.eval("document.querySelector('.setup-practice-key .tile-primary').focus()");
  await pressKey(firstRun, "Enter", "Enter", 13, "\r");
  check("rehearsing the draft scene enables Add", await firstRun.waitFor("document.querySelector('.setup-result').textContent === 'Rehearsal switched to Practice.' && ![...document.querySelectorAll('.setup-actions .button.primary')].some((button) => button.disabled)"));
  const rehearsedResult = await firstRun.eval("document.querySelector('.setup-result').textContent");
  await firstRun.eval(click('.setup-practice-key .tile-primary'));
  check("repeated scene press does not reset the rehearsal", (await firstRun.eval("document.querySelector('.setup-result').textContent")) === rehearsedResult && await firstRun.eval("document.querySelector('.rehearsal').classList.contains('is-active')"));

  const deckBeforeAdd = await firstRun.eval("localStorage.getItem('deck.local.v1')");
  check("nothing is saved before Add", deckBeforeAdd === null, String(deckBeforeAdd && deckBeforeAdd.slice(0, 60)));
  await sleep(300);
  await firstRun.screenshot("/tmp/deck-design-setup-result.png");
  await firstRun.eval(clickText('.setup-actions .button.primary', 'Add to page'));
  check("Add closes setup and shows the new editor", await firstRun.waitFor("!!document.querySelector('.app-shell') && !document.querySelector('.setup-shell')"));
  check("Add returns focus to the page title", await firstRun.waitFor("document.activeElement.id === 'page-title'"));
  const addedDeck = await firstRun.eval("JSON.parse(localStorage.getItem('deck.local.v1'))");
  const addedPage = addedDeck.pages.find((deckPage) => deckPage.id === addedDeck.activePageId);
  const addedControls = addedPage.controls.filter((control) => control.label === 'Practice scene');
  check("Add saves the configured control exactly once", addedControls.length === 1 && addedControls[0].action === 'obs-scene' && addedControls[0].scene === 'Practice' && addedPage.controls.length === 5, JSON.stringify(addedControls));
  check("Add remembers the setup flag", await firstRun.eval("localStorage.getItem('deck.setup.v1') === 'dismissed'"));
  check("the new control is selected in the inspector", await firstRun.eval("document.querySelector('.inspector-form input[type=\"text\"]').value === 'Practice scene'"));
  await firstRun.screenshot("/tmp/deck-design-setup-result-editor.png");
  await firstRun.reload();
  check("a saved deck skips onboarding after reload", await firstRun.waitFor("!!document.querySelector('.app-shell') && !document.querySelector('.setup-shell') && document.querySelectorAll('.control-tile').length === 5"));

  // Replay setup from Settings keeps the existing deck intact.
  await firstRun.eval(click('[aria-label="Open settings"]'));
  await firstRun.waitFor("!!document.querySelector('.settings-view')");
  check("settings offers Replay setup", await firstRun.eval("[...document.querySelectorAll('.settings-view button')].some((button) => button.textContent.includes('Replay setup'))"));
  await firstRun.eval(clickText('.settings-view button', 'Replay setup'));
  check("Replay setup opens the full-window guide on welcome", await firstRun.waitFor("!!document.querySelector('.setup-shell') && location.hash === '#/' && document.querySelector('.setup-story').classList.contains('setup-welcome') && document.activeElement.id === 'setup-title'"));
  await firstRun.eval(clickText('.setup-actions .button.primary', 'Make a button'));
  await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-build')");
  await chooseSetupAction(firstRun, 'volume');
  await firstRun.eval(setValue('input[name="label"]', 'Replay volume'));
  check("volume choice swaps the scene field for nothing extra", await firstRun.eval("document.querySelector('.setup-choice input:checked').value === 'volume' && !document.querySelector('input[name=\"scene\"]') && !document.querySelector('.setup-actions button[type=\"submit\"]').disabled"));
  await firstRun.eval(clickText('.setup-actions .button.primary', 'Try this control'));
  await firstRun.waitFor("document.querySelector('.setup-story').classList.contains('setup-try') && !!document.querySelector('.setup-practice-key input[type=\"range\"]')");
  await firstRun.eval(setValue('.setup-practice-key input[type="range"]', '35'));
  check("sliding the rehearsal volume enables Add", await firstRun.waitFor("document.querySelector('.setup-result').textContent === 'Rehearsal: Volume changed to 35%.' && [...document.querySelectorAll('.setup-actions .button.primary')].every((button) => !button.disabled)"));
  await firstRun.eval(clickText('.setup-actions .button.primary', 'Add to page'));
  await firstRun.waitFor("!!document.querySelector('.app-shell')");
  const replayDeck = await firstRun.eval("JSON.parse(localStorage.getItem('deck.local.v1'))");
  const replayPage = replayDeck.pages.find((deckPage) => deckPage.id === replayDeck.activePageId);
  const replayVolume = replayPage.controls.filter((control) => control.label === 'Replay volume');
  check("replay preserves the existing deck and adds once", replayPage.controls.length === 6 && replayPage.controls.filter((control) => control.label === 'Practice scene').length === 1 && replayVolume.length === 1 && replayVolume[0].volume === 35, JSON.stringify(replayDeck.pages[0].controls.map((c) => c.label)));
  await cdp.send('Target.disposeBrowserContext', { browserContextId: firstRunCtx });

  // ------------------------------------------------------------ welcome choice continuity on a fresh profile
  const { browserContextId: continuityCtx } = await cdp.send('Target.createBrowserContext');
  const continuity = await openPage('continuity', `${BASE}/`, { width: 960, height: 680 }, continuityCtx);
  livePages.push(continuity);
  await continuity.waitFor("!!document.querySelector('.setup-shell')");
  await continuity.eval(click('[aria-label="Rehearse Volume slider"]'));
  await continuity.eval(clickText('.setup-actions .button.primary', 'Make a button'));
  check("a rehearsed Volume choice lands on the build step as Volume", await continuity.waitFor("document.querySelector('.setup-story').classList.contains('setup-build') && document.querySelector('.setup-choice input:checked').value === 'volume' && document.querySelector('input[name=\"label\"]').value === 'Volume' && !document.querySelector('input[name=\"scene\"]')"));
  await chooseSetupAction(continuity, 'obs-scene');
  await continuity.eval(setValue('input[name="label"]', 'Kept label'));
  await continuity.eval(clickText('.setup-actions .button.quiet', 'Back'));
  await continuity.waitFor("document.querySelector('.setup-story').classList.contains('setup-welcome')");
  await continuity.eval(clickText('.setup-actions .button.primary', 'Make a button'));
  check("Back then Next keeps the chosen kind and draft without a reset", await continuity.waitFor("document.querySelector('.setup-story').classList.contains('setup-build') && document.querySelector('.setup-choice input:checked').value === 'obs-scene' && document.querySelector('input[name=\"label\"]').value === 'Kept label' && document.querySelector('input[name=\"scene\"]').value === 'Scene 1'"));
  await cdp.send('Target.disposeBrowserContext', { browserContextId: continuityCtx });

  // ------------------------------------------------------------ setup on narrow and short viewports
  const { browserContextId: tightCtx } = await cdp.send('Target.createBrowserContext');
  const narrowSetup = await openPage('setup-narrow', `${BASE}/`, { width: 320, height: 700, mobile: true }, tightCtx);
  livePages.push(narrowSetup);
  await narrowSetup.waitFor("!!document.querySelector('.setup-shell')");
  check("setup welcome fits a 320px viewport", await narrowSetup.eval("document.documentElement.scrollWidth <= innerWidth && document.querySelectorAll('.setup-demo-key').length === 4"));
  await narrowSetup.eval(clickText('.setup-actions .button.primary', 'Make a button'));
  await narrowSetup.waitFor("document.querySelector('.setup-story').classList.contains('setup-build')");
  check("setup build stacks its fields on narrow screens", await narrowSetup.eval("document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('.setup-fields')).gridTemplateColumns.split(' ').length === 1"));
  await narrowSetup.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 460, deviceScaleFactor: 1, mobile: false });
  check("setup build survives a short viewport", await narrowSetup.eval("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.setup-actions .button.primary').getBoundingClientRect().right <= innerWidth"));
  await cdp.send('Target.disposeBrowserContext', { browserContextId: tightCtx });

  // ------------------------------------------------------------ desktop pairing presentation (owned IPC fake only)
  const { browserContextId: adminCtx } = await cdp.send('Target.createBrowserContext');
  const admin = await openPage('pairing-settings', null, { width: 960, height: 680 }, adminCtx);
  livePages.push(admin);
  // Rust migrates this shared legacy fixture before returning native snapshots.
  const smokeSvgSource = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>window.__iconScriptRan=true</script><circle cx="12" cy="12" r="10" fill="#6ee7b7"/></svg>').toString('base64');
  const smokePngSource = 'data:image/png;base64,' + readFileSync(join(ROOT, 'public/icons/favicon-32.png')).toString('base64');
  const adminDeck = { ...JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/deck.sample.json'), 'utf8')), version: 2 };
  await admin.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.isTauri = true;
    window.__adminCalls = [];
    // Fake native disk state uses a test-only key to survive browser reloads.
    // Production service restoration/persistence belongs to RemoteAdmin, not browser storage.
    const savedService = JSON.parse(localStorage.getItem('zdeck.smoke.nativeService') || 'null');
    let running = savedService ? savedService.enabled : !localStorage.getItem('deck.remote.origin.v1'), invitationNumber = 0;
    window.__remoteStartOrigins = [];
    window.__desktopCalls = [];
    let savedDeck = ${JSON.stringify(adminDeck)}, savedRevision = 1;
    const emptyPlugin = {status:'disconnected', manifest:null, state:null, lastError:null};
    const cachedPlugins = {};
    window.__removedPlugins = [];
    window.__pluginCalls = [];
    window.__pluginArgs = null;
    window.__pluginsInstalled = false;
    window.__trustedPlugins = [];
    window.__runtimeStatus = 'detected';
    const pluginManifest = {id:'spotify', version:'0.1.0', protocolVersion:1, actions:[
      {id:'set-volume', title:'Spotify <volume>', config:{volume:{type:'integer',minimum:0,maximum:100}}},
      {id:'level', title:'Generic level', config:{amount:{type:'integer',minimum:-20,maximum:200,control:{step:5}}}},
      {id:'power', title:'Generic power', config:{enabled:{type:'boolean',control:{stateKey:'powered'}}}}
    ], icons:[
      {id:'badge', title:'Media badge', category:'Media', src:${JSON.stringify(smokeSvgSource)}},
      {id:'logo', title:'Logo', category:'Brand', src:${JSON.stringify(smokePngSource)}},
      {id:'unreadable', title:'Unreadable', category:'General', src:'data:image/png;base64,AAAA'}
    ]};
    let origin = savedService?.origin || 'https://fixture.tailnet.ts.net', mode = savedService?.mode || 'tailscale';
    window.__remoteStartArgs = [];
    const status = () => ({running, mode: running ? mode : null, origin: running ? origin : null, port: running ? 45829 : null, pendingDevices: 0, approvedDevices: 0, connectedSockets: 0});
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.__adminCalls.push(command);
      if (command === 'desktop_tray_notice') return null;
      if (command === 'desktop_close_to_tray') return window.__closeToTray ?? false;
      if (command === 'desktop_set_close_to_tray') {
        if (window.__failPreferenceSave) throw 'Desktop preference save failed';
        return window.__closeToTray = args.enabled;
      }
      if (command === 'native_deck_load') return { exists: true, revision: savedRevision, deck: savedDeck };
      if (command === 'native_deck_save') {
        if (window.__holdSave) await new Promise(resolve => { window.__finishSave = resolve; });
        if (window.__failSave) throw {kind:'io',message:'The test deck could not be saved.'};
        if (window.__conflictSave) throw {kind:'conflict',message:'The deck was changed elsewhere.',currentRevision:savedRevision+1};
        savedDeck = args.deck; savedRevision = args.expectedRevision + 1;
        return { exists: true, revision: savedRevision, deck: savedDeck };
      }
      if (command === 'desktop_run_control') {
        window.__desktopCalls.push(args);
        if (Object.keys(args).some(k => !['commandId','revision','controlId','value'].includes(k)) || args.revision !== savedRevision) throw {code:'invalid_request',message:'wrong envelope'};
        if (window.__holdDesktop) await new Promise(resolve => { window.__finishDesktop = resolve; });
        if (window.__desktopError) throw {code:window.__desktopError,message:'raw secret diagnostic'};
        const control = savedDeck.pages.flatMap(p => p.controls).find(c => c.id === args.controlId);
        if (control?.pluginAction === 'power') cachedPlugins.spotify = {...cachedPlugins.spotify, state:{powered:args.value === 1}};
        return {id:args.commandId,state:window.__desktopResult || 'confirmed',message:'Safe backend result.'};
      }
      if (command.startsWith('plugin_')) window.__pluginCalls.push({command,args});
      if (command === 'plugin_snapshots') return {...cachedPlugins};
      if (command === 'plugin_snapshot') return cachedPlugins[args.pluginId] || emptyPlugin;
      if (command === 'plugin_catalog') { const catalog = {
        directory:'/Users/fixture/.config/zdeck/plugins',
        node:window.__runtimeStatus === 'not_found' ? {status:'not_found',version:null,path:null} : {status:'detected',version:'22.18.0',path:'/detected/node'},
        plugins:window.__pluginsInstalled ? [
          {id:'spotify',name:'spotify',version:'0.1.0',protocolVersion:1,status:'ready',message:null,icon:'data:image/svg+xml;base64,PHN2Zy8+',trusted:window.__trustedPlugins.includes('spotify'),identity:'0123456789abcdef'.repeat(4)},
          {id:'other',name:'other',version:'0.1.0',protocolVersion:1,status:'ready',message:null,icon:null,trusted:window.__trustedPlugins.includes('other'),identity:'0123456789abcdef'.repeat(4)},
          {id:'broken',name:'broken',version:'0.1.0',protocolVersion:1,status:'invalid',message:'The SDK is symlinked, as created by npm source-development installs. Copy the complete generated distribution folder with regular bundled SDK files instead.',icon:null,trusted:false,identity:null},
          {id:'future',name:'future',version:'0.1.0',protocolVersion:2,status:'incompatible',message:'Unsupported protocol.',icon:null,trusted:false,identity:null}
        ].filter(entry => !window.__removedPlugins.includes(entry.id)) : []
      }; if (window.__holdCatalog) await new Promise(resolve => { window.__finishCatalog = resolve; }); return catalog; }
      if (command === 'plugin_open_directory') return null;
      if (command === 'plugin_trust') { if (!/^[a-f0-9]{64}$/.test(args.expectedIdentity)) throw {kind:'unavailable',code:'stale_identity',outcome:'not_started'}; if (!window.__trustedPlugins.includes(args.pluginId)) window.__trustedPlugins.push(args.pluginId); return null; }
      if (command === 'plugin_enable') {
        if (!['spotify','other'].includes(args.pluginId) || Object.keys(args).length !== 1) throw new Error('Invalid enable arguments');
        if (window.__holdEnable === args.pluginId) await new Promise(resolve => { window.__finishEnable = resolve; });
        const manifest = args.pluginId === 'spotify' ? pluginManifest : {id:'other',version:'0.1.0',protocolVersion:1,actions:[{id:'next',title:'Other action',config:{}}]};
        return cachedPlugins[args.pluginId] = {status:'connected', manifest, state:null, lastError:null};
      }
      if (command === 'plugin_disconnect') return cachedPlugins[args.pluginId] = emptyPlugin;
      if (command === 'plugin_diagnostics') return {pluginId:args.pluginId,checks:[{name:'SDK dependency',status:'fail',message:'raw secret source symlink'}]};
      if (command === 'plugin_uninstall') { window.__removedPlugins.push(args.pluginId); delete cachedPlugins[args.pluginId]; return null; }
      if (command === 'plugin_state') return cachedPlugins[args.pluginId] = {...cachedPlugins[args.pluginId], state:{title:'<script>Track</script>', artist:'Artist', playback:'paused', volume:50, secret:'NEVER DISPLAY THIS'}};
      if (command === 'plugin_execute') {
        window.__pluginArgs = args;
        if (window.__failPlugin && args.pluginId === 'spotify') throw {kind:'plugin_failed',code:'outcome_unknown',outcome:'unknown',message:'raw secret',hint:'raw secret'};
        return cachedPlugins[args.pluginId] = {...cachedPlugins[args.pluginId], state:args.actionId === 'power' ? {powered:args.args.enabled} : args.pluginId === 'spotify' ? {title:'Track',artist:'Artist',playback:'playing',volume:args.args.volume} : null};
      }
      if (command === 'remote_status') return status();
      if (command === 'remote_list_devices') return [];
      if (command === 'obs_snapshot') return { connected: false, host: '127.0.0.1', port: 4455, scenes: [], currentScene: null, observedAtMs: Date.now() };
      if (command === 'remote_start') {
        window.__remoteStartOrigins.push(args.origin);
        window.__remoteStartArgs.push(args);
        if (window.__holdRemoteStart) await new Promise(resolve => { window.__finishRemoteStart = resolve; });
        if (window.__failRemoteStart) throw {kind:'invalid_origin',message:'The local service could not be started.'};
        origin = args.origin; mode = args.mode; running = true;
        localStorage.setItem('zdeck.smoke.nativeService', JSON.stringify({enabled:true,origin,mode}));
        return status();
      }
      if (command === 'remote_stop') {
        running = false;
        if (window.__failRemoteStopSave) return {...status(), error:'The service stopped, but its off state could not be saved. It may restart next launch.'};
        localStorage.setItem('zdeck.smoke.nativeService', JSON.stringify({enabled:false,origin,mode}));
        return status();
      }
      if (command === 'remote_create_invitation') {
        const invitation = (++invitationNumber % 2 ? 'a' : 'b').repeat(64);
        return { invitation, url: origin + '/#/pair?invite=' + invitation, expiresAtMs: Date.now() + (invitationNumber === 2 ? 1500 : 60000) };
      }
      throw new Error('Unexpected fake IPC command: ' + command);
    }};
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => {
      if (window.__clipboardFails) throw new Error('Clipboard blocked');
      window.__clipboardText = text;
    } } });
  ` });
  await admin.navigate(`${BASE}/#/settings/phone`);
  check('desktop pairing status distinguishes local service from phone access', await admin.waitFor("document.querySelector('.settings-view')?.textContent.includes('Phone access is not checked.')"));
  check('background HTTPS command is visible outside Connection help', await admin.eval("document.querySelector('.remote-command pre').textContent === 'tailscale serve --bg --https=443 http://127.0.0.1:45829' && !document.querySelector('.remote-help').open && !document.querySelector('.remote-help .remote-command')"));
  const connectionPanelSpacing = "(() => { const panel = document.querySelector('.remote-panel:not([hidden])'), hidden = document.querySelector('.remote-panel[hidden]'); const intro = panel.querySelector(':scope > p').getBoundingClientRect(), steps = panel.querySelector('.remote-steps').getBoundingClientRect(), command = panel.querySelector('.remote-command').getBoundingClientRect(), field = panel.querySelector('.field').getBoundingClientRect(); return steps.top - intro.bottom >= 11.5 && field.top - command.bottom >= 11.5 && getComputedStyle(hidden).display === 'none' && hidden.getBoundingClientRect().height === 0; })()";
  const commandRowVisible = "(() => { const row = document.querySelector('.remote-command-row'), pre = row.querySelector('pre'), button = row.querySelector('button'); const p = pre.getBoundingClientRect(), b = button.getBoundingClientRect(); return button.getAttribute('aria-label') === 'Copy command' && b.width > 0 && b.height > 0 && b.left - p.right >= 7.5 && Math.abs((b.top + b.height / 2) - (p.top + p.height / 2)) <= 1.5 && b.top >= 0 && b.bottom <= innerHeight && b.right <= innerWidth && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('button') === button; })()";
  check('visible connection panel restores 12px intro/field gaps and hidden panel takes no space', await admin.eval(connectionPanelSpacing));
  await admin.eval("document.querySelector('.remote-command-row').scrollIntoView({block:'center'})");
  check('Tailscale copy button is adjacent to the command, visible and not clipped', await admin.eval(commandRowVisible));
  await admin.eval(click('.remote-command button'));
  check('Copy command copies exact background command and announces success', await admin.waitFor("document.querySelector('.remote-command [role=status]')?.textContent === 'Command copied.' && window.__clipboardText === 'tailscale serve --bg --https=443 http://127.0.0.1:45829'"));
  await admin.eval("window.__clipboardFails = true");
  await admin.eval(click('.remote-command button'));
  check('blocked clipboard provides a selectable command and manual-copy fallback', await admin.waitFor("document.querySelector('.remote-command [role=status]')?.textContent.includes('copy it manually') && document.querySelector('.remote-command pre').tabIndex === 0"));
  await admin.eval("window.__clipboardFails = false");
  check('running service hydrates the address without persisting session or pairing data', await admin.eval("document.querySelector('input[type=url]').value === 'https://fixture.tailnet.ts.net' && !localStorage.getItem('deck.remote.origin.v1') && !window.__adminCalls.includes('remote_start')"));
  check('pairing steps are four numbered circles', await admin.eval("(() => { const items = [...document.querySelectorAll('.remote-steps > li')]; return items.length === 4 && items.every((li) => { const mark = getComputedStyle(li, '::before'); return mark.borderRadius === '50%' && mark.content !== 'none' && parseFloat(mark.width) > 0; }); })()"));
  const checkDisclosureGeometry = async () => {
    const measure = "(() => [...document.querySelectorAll('.settings-group:not([hidden]) .disclosure')].map(el => { const range = document.createRange(); range.selectNodeContents(el); const r = el.getBoundingClientRect(), t = range.getBoundingClientRect(); return { left: Math.round(r.left), height: Math.round(r.height), chevron: getComputedStyle(el, '::before').borderRightStyle === 'solid', centered: Math.abs(t.top + t.height / 2 - r.top - r.height / 2) <= 1.5 }; }))()";
    const phone = await admin.eval(measure);
    await admin.eval("location.hash = '#/settings/general'");
    await admin.waitFor("document.querySelector('.settings-nav [aria-current=page]')?.textContent === 'General'");
    const general = await admin.eval(measure);
    await admin.eval("location.hash = '#/settings/phone'");
    await admin.waitFor("document.querySelector('.settings-nav [aria-current=page]')?.textContent === 'Phone connection'");
    const rows = [...phone, ...general];
    return rows.length === 3 && new Set(rows.map(row => row.left)).size === 1 && new Set(rows.map(row => row.height)).size === 1 && rows.every(row => row.chevron && row.centered);
  };
  check('Connection, Storage, and About disclosures share geometry across their sections', await checkDisclosureGeometry());
  check('step text is vertically centered with each number circle', await admin.eval("[...document.querySelectorAll('.remote-steps > li')].every(li => { const text = document.createRange(); text.selectNodeContents(li); const r = li.getBoundingClientRect(), t = text.getBoundingClientRect(); return Math.abs((t.top + t.height / 2) - (r.top + r.height / 2)) <= 1.5; })"));
  await admin.eval("document.querySelector('.remote-help > summary').focus()");
  await pressKey(admin, 'Enter', 'Enter', 13, '\r');
  check('Connection help opens with the keyboard and explains private reachability', await admin.waitFor("document.querySelector('.remote-help')?.open && document.querySelector('.remote-help').textContent.includes('loopback-only')"));
  await admin.eval("document.querySelector('.remote-help > summary').click()");
  await admin.waitFor("!document.querySelector('.remote-help').open");
  await admin.eval("document.querySelector('.remote-steps').scrollIntoView({block:'center'})");
  await admin.screenshot('/tmp/deck-design-pairing-steps.png');
  await admin.eval("document.querySelector('.remote-command-row').scrollIntoView({block:'center'})");
  await admin.screenshot('/tmp/zdeck-settings-tailscale-desktop.png');
  await admin.eval(clickText('.settings-card button', 'Create pairing link'));
  check('desktop pairing creates a local SVG QR', await admin.waitFor("!!document.querySelector('.pairing-qr path')"));
  check('pairing expiry sits directly below the field and above Copy', await admin.eval("(() => { const invite = document.querySelector('.remote-invite'); const field = invite.querySelector('.field').getBoundingClientRect(), expiry = invite.querySelector('.remote-invite-expiry').getBoundingClientRect(), copy = invite.querySelector('button').getBoundingClientRect(); return expiry.top >= field.bottom && copy.top >= expiry.bottom; })()"));
  const originalQr = await admin.eval("document.querySelector('.pairing-qr path').getAttribute('d')");
  await admin.eval(clickText('.remote-invite button', 'Copy link'));
  check('copy feedback does not replace the expiry timestamp', await admin.waitFor("document.querySelector('.remote-invite').textContent.includes('Link copied.') && document.querySelector('.remote-invite-expiry').textContent.includes('Expires at')"));
  await admin.eval("document.querySelector('.remote-invite').scrollIntoView({block:'start'})");
  await admin.screenshot('/tmp/deck-design-pairing.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: false });
  check('pairing instructions and QR fit a narrow screen', await admin.eval("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.pairing-qr').getBoundingClientRect().width >= 180"));
  check('narrow connection panel keeps intro/field spacing and inactive panel stays hidden', await admin.eval(connectionPanelSpacing));
  await admin.eval("document.querySelector('.remote-command-row').scrollIntoView({block:'center'})");
  check('narrow Tailscale command retains an adjacent visible unclipped copy button', await admin.eval(commandRowVisible));
  await admin.screenshot('/tmp/zdeck-settings-tailscale-narrow.png');
  check('narrow disclosures align their arrows and centered labels across sections', await checkDisclosureGeometry());
  await admin.screenshot('/tmp/deck-design-pairing-narrow.png');
  await admin.eval(clickText('.settings-card button', 'Replace pairing link'));
  check('replacement invitation replaces the QR', await admin.waitFor(`document.querySelector('.pairing-qr path')?.getAttribute('d') !== ${JSON.stringify(originalQr)}`));
  check('expiry removes both the pairing link and QR', await admin.waitFor("!document.querySelector('.remote-invite, .pairing-qr')", 5000));
  await admin.eval(clickText('.settings-card button', 'Create pairing link'));
  await admin.waitFor("!!document.querySelector('.pairing-qr')");
  await admin.eval(clickText('.settings-card button', 'Stop local service'));
  check('stop removes invitation and QR immediately', await admin.waitFor("!document.querySelector('.remote-invite, .pairing-qr') && document.querySelector('.settings-view').textContent.includes('Local service stopped.')"));
  check('stopping preserves the running address as an editable restart fallback', await admin.eval("document.querySelector('input[type=url]').value === 'https://fixture.tailnet.ts.net' && !document.querySelector('input[type=url]').disabled"));
  await admin.eval(setValue('input[type=url]', 'https://new.tailnet.ts.net/?token=do-not-save'));
  check('pairing/query URLs cannot start or overwrite the saved origin', await admin.eval("[...document.querySelectorAll('.settings-actions button')].find(el => el.textContent.includes('Start local service')).disabled && !localStorage.getItem('deck.remote.origin.v1')"));
  await admin.eval(setValue('input[type=url]', 'https://NEW.tailnet.ts.net:443/'));
  await admin.eval("window.__failRemoteStart = true");
  await admin.eval(clickText('.settings-actions button', 'Start local service'));
  check('failed service start does not save the URL draft', await admin.waitFor("window.__remoteStartOrigins.length === 1 && !!document.querySelector('[aria-labelledby=remote-heading] .settings-error')") && await admin.eval("!localStorage.getItem('deck.remote.origin.v1')"));
  await admin.eval("window.__failRemoteStart = false");
  await admin.eval(clickText('.settings-actions button', 'Start local service'));
  check('successful start stores only the normalized non-secret origin', await admin.waitFor("localStorage.getItem('deck.remote.origin.v1') === 'https://new.tailnet.ts.net'") && await admin.eval("window.__remoteStartOrigins.every(origin => origin === 'https://new.tailnet.ts.net') && !JSON.stringify(localStorage).includes('do-not-save') && !JSON.stringify(localStorage).includes('invite')"));
  await admin.eval(clickText('.settings-actions button', 'Stop local service'));
  await admin.waitFor("document.querySelector('.settings-view').textContent.includes('Local service stopped.')");
  await admin.eval(setValue('input[type=url]', 'https://draft.tailnet.ts.net'));
  const pollsBeforeDraft = await admin.eval("window.__adminCalls.filter(c => c === 'remote_status').length");
  await admin.eval("window.__remoteCard = document.querySelector('[aria-labelledby=remote-heading]'); location.hash = '#/settings/integrations'");
  await admin.waitFor("document.querySelector('.settings-nav [aria-current=page]')?.textContent === 'Integrations'");
  await admin.eval("location.hash = '#/settings/phone'");
  check('switching Settings sections preserves the phone form and mounted card', await admin.waitFor("document.querySelector('.settings-nav [aria-current=page]')?.textContent === 'Phone connection'") && await admin.eval("window.__remoteCard === document.querySelector('[aria-labelledby=remote-heading]') && document.querySelector('input[type=url]').value === 'https://draft.tailnet.ts.net'"));
  check('background service polls do not clobber an edited URL draft', await admin.waitFor(`window.__adminCalls.filter(c => c === 'remote_status').length > ${pollsBeforeDraft}`) && await admin.eval("document.querySelector('input[type=url]').value === 'https://draft.tailnet.ts.net' && localStorage.getItem('deck.remote.origin.v1') === 'https://new.tailnet.ts.net'"));
  await admin.eval("document.getElementById('remote-tab-tailscale').focus()");
  await pressKey(admin, 'ArrowRight', 'ArrowRight', 39);
  check('connection tabs support arrow-key activation, focus and linked panels', await admin.waitFor("document.activeElement.id === 'remote-tab-local_https' && document.activeElement.getAttribute('aria-selected') === 'true' && !document.getElementById(document.activeElement.getAttribute('aria-controls')).hidden") && await admin.eval("document.querySelector('input[type=url]').placeholder === 'https://192.168.1.20:8443'"));
  await pressKey(admin, 'Home', 'Home', 36);
  check('Home selects Tailscale and preserves its unsaved draft', await admin.waitFor("document.activeElement.id === 'remote-tab-tailscale' && document.querySelector('input[type=url]').value === 'https://draft.tailnet.ts.net'"));
  await pressKey(admin, 'End', 'End', 35);
  await admin.waitFor("document.activeElement.id === 'remote-tab-local_https'");
  await admin.eval(setValue('input[type=url]', 'https://192.168.1.20:8443/#/pair?invite=local-secret'));
  check('local pairing URLs cannot start or persist secrets', await admin.eval("[...document.querySelectorAll('.settings-actions button')].find(el => el.textContent.includes('Start local service')).disabled && !localStorage.getItem('deck.remote.local-origin.v1')"));
  await admin.eval(setValue('input[type=url]', 'https://192.168.1.20:8443/'));
  await admin.eval("window.__failRemoteStart = true");
  await admin.eval(clickText('.settings-actions button', 'Start local service'));
  check('failed local start does not overwrite per-mode origin', await admin.waitFor("!!document.querySelector('[aria-labelledby=remote-heading] .settings-error')") && await admin.eval("!localStorage.getItem('deck.remote.local-origin.v1')"));
  await admin.eval("window.__failRemoteStart = false; window.__holdRemoteStart = true");
  await admin.eval(clickText('.settings-actions button', 'Start local service'));
  check('busy connection operations disable tab switching', await admin.waitFor("!!window.__finishRemoteStart && [...document.querySelectorAll('[role=tab]')].every(tab => tab.disabled)"));
  await admin.eval("window.__holdRemoteStart = false; window.__finishRemoteStart()");
  check('local start forwards canonical origin and mode, saves separately and disables running tabs', await admin.waitFor("localStorage.getItem('deck.remote.local-origin.v1') === 'https://192.168.1.20:8443'") && await admin.eval("window.__remoteStartArgs.at(-1).mode === 'local_https' && window.__remoteStartArgs.at(-1).origin === 'https://192.168.1.20:8443' && localStorage.getItem('deck.remote.origin.v1') === 'https://new.tailnet.ts.net' && [...document.querySelectorAll('[role=tab]')].every(tab => tab.disabled) && document.getElementById('remote-mode-note').textContent.includes('Stop the local service')"));
  await admin.eval("document.getElementById('remote-tab-tailscale').click()");
  check('running service cannot be switched to another mode', await admin.eval("document.getElementById('remote-tab-local_https').getAttribute('aria-selected') === 'true'"));
  await admin.eval(click('.remote-help > summary'));
  check('local help explains informed CA trust, proxy boundary and network policy', await admin.eval("document.querySelector('.remote-help').textContent.includes('rootCA-key.pem') && document.querySelector('.remote-help').textContent.includes('full trust') && document.querySelector('.remote-help').textContent.includes('reverse_proxy 127.0.0.1:45829') && document.querySelector('.remote-help').textContent.includes('administrator') && !document.querySelector('.remote-command')"));
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  check('local help and certificate/proxy examples fit a narrow viewport', await admin.eval("document.documentElement.scrollWidth <= innerWidth"));
  await admin.eval("document.getElementById('remote-heading').scrollIntoView()");
  await admin.screenshot('/tmp/zdeck-local-https-help.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await admin.eval(clickText('.settings-actions button', 'Create pairing link'));
  check('local pairing uses its exact HTTPS origin', await admin.waitFor("document.querySelector('.remote-invite input')?.value.startsWith('https://192.168.1.20:8443/#/pair?invite=')"));
  await admin.eval(clickText('.settings-actions button', 'Stop local service'));
  await admin.waitFor("!document.querySelector('input[type=url]').disabled");
  await admin.eval(setValue('input[type=url]', 'https://unsaved.lan:8443'));
  await admin.eval(click('#remote-tab-tailscale'));
  check('switching modes preserves the tailnet draft without persisting it', await admin.waitFor("document.querySelector('input[type=url]').value === 'https://draft.tailnet.ts.net'"));
  await admin.eval(click('#remote-tab-local_https'));
  check('switching back restores the local draft but storage contains only successful origins and mode', await admin.waitFor("document.querySelector('input[type=url]').value === 'https://unsaved.lan:8443'") && await admin.eval("localStorage.getItem('deck.remote.mode.v1') === 'local_https' && localStorage.getItem('deck.remote.local-origin.v1') === 'https://192.168.1.20:8443' && !JSON.stringify(localStorage).includes('local-secret') && !JSON.stringify(localStorage).includes('invite')"));
  await admin.eval("location.hash = '#/'"); await admin.waitFor("!!document.querySelector('.deck-grid')");
  await admin.eval("location.hash = '#/settings/phone'");
  check('Settings remount restores selected Local HTTPS and its successful address, not the draft', await admin.waitFor("document.getElementById('remote-tab-local_https')?.getAttribute('aria-selected') === 'true' && document.querySelector('input[type=url]').value === 'https://192.168.1.20:8443'"));
  await admin.send('Page.reload', { ignoreCache: true });
  check('restart restores local mode and origin without starting any service', await admin.waitFor("document.getElementById('remote-tab-local_https')?.getAttribute('aria-selected') === 'true' && document.querySelector('input[type=url]')?.value === 'https://192.168.1.20:8443' && document.querySelector('.settings-view').textContent.includes('Local service stopped.')") && await admin.eval("!window.__adminCalls.includes('remote_start')"));
  await admin.eval(click('#remote-tab-tailscale'));
  await admin.eval("location.hash = '#/'");
  await admin.waitFor("!!document.querySelector('.workspace')");
  await admin.eval("location.hash = '#/settings/phone'");
  check('Settings remount restores the last successful address, not its unsaved draft', await admin.waitFor("document.querySelector('input[type=url]')?.value === 'https://new.tailnet.ts.net' && document.querySelector('.settings-view').textContent.includes('Local service stopped.')"));
  await admin.reload();
  check('program-session reload remembers the address without auto-starting service', await admin.waitFor("document.querySelector('input[type=url]')?.value === 'https://new.tailnet.ts.net' && document.querySelector('.settings-view').textContent.includes('Local service stopped.')") && await admin.eval("!window.__adminCalls.includes('remote_start')"));
  await admin.waitFor("[...document.querySelectorAll('.settings-actions button')].some(button => button.textContent.includes('Start local service') && !button.disabled)");
  await admin.eval(clickText('.settings-actions button', 'Start local service'));
  check('explicit start reaches native persistence without browser desired-state storage', await admin.waitFor("JSON.parse(localStorage.getItem('zdeck.smoke.nativeService'))?.enabled === true") && await admin.eval("!localStorage.getItem('deck.remote.desired.v1')"));
  await admin.eval("location.hash='#/'");
  await admin.waitFor("!!document.querySelector('.workspace')");
  check('leaving Settings does not stop the service or overwrite native desired on', await admin.eval("JSON.parse(localStorage.getItem('zdeck.smoke.nativeService')).enabled === true"));
  await admin.reload();
  check('relaunch reads native service state outside Settings without a browser start request', await admin.waitFor("window.__adminCalls.includes('remote_status') && !!document.querySelector('.workspace')") && await admin.eval("window.__remoteStartArgs.length === 0 && JSON.parse(localStorage.getItem('zdeck.smoke.nativeService')).enabled === true"));
  await admin.eval("location.hash='#/settings/phone'");
  await admin.waitFor("document.querySelector('.settings-view')?.textContent.includes('Local service running')");
  await admin.eval("window.__failRemoteStopSave = true");
  await admin.eval(clickText('.settings-actions button', 'Stop local service'));
  check('failed off-state persistence accurately warns that the service may restart', await admin.waitFor("document.querySelector('[aria-labelledby=remote-heading] .settings-error')?.textContent.includes('off state could not be saved')"));
  await admin.eval("window.__failRemoteStopSave = false");
  await admin.eval(clickText('.settings-actions button', 'Start local service'));
  await admin.waitFor("document.querySelector('.settings-view')?.textContent.includes('Local service running')");
  await admin.eval(clickText('.settings-actions button', 'Stop local service'));
  check('deliberate stop persists native desired off', await admin.waitFor("JSON.parse(localStorage.getItem('zdeck.smoke.nativeService'))?.enabled === false"));
  await admin.reload();
  check('application relaunch honors desired off', await admin.waitFor("document.querySelector('.settings-view')?.textContent.includes('Local service stopped.')") && await admin.eval("window.__remoteStartArgs.length === 0"));
  check('pairing presentation never requests native action execution', await admin.eval("window.__adminCalls.every(command => command === 'native_deck_load' || ['desktop_close_to_tray','desktop_tray_notice'].includes(command) || command === 'plugin_snapshots' || command === 'plugin_catalog' || command === 'obs_snapshot' || command === 'obs_load_preferences' || /^system_(output|microphone|media)_snapshot$/.test(command) || command.startsWith('remote_'))"), await admin.eval("[...new Set(window.__adminCalls)].join(', ')"));
  await admin.eval("location.hash = '#/settings/general'");
  await admin.waitFor("!document.querySelector('[aria-label=General][role=region]').hidden");
  check('close-to-tray defaults off', await admin.eval("!document.querySelector('[aria-describedby=close-to-tray-help]').checked"));
  await admin.screenshot('/tmp/zdeck-settings-general-desktop.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: false });
  check('General navigation and native preference fit a narrow screen', await admin.eval("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.settings-nav a')].every(el => el.getBoundingClientRect().width > 0)"));
  await admin.screenshot('/tmp/zdeck-settings-general-narrow.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  await admin.eval(click('[aria-describedby=close-to-tray-help]'));
  check('native close preference is only enabled after successful persistence', await admin.waitFor("document.querySelector('[aria-describedby=close-to-tray-help]').checked && !document.querySelector('[aria-describedby=close-to-tray-help]').disabled"));
  await admin.eval("window.__failPreferenceSave = true");
  await admin.eval(click('[aria-describedby=close-to-tray-help]'));
  check('failed preference save keeps the last confirmed value and shows error', await admin.waitFor("document.querySelector('[aria-describedby=close-to-tray-help]').checked && document.querySelector('[aria-labelledby=desktop-preferences-heading] [role=alert]')?.textContent.includes('Preference was not saved')"));
  await admin.eval("location.hash = '#/settings/integrations'");
  await admin.waitFor("!document.querySelector('[aria-label=Integrations][role=region]').hidden");
  // ------------------------------------------------------------ plugin UI (owned IPC fake, never osascript)
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  check('plugin mount only requests catalog and cached metadata', await admin.eval("window.__adminCalls.filter(c => c.startsWith('plugin_')).every(c => ['plugin_snapshots','plugin_catalog'].includes(c))"));
  check('plugin settings detects Node and explains empty installation without path inputs', await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Detected Node 22.18.0') && document.querySelector('.plugin-settings').textContent.includes('Nothing installed yet')") && await admin.eval("!document.querySelector('.plugin-settings input[type=text]')"));
  await admin.eval(clickText('.plugin-settings button', 'Open plugin folder'));
  check('Open plugin folder invokes only the fixed native opener command', await admin.waitFor("window.__adminCalls.includes('plugin_open_directory')"));
  await admin.eval("window.__pluginsInstalled = true");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  const row = (id) => `.plugin-row[data-plugin-id="${id}"]`;
  check('refresh discovers inset plugin rows without a selection dropdown', await admin.waitFor("document.querySelectorAll('.plugin-row').length === 4 && !document.querySelector('.plugin-settings select')"));
  await admin.eval(click(`${row('spotify')} .plugin-row-actions > button`));
  check('requesting Enable opens an accessible trust dialog without launching', await admin.waitFor("!!document.querySelector('[data-plugin-id=spotify] dialog')?.open") && await admin.eval("document.querySelector('[data-plugin-id=spotify] dialog').textContent.includes('Trust and enable') && document.querySelector('[data-plugin-id=spotify] dialog').textContent.includes('not a sandbox') && !window.__adminCalls.includes('plugin_enable')"));
  await admin.eval(clickText(`${row('spotify')} dialog button`, 'Cancel'));
  check('cancel dismisses trust without trusting or enabling', await admin.waitFor("!document.querySelector('[data-plugin-id=spotify] dialog')?.open") && await admin.eval("!window.__adminCalls.includes('plugin_enable') && !window.__adminCalls.includes('plugin_trust')"));
  await admin.eval("window.__runtimeStatus = 'not_found'");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Node not found')");
  check('missing runtime disables row Enable', await admin.eval("document.querySelector('[data-plugin-id=spotify] .plugin-row-actions > button').disabled"));
  await admin.eval("window.__runtimeStatus = 'detected'");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Detected Node 22.18.0')");
  await admin.eval("window.__holdEnable = 'spotify'");
  await admin.eval(click(`${row('spotify')} .plugin-row-actions > button`));
  await admin.eval(clickText(`${row('spotify')} dialog button`, 'Trust and enable'));
  check('one pending plugin does not disable another row', await admin.waitFor("!!window.__finishEnable") && await admin.eval("document.querySelector('[data-plugin-id=spotify] .plugin-row-actions > button').disabled && !document.querySelector('[data-plugin-id=other] .plugin-row-actions > button').disabled"));
  await admin.eval(click(`${row('other')} .plugin-row-actions > button`));
  await admin.eval(clickText(`${row('other')} dialog button`, 'Trust and enable'));
  await admin.waitFor("document.querySelector('[data-plugin-id=other] .plugin-row-actions > button').textContent === 'Disable'");
  await admin.eval("window.__holdEnable = null; window.__finishEnable()");
  check('two plugins enable independently with no automatic state read or execute', await admin.waitFor("document.querySelector('[data-plugin-id=spotify] .plugin-row-actions > button').textContent === 'Disable'") && await admin.eval("!window.__adminCalls.includes('plugin_state') && !window.__adminCalls.includes('plugin_execute') && window.__pluginCalls.filter(c=>c.command==='plugin_enable').map(c=>c.args.pluginId).sort().join(',')==='other,spotify'"));
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  check('catalog refresh preserves both enabled sessions', await admin.waitFor("!document.querySelector('.plugin-settings .settings-actions button').disabled") && await admin.eval("[...document.querySelectorAll('.plugin-row-actions > button')].filter(b=>b.textContent==='Disable').length===2"));
  await admin.eval("document.querySelector('[data-plugin-id=broken] .plugin-menu summary').focus()");
  await pressKey(admin, 'Enter', 'Enter', 13, '\r');
  check('invalid SDK row has a keyboard-accessible diagnostics menu', await admin.waitFor("document.querySelector('[data-plugin-id=broken] .plugin-menu').open"));
  await admin.eval(clickText(`${row('broken')} button`, 'Diagnostics'));
  check('diagnostics are safe, per-row, and never launch/read/execute plugin code', await admin.waitFor("!!document.querySelector('[data-plugin-id=broken] .plugin-diagnostics')") && await admin.eval("document.querySelector('[data-plugin-id=broken]').textContent.includes('complete packaged folder') && !document.querySelector('[data-plugin-id=broken]').textContent.includes('raw secret') && !window.__adminCalls.includes('plugin_state') && !window.__adminCalls.includes('plugin_execute')"));
  await admin.eval(click(`${row('broken')} .plugin-menu summary`));
  await admin.eval(clickText(`${row('broken')} button`, 'Uninstall…'));
  check('uninstall requires confirmation and explains recoverable backup', await admin.waitFor("document.querySelector('[data-plugin-id=broken] .plugin-confirm')?.textContent.includes('plugin-backups')") && await admin.eval("!window.__adminCalls.includes('plugin_uninstall')"));
  await admin.eval(clickText(`${row('broken')} button`, 'Cancel'));
  check('cancelling uninstall sends no request', await admin.eval("!window.__adminCalls.includes('plugin_uninstall')"));
  await admin.eval("window.__holdCatalog = true");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  await admin.waitFor("!!window.__finishCatalog");
  await admin.eval(click(`${row('broken')} .plugin-menu summary`));
  await admin.eval(clickText(`${row('broken')} button`, 'Uninstall…'));
  await admin.eval(clickText(`${row('broken')} button`, 'Confirm uninstall'));
  check('confirmed fake uninstall removes only its row and preserves enabled plugins', await admin.waitFor("!document.querySelector('[data-plugin-id=broken]')") && await admin.eval("window.__removedPlugins.join(',')==='broken' && [...document.querySelectorAll('.plugin-row-actions > button')].filter(b=>b.textContent==='Disable').length===2"));
  await admin.eval("window.__holdCatalog = false; window.__finishCatalog()");
  check('a stale catalog refresh cannot resurrect an uninstalled row', await admin.waitFor("!document.querySelector('.plugin-settings .settings-actions button').disabled") && await admin.eval("!document.querySelector('[data-plugin-id=broken]')"));
  await admin.eval("document.querySelector('.plugin-settings').scrollIntoView({block:'start'})");
  await admin.screenshot('/tmp/zdeck-plugin-list-desktop.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await admin.eval("document.querySelector('.plugin-list').scrollIntoView({block:'start'})");
  await admin.screenshot('/tmp/zdeck-plugin-list-narrow.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  await admin.eval(click(`${row('spotify')} .plugin-state summary`));
  await admin.eval(clickText(`${row('spotify')} button`, 'Read state'));
  check('explicit Read state displays only bounded supported text', await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('<script>Track</script>')") && await admin.eval("!document.querySelector('.plugin-settings script') && !document.querySelector('.plugin-settings').textContent.includes('NEVER DISPLAY THIS') && document.querySelector('.plugin-settings').textContent.includes('not live')"));
  await admin.eval("document.querySelector('.plugin-settings').scrollIntoView({block:'start'})");
  await admin.screenshot('/tmp/deck-plugin-settings.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: false });
  await admin.eval("document.querySelector('.plugin-locations').open = true");
  check('plugin folder and read-only runtime details fit a narrow screen', await admin.eval("document.documentElement.scrollWidth <= innerWidth && !document.querySelector('.plugin-settings input[type=text]')"));
  await admin.screenshot('/tmp/deck-plugin-folder-narrow.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  await admin.eval("location.hash = '#/'");
  await admin.waitFor("!!document.querySelector('.add-control')");
  await admin.eval(click('.control-tile[data-action="mic-mute"] button'));
  await admin.eval(click('.icon-picker:not(.action-picker) > summary'));
  await admin.eval(click('[aria-label="spotify / Media: Media badge"]'));
  check('a plugin icon can decorate an unrelated built-in action', await admin.waitFor("document.querySelector('.control-tile.is-selected[data-action=mic-mute] img')?.naturalWidth > 0"));
  await admin.eval(click('.add-control'));
  check('all enabled manifests appear in the action library as escaped text', await admin.waitFor("[...document.querySelectorAll('.action-row-name')].some(el => el.textContent === 'Spotify <volume>') && [...document.querySelectorAll('.action-row-name')].some(el => el.textContent === 'Other action')") && await admin.eval("!document.querySelector('.action-library volume')"));
  await admin.eval(clickText('.action-row', 'Spotify <volume>'));
  await admin.waitFor("!!document.querySelector('.inspector-form .native-control input[type=number]')");
  await admin.eval(click('.icon-picker:not(.action-picker) > summary'));
  check('plugin icons grouped by plugin and category', await admin.waitFor("[...document.querySelectorAll('.icon-picker legend')].some(el => el.textContent === 'spotify / Media') && [...document.querySelectorAll('.icon-picker legend')].some(el => el.textContent === 'spotify / Brand')"));
  await admin.eval(click('[aria-label="spotify / Brand: Logo"]'));
  check('plugin PNG decodes on the control', await admin.waitFor("document.querySelector('.control-tile.is-selected img')?.naturalWidth === 32"));
  await admin.eval(click('[aria-label="spotify / General: Unreadable"]'));
  check('unreadable images fall back to the action icon', await admin.waitFor("!!document.querySelector('.control-tile.is-selected .lucide-plug') && !document.querySelector('.control-tile.is-selected img')"));
  await admin.eval(click('[aria-label="spotify / Media: Media badge"]'));
  check('plugin SVG decodes as an image without injecting scripts', await admin.waitFor("document.querySelector('.control-tile.is-selected img')?.naturalWidth > 0") && await admin.eval("!window.__iconScriptRan && !document.querySelector('.icon-picker script')"));
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: false });
  check('icon picker fits a narrow screen', await admin.eval("document.documentElement.scrollWidth <= innerWidth"));
  await admin.eval("document.querySelector('.icon-picker').scrollIntoView({block:'start'})");
  await admin.screenshot('/tmp/zdeck-custom-icons-plugin-narrow.png');
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  check('plugin uses a configured button with sensible volume default', await admin.eval("document.querySelector('.inspector-form .native-control input').value === '50' && document.querySelectorAll('.control-tile[data-action=plugin] input[type=range]').length === 0"));
  await admin.eval(setValue('.inspector-form .native-control input', '101'));
  check('invalid plugin bounds disable Run', await admin.eval("document.querySelector('.inspector-form .native-control .button.primary').disabled"));
  await admin.eval(setValue('.inspector-form .native-control input', ''));
  check('empty unsaved plugin draft disables Run', await admin.eval("document.querySelector('.inspector-form .native-control .button.primary').disabled"));
  await admin.eval(setValue('.inspector-form .native-control input', '75'));
  await admin.eval(clickText('.native-control button', 'Run plugin action'));
  check('Inspector Run maps saved generic plugin arguments', await admin.waitFor("window.__pluginArgs?.args.volume === 75") && await admin.eval("window.__pluginArgs.pluginId === 'spotify' && window.__pluginArgs.actionId === 'set-volume'"));
  // Declared controls: actual keyboard/pointer gestures, fake IPC only.
  await admin.eval(click('.add-control'));
  await admin.waitFor("!!document.querySelector('.action-row')");
  await admin.eval(clickText('.action-row', 'Generic level'));
  await admin.waitFor("!!document.querySelector('.control-tile.is-selected input[type=range]')");
  check('new generic numeric actions default to sliders with declared bounds', await admin.eval("(() => { const input = document.querySelector('.control-tile.is-selected input'); return input.min === '-20' && input.max === '200' && input.step === '5'; })()"));
  await admin.waitFor("!document.querySelectorAll('.desktop-mode button')[1].disabled");
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  await admin.eval("window.__holdDesktop = true; document.querySelector('.control-tile.is-selected input').focus()");
  await pressKey(admin, 'End', 'End', 35);
  await admin.waitFor("window.__desktopCalls.length === 1");
  await pressKey(admin, 'Home', 'Home', 36);
  check('busy slider stays adjustable and queues the final deliberate target', await admin.eval("!document.querySelector('.control-tile.is-selected input').disabled && window.__desktopCalls.length === 1"));
  await admin.eval("window.__holdDesktop = false; window.__finishDesktop()");
  check('generic slider delivers latest target after confirmation with a new command ID', await admin.waitFor("window.__desktopCalls.length === 2 && window.__desktopCalls[1].value === -20") && await admin.eval("window.__desktopCalls[0].value === 200 && window.__desktopCalls[0].commandId !== window.__desktopCalls[1].commandId"));
  await admin.waitFor("!document.querySelector('.control-tile.is-selected').hasAttribute('aria-busy')");
  await admin.eval("document.querySelector('.control-tile.is-selected input').scrollIntoView({block:'center'}); window.__holdDesktop = true");
  const liveSlider = await admin.eval(rectOf('.control-tile.is-selected input'));
  await admin.send('Input.dispatchMouseEvent', {type:'mousePressed',x:liveSlider.left+10,y:liveSlider.cy,button:'left',clickCount:1});
  await admin.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:liveSlider.cx,y:liveSlider.cy,button:'left',buttons:1});
  check('live slider pointer movement sends before pointerup', await admin.waitFor('window.__desktopCalls.length === 3'));
  await admin.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:liveSlider.right-10,y:liveSlider.cy,button:'left',buttons:1});
  const pointerFinal = await admin.eval("Number(document.querySelector('.control-tile.is-selected input').value)");
  await admin.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:liveSlider.right-10,y:liveSlider.cy,button:'left',clickCount:1});
  await admin.eval('window.__holdDesktop = false; window.__finishDesktop()');
  check('busy pointer slider coalesces movement and release into the final target', await admin.waitFor(`window.__desktopCalls.length === 4 && window.__desktopCalls.at(-1).value === ${pointerFinal}`));
  await admin.waitFor("!document.querySelector('.control-tile.is-selected').hasAttribute('aria-busy')");
  await admin.eval(clickText('.desktop-mode button', 'Preview'));
  await admin.eval("[...document.querySelectorAll('.inspector-form label')].find(l => l.querySelector('span')?.textContent === 'Presentation').querySelector('select').value = 'dial'; [...document.querySelectorAll('.inspector-form label')].find(l => l.querySelector('span')?.textContent === 'Presentation').querySelector('select').dispatchEvent(new Event('change',{bubbles:true}))");
  await admin.waitFor("!!document.querySelector('.control-tile.is-selected .dial-face')");
  await admin.eval("document.querySelector('.control-tile.is-selected .dial-face').focus()");
  await pressKey(admin, 'End', 'End', 35);
  check('dial keyboard exposes the declared maximum and value', await admin.eval("document.querySelector('.control-tile.is-selected [role=slider]').getAttribute('aria-valuenow') === '200'"));
  await admin.waitFor("!document.querySelectorAll('.desktop-mode button')[1].disabled");
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  await admin.eval("document.querySelector('.control-tile.is-selected .dial-face').focus()");
  await admin.send('Input.dispatchKeyEvent', {type:'rawKeyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36,nativeVirtualKeyCode:36});
  check('live dial keyboard sends before keyup', await admin.waitFor('window.__desktopCalls.length === 5 && window.__desktopCalls.at(-1).value === -20'));
  await pressKey(admin, 'Escape', 'Escape', 27);
  await admin.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36,nativeVirtualKeyCode:36});
  check('Escape cancels a live dial gesture without an extra dispatch', await admin.eval("window.__desktopCalls.length === 5"));
  await admin.eval("document.querySelector('.control-tile.is-selected .dial-face').scrollIntoView({block:'center'})");
  const liveDial = await admin.eval(rectOf('.control-tile.is-selected .dial-face'));
  await admin.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:liveDial.cx,y:liveDial.cy}]});
  await admin.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:liveDial.cx,y:liveDial.cy-40}]});
  check('live dial touch movement sends before release', await admin.waitFor('window.__desktopCalls.length === 6 && window.__desktopCalls.at(-1).value > -20'));
  await admin.send('Input.dispatchTouchEvent', {type:'touchCancel',touchPoints:[]});
  check('dial touch cancellation sends no extra target', await admin.eval('window.__desktopCalls.length === 6'));
  await admin.eval(clickText('.desktop-mode button', 'Preview'));
  await admin.eval("document.querySelector('.control-tile.is-selected .dial-face').focus()");
  await pressKey(admin, 'End', 'End', 35);
  await admin.eval("document.querySelector('.control-tile.is-selected .dial-face').scrollIntoView({block:'center'})");
  const dial = await admin.eval(rectOf('.control-tile.is-selected .dial-face'));
  await admin.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:dial.cx,y:dial.cy}]});
  await admin.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:dial.cx,y:dial.cy+50}]});
  await admin.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
  check('dial supports touch without native execution in Preview', await admin.eval("Number(document.querySelector('.control-tile.is-selected [role=slider]').getAttribute('aria-valuenow')) < 200 && window.__desktopCalls.length === 6"));
  await admin.eval(click('.add-control')); await admin.waitFor("!!document.querySelector('.action-row')");
  await admin.eval(clickText('.action-row', 'Generic power'));
  await admin.waitFor("document.querySelector('.inspector-form .native-control select')?.value === 'false'");
  await admin.eval("{ const select = [...document.querySelectorAll('.inspector-form label')].find(l => l.querySelector('span')?.textContent === 'Presentation').querySelector('select'); select.value='toggle-switch'; select.dispatchEvent(new Event('change',{bubbles:true})); }");
  await admin.waitFor("!document.querySelectorAll('.desktop-mode button')[1].disabled");
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  check('live unknown toggle is disabled without claiming Off', await admin.eval("document.querySelector('.control-tile.is-selected .tile-toggle').disabled && !document.querySelector('.control-tile.is-selected .tile-toggle').hasAttribute('aria-checked') && document.querySelector('.control-tile.is-selected .tile-toggle').textContent.includes('State unknown')"));
  await admin.eval(clickText('.desktop-mode button', 'Preview'));
  await admin.eval(clickText('.native-control button', 'Run plugin action'));
  await admin.waitFor("document.querySelector('.control-tile.is-selected [role=switch]')?.getAttribute('aria-checked') === 'false'");
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  await admin.eval("window.__holdDesktop = true; document.querySelector('.control-tile.is-selected [role=switch]').focus()");
  await pressKey(admin, ' ', 'Space', 32, ' ');
  check('busy switch preserves focus and blocks a second activation', await admin.waitFor("document.querySelector('.control-tile.is-selected [role=switch]')?.getAttribute('aria-disabled') === 'true'") && await admin.eval("(() => { const toggle = document.querySelector('.control-tile.is-selected [role=switch]'); toggle.click(); return document.activeElement === toggle && window.__desktopCalls.length === 7; })()"));
  await admin.eval("window.__holdDesktop = false; window.__finishDesktop()");
  check('switch keyboard sends explicit On and reads observed state', await admin.waitFor("document.querySelector('.control-tile.is-selected [role=switch]')?.getAttribute('aria-checked') === 'true'") && await admin.eval("window.__desktopCalls.at(-1).value === 1"));
  check('switch keeps a visible keyboard focus indicator', await admin.eval("getComputedStyle(document.querySelector('.control-tile.is-selected [role=switch]')).outlineStyle !== 'none'"));
  await admin.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  check('switch respects reduced motion', await admin.eval("parseFloat(getComputedStyle(document.querySelector('.control-tile.is-selected .toggle-track span')).transitionDuration) <= .001"));
  await admin.send('Emulation.setEmulatedMedia', {features:[]});
  await admin.eval(clickText('.desktop-mode button', 'Preview'));
  await admin.eval("{ const select = [...document.querySelectorAll('.inspector-form label')].find(l => l.querySelector('span')?.textContent === 'Presentation').querySelector('select'); select.value='toggle-button'; select.dispatchEvent(new Event('change',{bubbles:true})); }");
  check('toggle button exposes observed pressed state', await admin.waitFor("document.querySelector('.control-tile.is-selected .tile-toggle')?.getAttribute('aria-pressed') === 'true'"));
  check('all presentations stay within their configured key height', await admin.eval("[...document.querySelectorAll('.control-tile')].every(tile => [...tile.children].filter(child => !child.matches('.tile-order')).every(child => child.getBoundingClientRect().bottom <= tile.getBoundingClientRect().bottom + 1))"));
  await admin.screenshot('/tmp/zdeck-control-presentations.png');
  await admin.eval("window.__desktopCalls = []");
  await admin.eval(clickText('.control-tile .tile-primary', 'Spotify <volume>'));
  const executions = await admin.eval("window.__adminCalls.filter(c => c === 'plugin_execute').length");
  await admin.eval(click('[aria-label="Open phone preview"]'));
  await admin.waitFor("!!document.querySelector('.phone-shell .control-tile[data-action=plugin]')");
  await admin.eval(click('.phone-shell .control-tile[data-action=plugin] button'));
  check('phone preview renders the saved SVG', await admin.waitFor("document.querySelector('.phone-shell .control-tile[data-action=plugin] img')?.naturalWidth > 0"));
  check('phone preview simulates the plugin without native execution', await admin.eval(`window.__adminCalls.filter(c => c === 'plugin_execute').length === ${executions} && document.querySelector('.phone-shell').textContent.includes('Preview only')`));
  await admin.eval("location.hash = '#/'");
  await admin.waitFor("!!document.querySelector('.inspector-form .native-control')");
  await admin.eval("window.__failPlugin = true");
  await admin.eval(clickText('.native-control button', 'Run plugin action'));
  check('unknown outcome is sanitized, warns, disables Run and requires explicit reconnect', await admin.waitFor("document.querySelector('.inspector-form').textContent.includes('Outcome unknown')") && await admin.eval("document.querySelector('.native-control .button.primary').disabled && !document.querySelector('.inspector-form').textContent.includes('raw secret')"));
  await admin.eval("location.hash = '#/settings/integrations'");
  await admin.waitFor("!!document.querySelector('.plugin-settings')");
  check('one failed plugin does not overwrite its healthy neighbor or expose raw trust fields', await admin.eval("!document.querySelector('.plugin-settings input[type=text]') && !document.querySelector('.plugin-settings input[type=checkbox]') && document.querySelector('[data-plugin-id=other] .plugin-row-actions > button').textContent==='Disable' && !document.querySelector('[data-plugin-id=other]').textContent.includes('Outcome unknown') && !JSON.stringify(localStorage).includes('/detected/node')"));
  await admin.eval("window.__trustCallsBefore = window.__pluginCalls.filter(c=>c.command==='plugin_trust').length");
  await admin.eval(click(`${row('spotify')} .plugin-row-actions > button`));
  check('re-enabling a trusted, unchanged package does not repeat confirmation', await admin.waitFor("document.querySelector('[data-plugin-id=spotify] .plugin-row-actions > button').textContent==='Disable'") && await admin.eval("!document.querySelector('[data-plugin-id=spotify] dialog')?.open && window.__pluginCalls.filter(c=>c.command==='plugin_trust').length === window.__trustCallsBefore"));
  await admin.eval(click(`${row('spotify')} .plugin-row-actions > button`));
  check('disabling one row leaves the other plugin enabled', await admin.waitFor("document.querySelector('[data-plugin-id=spotify] .plugin-row-actions > button').textContent==='Enable'") && await admin.eval("document.querySelector('[data-plugin-id=other] .plugin-row-actions > button').textContent==='Disable' && window.__pluginCalls.filter(c=>c.command==='plugin_disconnect').at(-1).args.pluginId==='spotify'"));
  await admin.eval("window.__trustedPlugins = []; window.__runtimeStatus = 'detected'");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Detected Node 22.18.0')");
  await admin.eval(click(`${row('spotify')} .plugin-row-actions > button`));
  check('changed package identity revokes remembered trust and asks again', await admin.waitFor("!!document.querySelector('[data-plugin-id=spotify] dialog')?.open") && await admin.eval("document.querySelector('[data-plugin-id=spotify] dialog').textContent.includes('Trust and enable')"));
  await admin.eval(clickText(`${row('spotify')} dialog button`, 'Cancel'));
  await admin.eval("location.hash='#/'"); await admin.waitFor("!!document.querySelector('.add-control')");
  check('saved plugin image survives disabling its source plugin', await admin.waitFor("document.querySelector('.control-tile[data-action=mic-mute] img')?.naturalWidth > 0"));
  await admin.eval(click('.add-control')); await admin.waitFor("[...document.querySelectorAll('.action-row-name')].some(el=>el.textContent==='Other action')");
  await admin.eval(clickText('.action-row','Other action')); await admin.waitFor("!!document.querySelector('.native-control .button.primary')");
  await admin.eval(clickText('.native-control button','Run plugin action'));
  check('healthy plugin action stays usable after neighboring failure and disable', await admin.waitFor("window.__pluginArgs?.pluginId==='other' && window.__pluginArgs.actionId==='next'") && await admin.eval("!document.querySelector('.native-control').textContent.includes('Outcome unknown')"));
  // ------------------------------------------------------------ explicit offline desktop Live mode (fake IPC only)
  await admin.eval("location.hash = '#/'");
  await admin.waitFor("!!document.querySelector('.desktop-mode')");
  check('native editor defaults Preview and never needs the phone service', await admin.eval("document.querySelector('.desktop-mode [aria-pressed=true]').textContent === 'Preview' && window.__desktopCalls.length === 0 && !window.__adminCalls.includes('remote_start')"));
  await admin.eval(click('.control-tile[data-action="mic-mute"] button'));
  check('Preview tile selection never invokes a desktop action', await admin.eval("window.__desktopCalls.length === 0"));
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  check('entering Live labels risk but does not execute anything', await admin.waitFor("document.querySelector('.desktop-mode-note').textContent.includes('Live — presses run on this computer')") && await admin.eval("window.__desktopCalls.length === 0"));
  await admin.eval("window.__holdDesktop = true");
  await admin.eval("document.querySelector('.control-tile[data-action=mic-mute] button').click(); document.querySelector('.control-tile[data-action=mic-mute] button').click()");
  check('Live dispatches one saved control with flat revision envelope and disables doublepress', await admin.waitFor("window.__desktopCalls.length === 1 && document.querySelector('.control-tile button').disabled") && await admin.eval("Object.keys(window.__desktopCalls[0]).sort().join(',') === 'commandId,controlId,revision' && window.__desktopCalls[0].controlId === 'ctl_mic' && Number.isSafeInteger(window.__desktopCalls[0].revision)"));
  await admin.eval("window.__holdDesktop = false; window.__finishDesktop()");
  await admin.waitFor("document.querySelector('.workspace-footer').textContent.includes('Action confirmed')");
  await admin.eval("window.__holdSave = true");
  await admin.eval(setSelect('#page-switcher', 'page_media'));
  check('page edits immediately return Preview and block Live while saving', await admin.waitFor("!!window.__finishSave && document.querySelector('.desktop-mode [aria-pressed=true]').textContent === 'Preview' && document.querySelectorAll('.desktop-mode button')[1].disabled"));
  await admin.eval("window.__holdSave = false; window.__finishSave()");
  await admin.waitFor("!document.querySelectorAll('.desktop-mode button')[1].disabled");
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  await admin.eval("document.querySelector('.control-tile[data-action=volume] input').focus()");
  await admin.send('Page.bringToFront');
  await admin.send('Input.dispatchKeyEvent', {type:'rawKeyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,nativeVirtualKeyCode:39});
  check('Live slider keyboard movement invokes before keyup', await admin.waitFor("window.__desktopCalls.length === 2"));
  await admin.send('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,nativeVirtualKeyCode:39});
  await admin.waitFor("window.__desktopCalls.length === 2");
  await admin.send('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,nativeVirtualKeyCode:39});
  check('Live slider commits exactly once with saved revision, ID and numeric value', await admin.eval("window.__desktopCalls.length === 2 && window.__desktopCalls[1].controlId === 'ctl_volume' && window.__desktopCalls[1].value === 51 && window.__desktopCalls[1].revision > window.__desktopCalls[0].revision"));
  await admin.eval(click('[aria-label="Open phone preview"]'));
  await admin.waitFor("!!document.querySelector('.phone-shell')");
  await admin.eval(click('.phone-shell .control-tile[data-action="media-play-pause"] button'));
  check('phone preview remains simulated after leaving Live', await admin.eval("window.__desktopCalls.length === 2 && document.querySelector('.phone-shell').textContent.includes('Preview only')"));
  await admin.eval("location.hash = '#/'");
  await admin.waitFor("!!document.querySelector('.desktop-mode')");
  check('returning from phone preview requires explicit re-entry to Live', await admin.eval("document.querySelector('.desktop-mode [aria-pressed=true]').textContent === 'Preview'"));
  await admin.eval("window.__desktopResult = 'unknown'");
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  await admin.eval(click('.control-tile[data-action="media-play-pause"] button'));
  check('unknown desktop result warns prominently and returns Preview without retry', await admin.waitFor("document.querySelector('.workspace-footer [role=alert]')?.textContent.includes('Outcome unknown') && document.querySelector('.desktop-mode [aria-pressed=true]').textContent === 'Preview'") && await admin.eval("window.__desktopCalls.length === 3 && !document.querySelector('.workspace-footer button')"));
  await admin.eval("window.__desktopResult = 'pending'");
  await admin.eval(clickText('.desktop-mode button', 'Live'));
  await admin.eval(click('.control-tile[data-action="media-play-pause"] button'));
  await admin.waitFor("document.querySelector('.workspace-footer button')?.textContent === 'Check result'");
  check('acknowledged pending results block further presses', await admin.eval("window.__desktopCalls.length === 4 && document.querySelector('.control-tile button').disabled"));
  await admin.eval("window.__desktopResult = 'confirmed'");
  await admin.eval(clickText('.workspace-footer button', 'Check result'));
  check('explicit pending check reuses exactly the same ID and request', await admin.waitFor("window.__desktopCalls.length === 5 && !document.querySelector('.workspace-footer button')") && await admin.eval("JSON.stringify(window.__desktopCalls[3]) === JSON.stringify(window.__desktopCalls[4])"));
  await admin.eval("window.__desktopError = 'stale_revision'");
  await admin.eval(click('.control-tile[data-action="media-play-pause"] button'));
  check('stale revision errors return Preview and never expose raw diagnostics', await admin.waitFor("document.querySelector('.workspace-footer').textContent.includes('saved deck changed') && document.querySelector('.desktop-mode [aria-pressed=true]').textContent === 'Preview'") && await admin.eval("!document.querySelector('.workspace-footer').textContent.includes('raw secret')"));
  await admin.eval("window.__failSave = true");
  await admin.eval(setValue('.inspector-form input[type=text]', 'Edited after Live'));
  check('a failed save keeps Live disabled', await admin.waitFor("document.querySelectorAll('.desktop-mode button')[1].disabled && document.querySelector('.storage-alert')?.textContent.includes('could not be saved')"));
  await admin.eval("window.__failSave = false; window.__conflictSave = true");
  await admin.eval(setValue('.inspector-form input[type=text]', 'Conflicting edit'));
  check('a conflicting save blocks the editor and cannot leave Live enabled', await admin.waitFor("document.querySelector('.settings-header h1')?.textContent === 'The deck file needs attention' && !document.querySelector('.desktop-mode')") && await admin.eval("window.__desktopCalls.length === 6"));
  await cdp.send('Target.disposeBrowserContext', { browserContextId: adminCtx });

  // ------------------------------------------------------------ light theme and reduced motion during setup
  const { browserContextId: motionCtx } = await cdp.send('Target.createBrowserContext');
  const lightSetup = await openPage('setup-light', `${BASE}/`, { width: 960, height: 680 }, motionCtx);
  livePages.push(lightSetup);
  await lightSetup.waitFor("!!document.querySelector('.setup-shell')");
  const lightDeck = {
    version: 1,
    theme: "light",
    accent: "#4cc9f0",
    activePageId: "page_stream",
    pages: [{ id: "page_stream", name: "Stream", controls: [{ id: "ctl_keep", label: "Keep me", action: "mic-mute" }] }],
  };
  await lightSetup.eval(`localStorage.setItem('deck.local.v1', ${JSON.stringify(JSON.stringify(lightDeck))})`);
  await lightSetup.reload();
  check("a saved light deck goes straight to the editor", await lightSetup.waitFor("!!document.querySelector('.app-shell') && document.documentElement.dataset.theme === 'light'"));
  await lightSetup.eval(click('[aria-label="Open settings"]'));
  await lightSetup.waitFor("!!document.querySelector('.settings-view')");
  check("light-theme disclosures keep the shared chevron geometry", await lightSetup.eval("(() => { const rows = [document.querySelector('.storage-details > summary'), document.querySelector('.preview-scope > summary')]; return document.documentElement.dataset.theme === 'light' && rows.every((el) => !!el && el.classList.contains('disclosure')) && new Set(rows.map((el) => Math.round(el.getBoundingClientRect().left))).size === 1 && getComputedStyle(rows[0], '::before').borderRightColor !== 'rgba(0, 0, 0, 0)'; })()"));
  await lightSetup.eval(clickText('.settings-view button', 'Replay setup'));
  await lightSetup.waitFor("!!document.querySelector('.setup-shell')");
  check("replay setup keeps the light theme", await lightSetup.eval("document.documentElement.dataset.theme === 'light' && getComputedStyle(document.body).backgroundColor === 'rgb(244, 245, 246)'"));
  await lightSetup.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reducedMotionDuration = await lightSetup.eval("getComputedStyle(document.querySelector('.setup-demo-key')).animationDuration");
  check("reduced motion shortens the welcome animation", parseFloat(reducedMotionDuration) <= 0.001, reducedMotionDuration);
  await lightSetup.eval("window.__vtCalls = 0; const real = document.startViewTransition; if (real) document.startViewTransition = (callback) => { window.__vtCalls += 1; return real.call(document, callback); }");
  await lightSetup.eval(clickText('.setup-actions .button.primary', 'Make a button'));
  check("reduced motion skips the view transition but still advances", await lightSetup.waitFor("document.querySelector('.setup-story').classList.contains('setup-build')") && (await lightSetup.eval("window.__vtCalls")) === 0);
  await sleep(500);
  await lightSetup.screenshot("/tmp/deck-design-setup-light.png");
  await lightSetup.send("Emulation.setEmulatedMedia", { features: [] });
  await cdp.send('Target.disposeBrowserContext', { browserContextId: motionCtx });

  // ------------------------------------------------------------ page management in an isolated context
  const { browserContextId: manageCtx } = await cdp.send('Target.createBrowserContext');
  const manage = await openPage('page-manage', `${BASE}/`, { width: 1200, height: 900 }, manageCtx);
  livePages.push(manage);
  await manage.waitFor("!!document.querySelector('.setup-shell')");
  await manage.eval(clickText('.setup-header .button', 'Skip setup'));
  await manage.waitFor("!!document.querySelector('.app-shell')");
  const initialPages = await manage.eval("document.querySelectorAll('#page-switcher option').length");
  check("isolated deck starts with two pages", initialPages === 2, `pages=${initialPages}`);
  await manage.eval("document.querySelector('[aria-label=\"Manage pages\"]').focus()");
  await manage.eval(click('[aria-label="Manage pages"]'));
  check("page manager opens as a modal dialog", await manage.eval("document.querySelector('.page-dialog').open"));
  check("page manager initially focuses inside the dialog", await manage.eval("document.querySelector('.page-dialog').contains(document.activeElement)"));
  const pageBox = await manage.eval(rectOf('.page-dialog'));
  await pointerClick(manage, pageBox.cx, pageBox.top + 6);
  check("clicking inside the page manager padding keeps it open", await manage.eval("document.querySelector('.page-dialog').open"));
  await pointerClick(manage, Math.max(5, pageBox.left - 40), pageBox.cy);
  check("a backdrop click closes the page manager", await manage.waitFor("!document.querySelector('.page-dialog').open"));
  check("focus returns to the Manage pages button", await manage.eval("document.activeElement.getAttribute('aria-label') === 'Manage pages'"));
  await manage.eval(click('[aria-label="Manage pages"]'));
  await manage.waitFor("document.querySelector('.page-dialog').open");

  await manage.eval(click('.page-dialog .page-actions [title="Rename page"]'));
  await manage.eval(setValue('.page-dialog .page-rename input', 'Cancel me'));
  await manage.eval(click('.page-dialog [aria-label="Cancel rename"]'));
  check("cancelling a rename keeps the page name", await manage.eval("[...document.querySelectorAll('.page-dialog .page-name')].map((n) => n.textContent).join('|') === 'Stream|Media'"));

  await manage.eval(click('.page-dialog .page-actions [title="Rename page"]'));
  await typeInput(manage, '.page-dialog .page-rename input', 'Renamed');
  await manage.eval(click('.page-dialog [aria-label^="Save name"]'));
  check("rename commits inside the manager", await manage.waitFor("[...document.querySelectorAll('.page-dialog .page-name')].map((n) => n.textContent).join('|') === 'Renamed|Media'"));

  const pagesBeforeMove = await manage.eval("[...document.querySelectorAll('.page-dialog .page-name')].map((n) => n.textContent).join('|')");
  await manage.eval(click('.page-dialog .page-actions [title="Move page right"]'));
  const pagesAfterMove = await manage.eval("[...document.querySelectorAll('.page-dialog .page-name')].map((n) => n.textContent).join('|')");
  check("reorder current page inside the manager", pagesBeforeMove !== pagesAfterMove, `${pagesBeforeMove} -> ${pagesAfterMove}`);
  await manage.eval(click('.page-dialog .page-actions [title="Move page left"]'));

  await manage.eval(click('.page-dialog .add-page'));
  check("adding a page closes the manager", await manage.waitFor("!document.querySelector('.page-dialog').open"));
  check("page add increases the switcher list", await manage.eval(`document.querySelectorAll('#page-switcher option').length === ${initialPages + 1}`));
  check("empty page offers the first-control slot", await manage.eval("!!document.querySelector('.empty-key')"));
  await manage.eval(click('.empty-key'));
  check("empty-key opens the action picker", await manage.eval("document.querySelector('.action-library').open"));
  await manage.eval(clickText('.action-library .action-row', 'Volume slider'));
  await manage.waitFor("!document.querySelector('.action-library').open");
  check("adding from empty-key closes the picker and fills the page", await manage.eval("!document.querySelector('.action-library').open && document.querySelectorAll('.control-tile').length === 1"));

  await manage.eval(click('[aria-label="Manage pages"]'));
  await manage.waitFor("document.querySelector('.page-dialog').open");
  await manage.eval(click('.page-dialog .page-actions [title="Rename page"]'));
  await manage.waitFor("!!document.querySelector('.page-dialog .page-rename input')");
  await typeInput(manage, '.page-dialog .page-rename input', 'Smoke page');
  await manage.waitFor("document.querySelector('.page-dialog .page-rename input')?.value === 'Smoke page'");
  await manage.eval(click('.page-dialog [aria-label^="Save name"]'));
  check("test page renamed for removal", await manage.waitFor("[...document.querySelectorAll('.page-dialog .page-name')].some((n) => n.textContent === 'Smoke page')"));

  await manage.eval("window.__deckOriginalConfirm = window.confirm; window.__confirmCalls = []; window.confirm = (msg) => { window.__confirmCalls.push(msg); return false; }");
  await manage.eval(click('.page-dialog .page-actions [title="Remove page"]'));
  check("declining the confirmation keeps the test page", await manage.eval("document.querySelectorAll('.page-dialog .page-name').length === 3"));
  check("removal confirmation names the test page", await manage.eval("/Smoke page/.test(window.__confirmCalls[0] || '')"));

  await manage.eval("window.__confirmCalls = []; window.confirm = (msg) => { window.__confirmCalls.push(msg); return /Smoke page/.test(msg); }");
  await manage.eval(click('.page-dialog .page-actions [title="Remove page"]'));
  check("accepting the confirmation removes only the named page", await manage.eval("document.querySelectorAll('.page-dialog .page-name').length === 2 && ![...document.querySelectorAll('.page-dialog .page-name')].some((n) => n.textContent === 'Smoke page')"));
  await manage.eval("window.confirm = window.__deckOriginalConfirm");
  await cdp.send('Target.disposeBrowserContext', { browserContextId: manageCtx });

  // ------------------------------------------------------------ cross-tab sync
  const tabA = await openPage("sync-a", `${BASE}/`, { width: 1440, height: 1000 });
  const tabB = await openPage("sync-b", `${BASE}/`, { width: 1440, height: 1000 });
  livePages.push(tabA, tabB);
  await tabA.waitFor("!!document.querySelector('.app-shell')");
  await tabB.waitFor("!!document.querySelector('.app-shell')");
  await tabA.eval("document.querySelector('.control-tile[data-action=\"mic-mute\"] .tile-primary').click()");
  await tabB.eval("document.querySelector('.control-tile[data-action=\"mic-mute\"] .tile-primary').click()");
  await tabA.waitFor("!!document.querySelector('.inspector-form')");
  await tabB.waitFor("!!document.querySelector('.inspector-form')");
  await tabB.eval("window.__deckSmokeMarker = 'b-alive'");
  await tabA.eval(setValue('.inspector-form input[type="text"]', 'Synced name'));
  await tabA.waitFor("document.querySelector('.inspector-form input[type=\"text\"]').value === 'Synced name'");
  const synced = await tabB.waitFor("document.querySelector('.inspector-form input[type=\"text\"]').value === 'Synced name'");
  check("cross-tab edit updates the other tab inspector without reload", synced);
  check("other tab was not reloaded by sync", await tabB.eval("window.__deckSmokeMarker === 'b-alive'"));

  // ------------------------------------------------------------ phone portrait
  const phonePortrait = await openPage("phone-portrait", `${BASE}/#/phone`, {
    width: 390,
    height: 844,
    mobile: true,
  });
  livePages.push(phonePortrait);
  check("phone shell renders", await phonePortrait.waitFor("!!document.querySelector('.phone-shell')"));
  check("real phone portrait hides desktop chrome and keeps two columns", await phonePortrait.eval("getComputedStyle(document.querySelector('.phone-preview-bar')).display === 'none' && getComputedStyle(document.querySelector('.phone-grid')).gridTemplateColumns.split(' ').length === 2"));
  check("phone preview heading shows no control count", await phonePortrait.eval("!document.querySelector('.phone-page-count') && !/\\d+\\s+controls/.test(document.querySelector('.phone-page-heading').textContent)"));
  check("narrow phone preview shows a single 44px top-right Close preview", await phonePortrait.eval("(() => { const el = document.querySelector('.preview-close-narrow'); if (!el) return false; const r = el.getBoundingClientRect(); return getComputedStyle(el).display !== 'none' && getComputedStyle(document.querySelector('.phone-preview-bar')).display === 'none' && el.getAttribute('aria-label') === 'Close preview' && el.getAttribute('title') === 'Close preview' && r.width >= 44 && r.height >= 44 && r.right <= innerWidth + 1 && !document.querySelector('.phone-back'); })()"));
  await phonePortrait.eval(clickText('.phone-page-tab', 'Stream'));
  await phonePortrait.waitFor("document.querySelector('.phone-page-heading h1').textContent === 'Stream'");
  check("phone controls have at least 44px touch targets", await phonePortrait.eval("[...document.querySelectorAll('.tile-primary')].every(el => { const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })"));
  const tabs = await phonePortrait.eval("document.querySelectorAll('.phone-page-tab').length");
  check("phone shows deck pages", tabs === 2, `tabs=${tabs}`);
  await phonePortrait.eval(clickText(".phone-page-tab", "Media"));
  await phonePortrait.waitFor("document.querySelector('.phone-page-heading h1').textContent === 'Media'");
  check("phone page switching", await phonePortrait.eval("document.querySelector('.phone-page-heading h1').textContent === 'Media'"));
  await phonePortrait.eval(setValue('.phone-grid .tile-volume input[type="range"]', "70"));
  const volume = await phonePortrait.eval("document.querySelector('.phone-grid .tile-volume .volume-readout').textContent");
  check("phone volume preview updates", volume === "70%", volume);
  const portraitOverflow = await phonePortrait.eval("document.documentElement.scrollWidth - window.innerWidth");
  check("phone portrait has no horizontal overflow", portraitOverflow <= 1, `overflow=${portraitOverflow}px`);
  check("phone page navigation stays in thumb reach", await phonePortrait.eval("Math.abs(document.querySelector('.phone-footer').getBoundingClientRect().bottom - innerHeight) <= 1"));
  check("phone page targets are at least 44px", await phonePortrait.eval("[...document.querySelectorAll('.phone-page-tab')].every(el => el.getBoundingClientRect().height >= 44)"));
  check("phone fader is horizontal", await phonePortrait.eval("(() => { const r = document.querySelector('.tile-volume input').getBoundingClientRect(); return r.width > r.height && r.height >= 44; })()"));
  await phonePortrait.screenshot("/tmp/deck-smoke-phone-portrait.png");
  await phonePortrait.eval("document.querySelector('.preview-close-narrow').click()");
  check("narrow Close preview returns to the editor", await phonePortrait.waitFor("!!document.querySelector('.app-shell') && !document.querySelector('.phone-shell')"));

  const phoneLandscape = await openPage("phone-landscape", `${BASE}/#/phone`, {
    width: 844,
    height: 390,
    mobile: true,
  });
  livePages.push(phoneLandscape);
  await phoneLandscape.waitFor("!!document.querySelector('.phone-shell')");
  const landscapeOverflow = await phoneLandscape.eval("document.documentElement.scrollWidth - window.innerWidth");
  check("phone landscape has no horizontal overflow", landscapeOverflow <= 1, `overflow=${landscapeOverflow}px`);
  check("real phone landscape hides desktop chrome and keeps four columns", await phoneLandscape.eval("getComputedStyle(document.querySelector('.phone-preview-bar')).display === 'none' && getComputedStyle(document.querySelector('.phone-grid')).gridTemplateColumns.split(' ').length === 4"));
  await phoneLandscape.screenshot("/tmp/deck-smoke-phone-landscape.png");

  // ------------------------------------------------------------ desktop phone preview orientation
  const { browserContextId: previewCtx } = await cdp.send('Target.createBrowserContext');
  const desktopPhone = await openPage('phone-desktop', `${BASE}/#/phone`, { width: 1024, height: 900 }, previewCtx);
  livePages.push(desktopPhone);
  const longPhoneDeck = {
    version: 1, theme: 'dark', accent: '#4cc9f0', activePageId: 'p1',
    pages: [
      { id: 'p1', name: 'Long page', controls: Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, label: `Control ${index}`, action: 'mic-mute' })) },
      { id: 'p2', name: 'Second', controls: [] },
    ],
  };
  await desktopPhone.eval(`localStorage.setItem('deck.local.v1', ${JSON.stringify(JSON.stringify(longPhoneDeck))})`);
  await desktopPhone.reload();
  await desktopPhone.waitFor("!!document.querySelector('.phone-shell')");
  check("desktop preview puts the orientation toggle outside the device frame", await desktopPhone.eval("(() => { const bar = document.querySelector('.phone-preview-bar'); return !!bar && bar.contains(document.querySelector('[aria-label=\"Preview orientation\"]')) && !document.querySelector('.phone-shell').contains(bar); })()"));
  check("desktop preview defaults to landscape", await desktopPhone.eval("document.querySelector('.phone-preview').classList.contains('is-landscape') && document.querySelector('[aria-label=\"Preview orientation\"] [aria-pressed=\"true\"]').textContent === 'Landscape'"));
  const desktopLandscapeCols = await desktopPhone.eval("getComputedStyle(document.querySelector('.phone-grid')).gridTemplateColumns.split(' ').length");
  const desktopLandscapeBox = await desktopPhone.eval("(() => { const r = document.querySelector('.phone-shell').getBoundingClientRect(); return { width: r.width, height: r.height }; })()");
  check("desktop landscape preview uses four columns within ~760x430", desktopLandscapeCols === 4 && desktopLandscapeBox.width <= 760 && desktopLandscapeBox.height <= 431, JSON.stringify({ cols: desktopLandscapeCols, ...desktopLandscapeBox }));
  await desktopPhone.screenshot('/tmp/deck-design-preview-landscape.png');
  await desktopPhone.eval(clickText('.phone-preview-bar button', 'Portrait'));
  await desktopPhone.waitFor("document.querySelector('.phone-preview').classList.contains('is-portrait')");
  const desktopPortraitCols = await desktopPhone.eval("getComputedStyle(document.querySelector('.phone-grid')).gridTemplateColumns.split(' ').length");
  const desktopPortraitBox = await desktopPhone.eval("(() => { const r = document.querySelector('.phone-shell').getBoundingClientRect(); return { width: r.width, height: r.height }; })()");
  check("portrait toggle actually changes the grid to two columns", desktopPortraitCols === 2, `cols=${desktopPortraitCols}`);
  check("desktop portrait frame is ~390px wide and under 780px tall", Math.abs(desktopPortraitBox.width - 390) <= 1 && desktopPortraitBox.height <= 781, JSON.stringify(desktopPortraitBox));
  check("portrait toggle reports its pressed state", await desktopPhone.eval("document.querySelector('[aria-label=\"Preview orientation\"] [aria-pressed=\"true\"]').textContent === 'Portrait'"));
  check("long pages scroll inside the desktop frame", await desktopPhone.eval("(() => { const shell = document.querySelector('.phone-shell'); return shell.scrollHeight > shell.clientHeight; })()"));
  check("page navigation stays reachable inside the frame", await desktopPhone.eval("(() => { const footer = document.querySelector('.phone-footer'); const shell = document.querySelector('.phone-shell'); return !!footer.querySelector('.phone-page-tab') && footer.getBoundingClientRect().bottom <= shell.getBoundingClientRect().bottom + 1; })()"));
  check("desktop preview puts a 44px Close preview in the outer chrome", await desktopPhone.eval("(() => { const el = document.querySelector('.preview-close-desktop'); const bar = document.querySelector('.phone-preview-bar'); if (!el || !bar) return false; const r = el.getBoundingClientRect(); return bar.contains(el) && getComputedStyle(document.querySelector('.preview-close-narrow')).display === 'none' && el.getAttribute('aria-label') === 'Close preview' && el.getAttribute('title') === 'Close preview' && r.width >= 44 && r.height >= 44; })()"));
  await desktopPhone.screenshot('/tmp/deck-design-preview-portrait.png');
  await desktopPhone.eval("document.querySelector('.preview-close-desktop').click()");
  check("desktop Close preview returns to the editor", await desktopPhone.waitFor("!!document.querySelector('.app-shell') && !document.querySelector('.phone-shell')"));
  await cdp.send('Target.disposeBrowserContext', { browserContextId: previewCtx });

  // ------------------------------------------------------------ narrow action picker categories
  const { browserContextId: catCtx } = await cdp.send('Target.createBrowserContext');
  const narrowPicker = await openPage('picker-narrow', `${BASE}/`, { width: 240, height: 640, mobile: true }, catCtx);
  livePages.push(narrowPicker);
  await narrowPicker.waitFor("!!document.querySelector('.setup-shell')");
  await narrowPicker.eval(clickText('.setup-header .button', 'Skip setup'));
  await narrowPicker.waitFor("!!document.querySelector('.app-shell')");
  await narrowPicker.eval(click('.add-control'));
  await narrowPicker.waitFor("document.querySelector('.action-library').open");
  check("narrow action picker categories wrap without overflow", await narrowPicker.eval("(() => { const nav = document.querySelector('.action-categories'); const dialog = document.querySelector('.action-library'); const rows = new Set([...document.querySelectorAll('.action-category')].map((button) => Math.round(button.getBoundingClientRect().top))); const dialogRect = dialog.getBoundingClientRect(); return getComputedStyle(nav).flexWrap === 'wrap' && rows.size > 1 && nav.getBoundingClientRect().right <= dialogRect.right + 1 && dialogRect.left >= -1 && dialogRect.right <= innerWidth + 1; })()"));
  await cdp.send('Target.disposeBrowserContext', { browserContextId: catCtx });

  // Long names and a full page get their own storage, not the editor/sync fixtures.
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const narrow = await openPage('narrow-stress', `${BASE}/`, { width: 320, height: 844, mobile: true }, browserContextId);
  livePages.push(narrow);
  const stressDeck = JSON.parse(await editor.eval("localStorage.getItem('deck.local.v1')"));
  const longName = 'A very long control label with forty chars'.slice(0, 40);
  stressDeck.pages.forEach(page => { page.name = longName; });
  const templates = stressDeck.pages.flatMap(page => page.controls);
  stressDeck.pages[0].controls = Array.from({ length: 24 }, (_, index) => ({ ...templates[index % templates.length], id: `stress-${index}`, label: longName }));
  stressDeck.activePageId = stressDeck.pages[0].id;
  await narrow.eval(`localStorage.setItem('deck.local.v1', ${JSON.stringify(JSON.stringify(stressDeck))})`);
  await narrow.reload();
  check('full editor with long names fits a 320px viewport', await narrow.eval("document.querySelectorAll('.control-tile').length === 24 && document.documentElement.scrollWidth <= innerWidth"));
  check('narrow editor stacks the inspector below the grid', await narrow.eval("document.querySelector('.inspector-dock').getBoundingClientRect().top >= document.querySelector('.control-grid').getBoundingClientRect().bottom - 1"));
  check('full page does not offer an extra control slot', await narrow.eval("!document.querySelector('.empty-key')"));
  check('narrow editor reorder targets are touch-sized', await narrow.waitFor("(() => { const handles = [...document.querySelectorAll('.tile-order > summary')]; return handles.length > 0 && handles.every(el => { const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }); })()"));
  await narrow.eval("document.querySelector('.tile-order > summary').scrollIntoView({block:'center'})");
  const touchOrderHandle = await narrow.eval(rectOf('.tile-order > summary'));
  await narrow.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x:touchOrderHandle.cx,y:touchOrderHandle.cy}] });
  await narrow.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
  check('touch opens the labelled position alternative without pressing the key', await narrow.waitFor("document.querySelector('.tile-order').open && !!document.querySelector('.tile-order select[aria-label]') && !document.querySelector('.is-pressed')"));
  await narrow.eval("location.hash = '#/phone'");
  await narrow.waitFor("!!document.querySelector('.phone-shell')");
  check('full phone deck with long names fits a 320px viewport', await narrow.eval("document.querySelectorAll('.control-tile').length === 24 && document.documentElement.scrollWidth <= innerWidth"));
  check('long labels and faders stay within their keys', await narrow.eval("[...document.querySelectorAll('.tile-label, .tile-volume input')].every(el => { const r = el.getBoundingClientRect(); const key = el.closest('.control-tile').getBoundingClientRect(); return r.left >= key.left - 1 && r.right <= key.right + 1 && r.bottom <= key.bottom + 1; })"));
  await narrow.eval("location.hash = '#/settings'");
  await narrow.waitFor("!!document.querySelector('.settings-view')");
  await narrow.eval(clickText('.settings-view button', 'Replay setup'));
  await narrow.waitFor("!!document.querySelector('.setup-shell')");
  const fullDeckBefore = await narrow.eval("localStorage.getItem('deck.local.v1')");
  await narrow.eval(clickText('.setup-actions .primary', 'Make a button'));
  await narrow.waitFor("!!document.querySelector('.setup-build')");
  await narrow.eval(clickText('.setup-actions .primary', 'Try this control'));
  await narrow.waitFor("!!document.querySelector('.setup-try')");
  await narrow.eval(click('.setup-practice-key .tile-primary'));
  check('full-page rehearsal keeps Add disabled and explains the limit', await narrow.eval("document.querySelector('.setup-actions .primary').disabled && document.querySelector('.setup-error').textContent.includes('page is full')"));
  check('full-page setup leaves saved deck unchanged and fits 320px', fullDeckBefore === await narrow.eval("localStorage.getItem('deck.local.v1')") && await narrow.eval("document.documentElement.scrollWidth <= innerWidth"));
  await narrow.eval(clickText('.setup-header .button', 'Skip setup'));
  check('skip exits full-page setup safely', await narrow.waitFor("!!document.querySelector('.app-shell') && document.querySelectorAll('.control-tile').length === 24"));
  await cdp.send('Target.disposeBrowserContext', { browserContextId });

  // ------------------------------------------------------------ service worker offline shell
  const offline = await openPage("offline", `${BASE}/`, { width: 1440, height: 1000 });
  livePages.push(offline);
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
  livePages.push(update);
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
  for (const page of livePages) {
    const errors = page.errors.filter((e) => !/favicon/i.test(e));
    check(`no runtime/console errors on ${page.label}`, errors.length === 0, errors.join(" | "));
  }
} catch (error) {
  check("smoke run completed without harness error", false, error?.stack || String(error));
} finally {
  console.log("\nScreenshots:");
  for (const name of [
    "deck-design-onboarding.png",
    "deck-design-setup-welcome.png",
    "deck-design-setup-build.png",
    "deck-design-setup-try.png",
    "deck-design-setup-result.png",
    "deck-design-setup-result-editor.png",
    "deck-design-setup-light.png",
    "deck-design-desktop.png",
    "deck-design-actions.png",
    "deck-design-phone.png",
    "deck-design-volume.png",
    "deck-design-light.png",
    "deck-design-preview-landscape.png",
    "deck-design-preview-portrait.png",
    "deck-design-pairing-narrow.png",
    "deck-design-pairing-steps.png",
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
  landingServer.close();
  // Leave dist/ as the unmarked build, not the marker build used for the update test.
  if (existsSync(join(buildA, "index.html"))) {
    rmSync(join(ROOT, "dist"), { recursive: true, force: true });
    cpSync(buildA, join(ROOT, "dist"), { recursive: true });
  }
  if (!KEEP) {
    await removeWithRetry(chromeDir);
    await removeWithRetry(buildA);
    await removeWithRetry(buildB);
    await removeWithRetry(landingDir);
  }
  } catch (cleanupError) {
    console.error("cleanup warning:", cleanupError?.message || cleanupError);
  }
  process.exit(failures === 0 ? 0 : 1);
}
