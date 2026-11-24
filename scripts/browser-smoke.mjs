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
  ".ttf": "font/ttf",
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
    await this.eval("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(resolve))).then(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))");
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

async function openPage(label, url, viewport, browserContextId) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) });
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
const setSelect = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;
// Real input avoids synthetic change/blur racing submission in controlled rename forms.
async function typeInput(page, selector, text) {
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

serveRoot = buildA;
const livePages = [];

try {
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
  check("remove button keeps danger text with a visible tinted surface and border", await editor.eval("(() => { const cs = getComputedStyle(document.querySelector('.inspector-actions .button.danger')); return cs.color === 'rgb(239, 167, 176)' && cs.borderTopWidth === '1px' && cs.borderTopColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.boxShadow !== 'none'; })()"));
  await editor.eval(setValue('.inspector-form input[type="text"]', 'Go live edited'));
  check("inspector rename persists in the field", await editor.waitFor("document.querySelector('.inspector-form input[type=\"text\"]').value === 'Go live edited'"));

  const orderBefore = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')");
  await editor.eval("document.querySelector('.inspector-actions .move-group button[title=\"Move down\"]').click()");
  const orderAfter = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')");
  check("inspector move-group reorders controls", orderBefore !== orderAfter, `${orderBefore} -> ${orderAfter}`);
  check("reorder controls are labelled buttons", await editor.eval("[...document.querySelectorAll('.inspector-actions .move-group button')].every((b) => b.tagName === 'BUTTON' && !!b.getAttribute('aria-label'))"));

  const keyboardOrderBefore = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')");
  await editor.eval("document.querySelector('.inspector-actions .move-group button[title=\"Move up\"]').focus()");
  await pressKey(editor, "Enter", "Enter", 13, "\r");
  const keyboardOrderAfter = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')");
  check("keyboard activation of the focused move button reorders", keyboardOrderBefore !== keyboardOrderAfter, `${keyboardOrderBefore} -> ${keyboardOrderAfter}`);

  // refresh persistence
  await editor.reload();
  await editor.waitFor("!!document.querySelector('.app-shell')");
  const persisted = await editor.eval("[...document.querySelectorAll('.control-tile .tile-label')].map((n) => n.textContent).join('|')");
  check("refresh keeps the edited deck", persisted === keyboardOrderAfter, persisted);
  check("saved deck no longer shows onboarding", await editor.eval("!document.querySelector('.setup-shell')"));

  // ------------------------------------------------------------ settings + theme segmented control
  await editor.eval(click('[aria-label="Open settings"]'));
  check("settings opens from the topbar", await editor.waitFor("!!document.querySelector('.settings-view')"));
  check("active settings control toggles back to the editor", await editor.eval("document.querySelector('[aria-label=\"Back to editor\"]')?.getAttribute('href') === '#/' && document.querySelector('[aria-label=\"Back to editor\"]').getAttribute('aria-current') === 'page'"));
  check("closed About this preview reserves no blank space after its summary", await editor.eval("(() => { const d = document.querySelector('.preview-scope'); const s = d.querySelector('summary'); return !d.open && getComputedStyle(d).display === 'block' && (d.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom) <= 2; })()"));
  check("closed Storage details reserves no blank space after its summary", await editor.eval("(() => { const d = document.querySelector('.storage-details'); const s = d.querySelector('summary'); return !d.open && (d.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom) <= 2; })()"));
  check("Storage and About disclosures share one row geometry and chevron", await editor.eval("(() => { const rows = [document.querySelector('.storage-details > summary'), document.querySelector('.preview-scope > summary')]; return rows.every((el) => !!el && el.classList.contains('disclosure')) && new Set(rows.map((el) => Math.round(el.getBoundingClientRect().left))).size === 1 && new Set(rows.map((el) => Math.round(el.getBoundingClientRect().height))).size === 1 && getComputedStyle(rows[0], '::before').content !== 'none' && getComputedStyle(rows[0], '::before').borderRightStyle === 'solid'; })()"));
  await editor.eval(click('[aria-label="Back to editor"]'));
  check("clicking the same settings control returns to the editor", await editor.waitFor("!!document.querySelector('.canvas-panel') && !document.querySelector('.settings-view')"));
  await editor.eval(click('[aria-label="Open settings"]'));
  await editor.waitFor("!!document.querySelector('.settings-view')");
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
  check("build step preselects the scene action and its defaults", await firstRun.eval("document.querySelector('.setup-choice input:checked').value === 'obs-scene' && document.querySelector('input[name=\"label\"]').value === 'Scene 1' && document.querySelector('input[name=\"scene\"]').value === 'Scene 1'"));
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
  check("blank label blocks the build submit", await firstRun.eval("document.querySelector('.setup-fields input[name=\"label\"]').validity.valueMissing && document.querySelector('.setup-actions button[type=\"submit\"]').disabled"));
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
  const adminDeck = { ...JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/deck.sample.json'), 'utf8')), version: 2 };
  await admin.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.isTauri = true;
    window.__adminCalls = [];
    // A reload with a saved preference simulates a new program session: service is stopped.
    let running = !localStorage.getItem('deck.remote.origin.v1'), invitationNumber = 0;
    window.__remoteStartOrigins = [];
    window.__desktopCalls = [];
    let savedDeck = ${JSON.stringify(adminDeck)}, savedRevision = 1;
    let cachedPlugin = {status:'disconnected', manifest:null, state:null, lastError:null};
    window.__pluginArgs = null;
    window.__pluginsInstalled = false;
    window.__runtimeStatus = 'detected';
    const pluginManifest = {id:'spotify', version:'0.1.0', protocolVersion:1, actions:[
      {id:'set-volume', title:'Spotify <volume>', config:{volume:{type:'integer',minimum:0,maximum:100}}}
    ]};
    let origin = 'https://fixture.tailnet.ts.net', mode = 'tailscale';
    window.__remoteStartArgs = [];
    const status = () => ({running, mode: running ? mode : null, origin: running ? origin : null, port: running ? 45829 : null, pendingDevices: 0, approvedDevices: 0, connectedSockets: 0});
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.__adminCalls.push(command);
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
        return {id:args.commandId,state:window.__desktopResult || 'confirmed',message:'Safe backend result.'};
      }
      if (command === 'plugin_snapshot') return cachedPlugin;
      if (command === 'plugin_catalog') return {
        directory:'/Users/fixture/.config/zdeck/plugins',
        node:window.__runtimeStatus === 'not_found' ? {status:'not_found',version:null,path:null} : {status:'detected',version:'22.18.0',path:'/detected/node'},
        plugins:window.__pluginsInstalled ? [
          {id:'spotify',name:'spotify',version:'0.1.0',protocolVersion:1,status:'ready',message:null},
          {id:'other',name:'other',version:'0.1.0',protocolVersion:1,status:'ready',message:null},
          {id:'broken',name:'broken',version:'',protocolVersion:0,status:'invalid',message:'Invalid manifest.'},
          {id:'future',name:'future',version:'0.1.0',protocolVersion:2,status:'incompatible',message:'Unsupported protocol.'}
        ] : [], truncated:false
      };
      if (command === 'plugin_open_directory') return null;
      if (command === 'plugin_enable') {
        if (args.pluginId !== 'spotify' || Object.keys(args).length !== 1) throw new Error('Invalid enable arguments');
        return cachedPlugin = {status:'connected', manifest:pluginManifest, state:null, lastError:null};
      }
      if (command === 'plugin_disconnect') return cachedPlugin = {status:'disconnected', manifest:null, state:null, lastError:null};
      if (command === 'plugin_state') return cachedPlugin = {...cachedPlugin, state:{title:'<script>Track</script>', artist:'Artist', playback:'paused', volume:50, secret:'NEVER DISPLAY THIS'}};
      if (command === 'plugin_execute') {
        window.__pluginArgs = args;
        if (window.__failPlugin) throw {kind:'plugin_failed',code:'outcome_unknown',outcome:'unknown',message:'raw secret',hint:'raw secret'};
        return cachedPlugin = {...cachedPlugin, state:{title:'Track',artist:'Artist',playback:'playing',volume:args.args.volume}};
      }
      if (command === 'remote_status') return status();
      if (command === 'remote_list_devices') return [];
      if (command === 'obs_snapshot') return { connected: false, host: '127.0.0.1', port: 4455, scenes: [], currentScene: null, observedAtMs: Date.now() };
      if (command === 'remote_start') {
        window.__remoteStartOrigins.push(args.origin);
        window.__remoteStartArgs.push(args);
        if (window.__holdRemoteStart) await new Promise(resolve => { window.__finishRemoteStart = resolve; });
        if (window.__failRemoteStart) throw {kind:'invalid_origin',message:'The local service could not be started.'};
        origin = args.origin; mode = args.mode; running = true; return status();
      }
      if (command === 'remote_stop') { running = false; return status(); }
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
  await admin.navigate(`${BASE}/#/settings`);
  check('desktop pairing status distinguishes local service from phone access', await admin.waitFor("document.querySelector('.settings-view')?.textContent.includes('Phone access is not checked.')"));
  check('background HTTPS command is visible outside Connection help', await admin.eval("document.querySelector('.remote-command pre').textContent === 'tailscale serve --bg --https=443 http://127.0.0.1:45829' && !document.querySelector('.remote-help').open && !document.querySelector('.remote-help .remote-command')"));
  const connectionPanelSpacing = "(() => { const panel = document.querySelector('.remote-panel:not([hidden])'), hidden = document.querySelector('.remote-panel[hidden]'); const intro = panel.querySelector(':scope > p').getBoundingClientRect(), steps = panel.querySelector('.remote-steps').getBoundingClientRect(), command = panel.querySelector('.remote-command').getBoundingClientRect(), field = panel.querySelector('.field').getBoundingClientRect(); return steps.top - intro.bottom >= 11.5 && field.top - command.bottom >= 11.5 && getComputedStyle(hidden).display === 'none' && hidden.getBoundingClientRect().height === 0; })()";
  const commandRowVisible = "(() => { const row = document.querySelector('.remote-command-row'), pre = row.querySelector('pre'), button = row.querySelector('button'); const p = pre.getBoundingClientRect(), b = button.getBoundingClientRect(); return button.textContent === 'Copy command' && b.width > 0 && b.height > 0 && b.left - p.right >= 7.5 && Math.abs((b.top + b.height / 2) - (p.top + p.height / 2)) <= 1.5 && b.top >= 0 && b.bottom <= innerHeight && b.right <= innerWidth && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('button') === button; })()";
  check('visible connection panel restores 12px intro/field gaps and hidden panel takes no space', await admin.eval(connectionPanelSpacing));
  await admin.eval("document.querySelector('.remote-command-row').scrollIntoView({block:'center'})");
  check('Tailscale copy button is adjacent to the command, visible and not clipped', await admin.eval(commandRowVisible));
  await admin.eval(clickText('.remote-command button', 'Copy command'));
  check('Copy command copies exact background command and announces success', await admin.waitFor("document.querySelector('.remote-command [role=status]')?.textContent === 'Command copied.' && window.__clipboardText === 'tailscale serve --bg --https=443 http://127.0.0.1:45829'"));
  await admin.eval("window.__clipboardFails = true");
  await admin.eval(clickText('.remote-command button', 'Copy command'));
  check('blocked clipboard provides a selectable command and manual-copy fallback', await admin.waitFor("document.querySelector('.remote-command [role=status]')?.textContent.includes('copy it manually') && document.querySelector('.remote-command pre').tabIndex === 0"));
  await admin.eval("window.__clipboardFails = false");
  check('running service hydrates the address without persisting session or pairing data', await admin.eval("document.querySelector('input[type=url]').value === 'https://fixture.tailnet.ts.net' && !localStorage.getItem('deck.remote.origin.v1') && !window.__adminCalls.includes('remote_start')"));
  check('pairing steps are four numbered circles', await admin.eval("(() => { const items = [...document.querySelectorAll('.remote-steps > li')]; return items.length === 4 && items.every((li) => { const mark = getComputedStyle(li, '::before'); return mark.borderRadius === '50%' && mark.content !== 'none' && parseFloat(mark.width) > 0; }); })()"));
  check('Connection, Storage, and About disclosures share one row geometry and chevron', await admin.eval("(() => { const rows = [document.querySelector('.remote-help > .disclosure'), document.querySelector('.storage-details > summary'), document.querySelector('.preview-scope > summary')]; return rows.every((el) => !!el && el.classList.contains('disclosure')) && new Set(rows.map((el) => Math.round(el.getBoundingClientRect().left))).size === 1 && new Set(rows.map((el) => Math.round(el.getBoundingClientRect().height))).size === 1 && getComputedStyle(rows[0], '::before').borderRightStyle === 'solid'; })()"));
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
  check('narrow disclosures align their arrows and centered labels', await admin.eval("(() => { const rows = [...document.querySelectorAll('.remote-help > .disclosure, .storage-details > summary, .preview-scope > summary')]; return rows.length === 3 && new Set(rows.map(el => Math.round(el.getBoundingClientRect().left))).size === 1 && rows.every(el => { const range = document.createRange(); range.selectNodeContents(el); const r = el.getBoundingClientRect(), t = range.getBoundingClientRect(); return Math.abs(t.top + t.height / 2 - r.top - r.height / 2) <= 1.5; }); })()"));
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
  await admin.eval("location.hash = '#/settings'");
  check('Settings remount restores selected Local HTTPS and its successful address, not the draft', await admin.waitFor("document.getElementById('remote-tab-local_https')?.getAttribute('aria-selected') === 'true' && document.querySelector('input[type=url]').value === 'https://192.168.1.20:8443'"));
  await admin.send('Page.reload', { ignoreCache: true });
  check('restart restores local mode and origin without starting any service', await admin.waitFor("document.getElementById('remote-tab-local_https')?.getAttribute('aria-selected') === 'true' && document.querySelector('input[type=url]')?.value === 'https://192.168.1.20:8443' && document.querySelector('.settings-view').textContent.includes('Local service stopped.')") && await admin.eval("!window.__adminCalls.includes('remote_start')"));
  await admin.eval(click('#remote-tab-tailscale'));
  await admin.eval("location.hash = '#/'");
  await admin.waitFor("!!document.querySelector('.workspace')");
  await admin.eval("location.hash = '#/settings'");
  check('Settings remount restores the last successful address, not its unsaved draft', await admin.waitFor("document.querySelector('input[type=url]')?.value === 'https://new.tailnet.ts.net' && document.querySelector('.settings-view').textContent.includes('Local service stopped.')"));
  await admin.reload();
  check('program-session reload remembers the address without auto-starting service', await admin.waitFor("document.querySelector('input[type=url]')?.value === 'https://new.tailnet.ts.net' && document.querySelector('.settings-view').textContent.includes('Local service stopped.')") && await admin.eval("!window.__adminCalls.includes('remote_start')"));
  check('pairing presentation never requests native action execution', await admin.eval("window.__adminCalls.every(command => command === 'native_deck_load' || command === 'plugin_snapshot' || command === 'plugin_catalog' || command === 'obs_snapshot' || /^system_(output|microphone|media)_snapshot$/.test(command) || command.startsWith('remote_'))"), await admin.eval("[...new Set(window.__adminCalls)].join(', ')"));
  // ------------------------------------------------------------ plugin UI (owned IPC fake, never osascript)
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  check('plugin mount only requests catalog and cached metadata', await admin.eval("window.__adminCalls.filter(c => c.startsWith('plugin_')).every(c => ['plugin_snapshot','plugin_catalog'].includes(c))"));
  check('plugin settings detects Node and explains empty installation without path inputs', await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Detected Node 22.18.0') && document.querySelector('.plugin-settings').textContent.includes('Nothing installed yet')") && await admin.eval("!document.querySelector('.plugin-settings input[type=text]')"));
  await admin.eval(clickText('.plugin-settings button', 'Open plugin folder'));
  check('Open plugin folder invokes only the fixed native opener command', await admin.waitFor("window.__adminCalls.includes('plugin_open_directory')"));
  await admin.eval("window.__pluginsInstalled = true");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  check('refresh discovers copied folders and explains invalid/incompatible entries', await admin.waitFor("document.querySelector('.plugin-settings select')?.options.length === 5 && document.querySelector('.plugin-settings').textContent.includes('broken — invalid') && document.querySelector('.plugin-settings').textContent.includes('future — incompatible')"));
  await admin.eval(setSelect('.plugin-settings select', 'spotify'));
  check('Enable stays disabled until selected plugin trust is acknowledged', await admin.eval("!document.querySelector('.plugin-trust input').checked && document.querySelector('.plugin-settings .button.primary').disabled"));
  await admin.eval("document.querySelector('.plugin-trust input').click()");
  check('selected ready plugin and checked trust enable the button', await admin.eval("!document.querySelector('.plugin-settings .button.primary').disabled"));
  await admin.eval(setSelect('.plugin-settings select', 'other'));
  check('changing selected plugin resets trust', await admin.eval("!document.querySelector('.plugin-trust input').checked && document.querySelector('.plugin-settings .button.primary').disabled"));
  await admin.eval(setSelect('.plugin-settings select', 'spotify'));
  await admin.eval("document.querySelector('.plugin-trust input').click()");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  check('refresh clears selection trust without enabling anything', await admin.waitFor("!document.querySelector('.plugin-trust input').checked && document.querySelector('.plugin-settings select').value === ''") && await admin.eval("!window.__adminCalls.includes('plugin_enable')"));
  await admin.eval("window.__runtimeStatus = 'not_found'");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Node not found')");
  await admin.eval(setSelect('.plugin-settings select', 'spotify'));
  await admin.eval("document.querySelector('.plugin-trust input').click()");
  check('missing runtime disables Enable even with acknowledged trust', await admin.eval("document.querySelector('.plugin-settings .button.primary').disabled"));
  await admin.eval("window.__runtimeStatus = 'detected'");
  await admin.eval(clickText('.plugin-settings button', 'Refresh'));
  await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Detected Node 22.18.0')");
  await admin.eval(setSelect('.plugin-settings select', 'spotify'));
  await admin.eval("document.querySelector('.plugin-trust input').click()");
  await admin.eval(clickText('.plugin-settings button', 'Enable plugin'));
  check('Enable describes only, with no state read, legacy connect or execution', await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Plugin connected.')") && await admin.eval("window.__adminCalls.filter(c => c.startsWith('plugin_')).every(c => ['plugin_snapshot','plugin_catalog','plugin_open_directory','plugin_enable'].includes(c)) && window.__adminCalls.filter(c => c === 'plugin_enable').length === 1"));
  check('connected session requires disconnect before switching', await admin.eval("document.querySelector('.plugin-settings select').disabled && document.querySelector('.plugin-settings .button.primary').disabled"));
  await admin.eval(clickText('.plugin-settings button', 'Read state'));
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
  await admin.eval(click('.add-control'));
  check('connected manifest action appears as escaped text in the library', await admin.waitFor("[...document.querySelectorAll('.action-row-name')].some(el => el.textContent === 'Spotify <volume>')") && await admin.eval("!document.querySelector('.action-library volume')"));
  await admin.eval(clickText('.action-row', 'Spotify <volume>'));
  await admin.waitFor("!!document.querySelector('.inspector-form .native-control input[type=number]')");
  check('plugin uses a configured button with sensible volume default', await admin.eval("document.querySelector('.inspector-form .native-control input').value === '50' && document.querySelectorAll('.control-tile[data-action=plugin] input[type=range]').length === 0"));
  await admin.eval(setValue('.inspector-form .native-control input', '101'));
  check('invalid plugin bounds disable Run', await admin.eval("document.querySelector('.inspector-form .native-control .button.primary').disabled"));
  await admin.eval(setValue('.inspector-form .native-control input', ''));
  check('empty unsaved plugin draft disables Run', await admin.eval("document.querySelector('.inspector-form .native-control .button.primary').disabled"));
  await admin.eval(setValue('.inspector-form .native-control input', '75'));
  await admin.eval(clickText('.native-control button', 'Run plugin action'));
  check('Inspector Run maps saved generic plugin arguments', await admin.waitFor("window.__pluginArgs?.args.volume === 75") && await admin.eval("window.__pluginArgs.pluginId === 'spotify' && window.__pluginArgs.actionId === 'set-volume'"));
  const executions = await admin.eval("window.__adminCalls.filter(c => c === 'plugin_execute').length");
  await admin.eval(click('[aria-label="Open phone preview"]'));
  await admin.waitFor("!!document.querySelector('.phone-shell .control-tile[data-action=plugin]')");
  await admin.eval(click('.phone-shell .control-tile[data-action=plugin] button'));
  check('phone preview simulates the plugin without native execution', await admin.eval(`window.__adminCalls.filter(c => c === 'plugin_execute').length === ${executions} && document.querySelector('.phone-shell').textContent.includes('Preview only')`));
  await admin.eval("location.hash = '#/'");
  await admin.waitFor("!!document.querySelector('.inspector-form .native-control')");
  await admin.eval("window.__failPlugin = true");
  await admin.eval(clickText('.native-control button', 'Run plugin action'));
  check('unknown outcome is sanitized, warns, disables Run and requires explicit reconnect', await admin.waitFor("document.querySelector('.inspector-form').textContent.includes('Outcome unknown')") && await admin.eval("document.querySelector('.native-control .button.primary').disabled && !document.querySelector('.inspector-form').textContent.includes('raw secret')"));
  await admin.eval("location.hash = '#/settings'");
  await admin.waitFor("!!document.querySelector('.plugin-settings')");
  check('failure clears trust and settings never stores launch paths', await admin.eval("!document.querySelector('.plugin-settings input[type=text]') && !document.querySelector('.plugin-trust input').checked && !JSON.stringify(localStorage).includes('/detected/node')"));
  await admin.eval("document.querySelector('.plugin-trust input').click()");
  await admin.eval(clickText('.plugin-settings button', 'Enable plugin'));
  await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Plugin connected.')");
  await admin.eval(clickText('.plugin-settings button', 'Disconnect'));
  check('disconnect clears trust and leaves enabling explicit', await admin.waitFor("document.querySelector('.plugin-settings').textContent.includes('Plugin disconnected.') && !document.querySelector('.plugin-trust input').checked && document.querySelector('.plugin-settings .button.primary').disabled"));
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
  check('Live slider movement does not invoke until release', await admin.eval("window.__desktopCalls.length === 1"));
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
  check('narrow editor reorder targets are touch-sized', await narrow.eval("(() => { const buttons = [...document.querySelectorAll('.inspector-actions .move-group button')]; return buttons.length === 2 && buttons.every(el => { const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }); })()"));
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
