#!/usr/bin/env node
// Real-browser smoke for the authenticated phone frontend.
//
// Opt-in/ignored fixture support: scripts/browser-smoke.mjs is the reference
// for CDP and profile cleanup. This script is launched by the Rust integration
// test `remote_browser_smoke` in src-tauri/tests/remote_service.rs and speaks a
// private line-delimited JSON RPC over stdout/stdin with that Rust parent. It
// never touches a real tailnet, OBS, audio, or a physical device:
//   * A disposable self-signed cert + loopback HTTPS proxy stands in for
//     Tailscale Serve. Chrome's host resolver maps the canonical *.ts.net host
//     to 127.0.0.1:<proxy port>, so Host/Origin/Cookie/upgrade stay canonical.
//   * All device approval, deck edits, and fake-adapter counts come from the
//     Rust parent over RPC; no HTTP admin routes exist or are used.
//
// Human output goes to stderr. stdout is reserved for the RPC channel.
import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
};
const ORIGIN = argValue("--origin", "https://deck.tailnet.ts.net");
const BACKEND_PORT = Number(argValue("--backend-port", "0"));
const HOST = new URL(ORIGIN).hostname;
const CHROME = process.env.CHROME_BIN || "google-chrome";
const TEMP_ROOT = argValue("--temp-dir", tmpdir());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let failures = 0;
function log(line) {
  process.stderr.write(`${line}\n`);
}
function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failures += 1;
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ------------------------------------------------------------------ RPC client
let rpcSeq = 0;
const rpcPending = new Map();
const rpcReader = createInterface({ input: process.stdin });
rpcReader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const entry = rpcPending.get(message.id);
  if (!entry) return;
  rpcPending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error || "RPC failed"));
});
function rpc(method, params = {}) {
  const id = ++rpcSeq;
  process.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject });
    const timer = setTimeout(() => {
      if (rpcPending.delete(id)) reject(new Error(`RPC timeout: ${method}`));
    }, 15000);
    timer.unref?.();
  });
}

// ------------------------------------------------------------------ HTTPS proxy
const proxy = {
  dropNextCommandResponse: false,
  rewriteNextCommandRevision: null,
  dropped: 0,
  pairs: [],
  commands: [],
  requests: [],
  upgrades: 0,
};
let tlsPort = 0;

function recordRequest(req, body) {
  if (req.method === "POST" && req.url === "/api/v1/pair") {
    try {
      proxy.pairs.push(JSON.parse(body.toString("utf8")));
    } catch {
      proxy.pairs.push(null);
    }
  }
  if (req.method === "POST" && req.url === "/api/v1/commands") {
    try {
      proxy.commands.push(JSON.parse(body.toString("utf8")));
    } catch {
      proxy.commands.push(null);
    }
  }
}

function proxyRequest(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    recordRequest(req, body);
    if (
      req.method === "POST" &&
      req.url === "/api/v1/commands" &&
      proxy.rewriteNextCommandRevision !== null
    ) {
      const rewrite = proxy.rewriteNextCommandRevision;
      proxy.rewriteNextCommandRevision = null;
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        parsed.revision = rewrite;
        body = Buffer.from(JSON.stringify(parsed));
      } catch {
        // Forward unchanged if the body was not JSON.
      }
    }
    forward(req, res, body);
  });
  req.on("error", () => res.destroy());
}

function forward(req, res, body) {
  const headers = { ...req.headers };
  delete headers.connection;
  headers["content-length"] = body.length;
  const upstream = httpRequest(
    { host: "127.0.0.1", port: BACKEND_PORT, method: req.method, path: req.url, headers },
    (up) => {
      proxy.requests.push({ method: req.method, path: req.url, status: up.statusCode });
      if (
        proxy.dropNextCommandResponse &&
        req.method === "POST" &&
        req.url === "/api/v1/commands"
      ) {
        // The upstream action already ran. Send response headers plus a partial
        // body, then break the socket: the client sees a failed body read, not
        // a retryable connection reset (which Chromium auto-retries).
        proxy.dropNextCommandResponse = false;
        proxy.dropped += 1;
        up.resume();
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": "4096",
          connection: "close",
        });
        res.end('{"id":"');
        return;
      }
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => res.destroy());
  upstream.end(body);
}

function proxyUpgrade(req, socket, head) {
  proxy.upgrades += 1;
  const upstream = createConnection(BACKEND_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

// ------------------------------------------------------------------ CDP client
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else {
        for (const listener of [...this.listeners]) listener(message);
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
}

class Page {
  constructor(cdp, sessionId, targetId, label) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.label = label;
    this.errors = [];
    cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params.exceptionDetails;
        this.errors.push(detail?.exception?.description || detail?.text);
      }
    });
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }
  async navigate(url, timeout = 20000) {
    const loaded = this.send("Page.navigate", { url });
    await loaded;
    await this.waitForLoad(timeout);
  }
  async waitForLoad(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.eval("document.readyState === 'complete'").catch(() => false)) return;
      await sleep(50);
    }
    throw new Error(`${this.label} did not finish loading`);
  }
  async reload(timeout = 20000) {
    await this.send("Page.reload", {});
    await this.waitForLoad(timeout);
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `eval failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  }
  async waitFor(expression, timeout = 12000) {
    const start = Date.now();
    for (;;) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        // Execution context may be replaced during navigation.
      }
      if (Date.now() - start > timeout) return false;
      await sleep(100);
    }
  }
}

async function openPage(label, url, { browserContextId, viewport } = {}) {
  const created = await cdp.send("Target.createTarget", {
    url: "about:blank",
    ...(browserContextId ? { browserContextId } : {}),
  });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  const page = new Page(cdp, attached.sessionId, created.targetId, label);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  if (viewport) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: Boolean(viewport.mobile),
    });
  }
  if (url) await page.navigate(url);
  return page;
}

// ------------------------------------------------------------------ DOM helpers
const clickText = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`;
const setValue = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
const rectOf = (selector) =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2, width: r.width, height: r.height }; })()`;

async function keyEvent(page, type, key, code, vk) {
  await page.send("Input.dispatchKeyEvent", {
    type,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

async function waitForRequest(predicate, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = proxy.requests.find(predicate);
    if (found) return found;
    await sleep(80);
  }
  return null;
}

async function waitForNewCommands(before, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (proxy.commands.length > before) return true;
    await sleep(60);
  }
  return false;
}

/** Waits until the phone is active and no action is in flight. */
async function settle(page, timeout = 12000) {
  return page.waitFor(
    "!!document.querySelector('.remote-connection[data-state=\"active\"]') && !document.querySelector('.control-tile.is-disabled')",
    timeout,
  );
}

const commandPath = (entry) => entry.method === "POST" && entry.path === "/api/v1/commands";

// ------------------------------------------------------------------ lifecycle
let tlsServer = null;
let chrome = null;
let cdp = null;
let ws = null;
let certDir = null;
let chromeDir = null;
const livePages = [];
let exitCode = 1;

function killChrome() {
  if (!chrome) return;
  try {
    chrome.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

process.on("SIGTERM", () => {
  killChrome();
  process.exit(130);
});
process.on("SIGINT", () => {
  killChrome();
  process.exit(130);
});

async function main() {
  // Disposable TLS material for the loopback proxy only.
  certDir = mkdtempSync(join(TEMP_ROOT, "deck-remote-cert-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      `/CN=${HOST}`,
      "-addext",
      `subjectAltName=DNS:${HOST}`,
    ],
    { stdio: "ignore" },
  );

  tlsServer = createHttpsServer(
    { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) },
    proxyRequest,
  );
  tlsServer.on("upgrade", proxyUpgrade);
  await new Promise((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  tlsPort = tlsServer.address().port;
  log(`loopback HTTPS proxy on 127.0.0.1:${tlsPort} -> 127.0.0.1:${BACKEND_PORT} for ${HOST}`);

  // Confirm the parent service rejected a hostile Origin through the real proxy.
  const hostile = await rawHttps("POST", "/api/v1/pair", "https://evil.example", null, "{}");
  check(
    "hostile Origin is rejected through the proxy",
    hostile.status === 403,
    `status ${hostile.status}`,
  );
  const wrongHost = await rawHttps("GET", "/api/v1/state", null, "evil.example", null);
  check(
    "unexpected Host is rejected through the proxy",
    wrongHost.status === 400,
    `status ${wrongHost.status}`,
  );
  // Drop the harness probes from the request journal so later checks only see
  // the browser's own traffic.
  proxy.pairs.length = 0;
  proxy.commands.length = 0;
  proxy.requests.length = 0;

  // Chrome maps the canonical host to the loopback proxy: no tailnet traffic.
  chromeDir = mkdtempSync(join(TEMP_ROOT, "deck-remote-chrome-"));
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-proxy-server",
      "--disable-sync",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-client-side-phishing-detection",
      "--metrics-recording-only",
      "--mute-audio",
      "--ignore-certificate-errors",
      "--allow-insecure-localhost",
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${tlsPort}`,
      `--user-data-dir=${chromeDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeStderr = "";
  chrome.stderr.on("data", (chunk) => {
    chromeStderr += chunk.toString();
  });

  const activePortFile = join(chromeDir, "DevToolsActivePort");
  let devtoolsPort = 0;
  for (let i = 0; i < 150 && !devtoolsPort; i += 1) {
    if (existsSync(activePortFile)) {
      devtoolsPort = Number(readFileSync(activePortFile, "utf8").split("\n")[0]) || 0;
      if (!devtoolsPort) await sleep(50);
    } else {
      await sleep(100);
    }
  }
  if (!devtoolsPort) throw new Error(`Chrome did not expose CDP.\n${chromeStderr}`);

  const version = await (
    await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)
  ).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  cdp = new Cdp(ws);

  // ------------------------------------------------------------ invitation + root
  const invitation = await rpc("create_invitation");
  check(
    "Rust parent issued a 64-char lowercase-hex invitation",
    /^[0-9a-f]{64}$/.test(invitation.invitation),
  );
  check(
    "invitation URL is a same-origin root pairing link",
    invitation.url === `${ORIGIN}/#/pair?invite=${invitation.invitation}`,
  );

  const phone = await openPage("phone", `${ORIGIN}/#/pair?invite=${invitation.invitation}`, {
    viewport: { width: 390, height: 844, mobile: true },
  });
  livePages.push(phone);
  await phone.waitFor("!!document.querySelector('.remote-app')");

  check(
    "remote root is selected and never the editor",
    await phone.eval(
      "document.documentElement.hasAttribute('data-zdeck-remote') && !document.documentElement.hasAttribute('data-zdeck-local') && !document.querySelector('.app-shell, .setup-shell, .phone-shell')",
    ),
  );
  check(
    "exact invite fragment is removed from the URL before any request",
    await phone.eval(
      "location.hash === '' && !location.href.includes('invite') && !location.href.includes('pair')",
    ),
  );
  check(
    "no pairing POST happens before the deliberate click",
    proxy.pairs.length === 0 && proxy.requests.filter((e) => e.path === "/api/v1/pair").length === 0,
    `${proxy.pairs.length} pairing requests`,
  );
  check(
    "captured link is shown and no deck is rendered while unpaired",
    await phone.eval(
      "!!document.querySelector('.remote-captured') && !document.querySelector('.phone-grid')",
    ),
  );

  await phone.eval("document.fonts.ready.then(() => true)");
  writeFileSync("/tmp/deck-remote-pairing.png", Buffer.from(
    (await phone.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ------------------------------------------------------------ pending state
  await phone.eval(clickText(".remote-pair .button.primary", "Request approval"));
  const pairEntry = await waitForRequest((e) => e.method === "POST" && e.path === "/api/v1/pair");
  check("exactly one pairing POST after the click", proxy.pairs.length === 1 && pairEntry?.status === 200);
  check(
    "pairing POST carries the captured invitation and the device name",
    proxy.pairs[0]?.invitation === invitation.invitation && proxy.pairs[0]?.name === "My phone",
    `device name: ${proxy.pairs[0]?.name}`,
  );
  check(
    "pending screen waits for desktop approval",
    await phone.waitFor(
      "document.querySelector('.remote-pair h1')?.textContent.includes('Approve this phone')",
    ),
  );
  const pendingState = await phone.eval(
    "fetch('/api/v1/state', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.status)",
  );
  check("pending device cannot read the deck", pendingState === 403, `status ${pendingState}`);
  const pendingCommand = await phone.eval(
    "fetch('/api/v1/commands', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'cmd_pending_probe', revision: 1, controlId: 'ctl_mic' }) }).then((r) => r.status)",
  );
  check("pending device cannot run an action", pendingCommand === 403, `status ${pendingCommand}`);

  // ------------------------------------------------------------ approval -> real GET/WSS
  const devices = await rpc("list_devices");
  const pendingDevice = devices.find((device) => device.status === "pending");
  check("Rust parent sees exactly one pending device", Boolean(pendingDevice) && devices.filter((d) => d.status === "pending").length === 1);
  await rpc("approve_device", { requestId: pendingDevice.requestId });
  check(
    "explicit approval leads to a real authenticated snapshot",
    await phone.waitFor("!!document.querySelector('.remote-connection[data-state=\"active\"]')", 15000),
  );
  const stateEntry = await waitForRequest((e) => e.method === "GET" && e.path === "/api/v1/state" && e.status === 200);
  check("phone fetched /api/v1/state after approval", stateEntry?.status === 200, JSON.stringify(stateEntry));
  check("phone opened a real WebSocket snapshot", proxy.upgrades > 0);
  check(
    "saved fake deck controls are rendered",
    await phone.eval(
      "document.querySelectorAll('.phone-grid .control-tile').length === 4 && !!document.querySelector('[data-action=\"obs-scene\"]') && !!document.querySelector('[data-action=\"mic-mute\"]') && document.querySelector('[data-action=\"media-play-pause\"]')?.textContent.includes('Fixture playback')",
    ),
  );
  check(
    "remote page heading shows the page name with no control count",
    await phone.eval(
      "document.querySelector('.phone-page-heading h1')?.textContent === 'Stream' && !document.querySelector('.phone-page-count') && !/\\d+\\s+controls/.test(document.querySelector('.phone-page-heading')?.textContent ?? '')",
    ),
  );
  check(
    "authenticated remote phone has no editor close affordance",
    await phone.eval("!document.querySelector('.preview-close, .phone-back')"),
  );

  await phone.eval("Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))");
  writeFileSync("/tmp/deck-remote-active.png", Buffer.from(
    (await phone.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ------------------------------------------------------------ real click -> typed result
  await settle(phone);
  const beforeMedia = (await rpc("runner_calls")).calls;
  await rpc("runner_push", { outputs: ["Paused", "", "Playing"] });
  await phone.eval(
    "(() => { const key = document.querySelector('[data-action=\"media-play-pause\"] .tile-primary'); key.click(); key.click(); })()",
  );
  const mediaCommand = await waitForRequest((e) => commandPath(e));
  await phone.waitFor(
    "!!document.querySelector('.remote-activity-list li[data-state=\"confirmed\"]')",
  );
  const mediaResults = proxy.commands.filter((c) => c.controlId === "ctl_play_pause");
  check(
    "rapid double press sends one exact saved command while busy",
    mediaResults.length === 1 &&
      mediaResults[0].id.startsWith("cmd_") &&
      mediaResults[0].revision >= 1 &&
      mediaResults[0].value === undefined,
    JSON.stringify(mediaResults),
  );
  check(
    "routine confirmed outcome moves into a collapsed Activity log, not a visible toast",
    await phone.eval(
      "(() => { const details = document.querySelector('.remote-activity'); const entry = document.querySelector('.remote-activity-list li[data-state=\"confirmed\"]'); return !!details && details.open === false && !document.querySelector('.remote-status') && entry?.querySelector('.remote-activity-label')?.textContent.includes('Fixture playback'); })()",
    ),
  );
  await phone.eval("document.querySelector('.remote-activity > summary').click()");
  check(
    "Activity opens to show the routine outcome message",
    await phone.waitFor("document.querySelector('.remote-activity')?.open === true && (document.querySelector('.remote-activity-message')?.textContent.length ?? 0) > 0"),
  );
  writeFileSync("/tmp/deck-remote-activity.png", Buffer.from(
    (await phone.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await phone.eval("document.querySelector('.remote-activity > summary').click()");
  const afterMedia = (await rpc("runner_calls")).calls;
  check("media execution uses three fake adapter calls (read, mutate, read)", afterMedia - beforeMedia === 3, `${afterMedia - beforeMedia}`);
  void mediaCommand;

  // ------------------------------------------------------------ page selection + slider
  const beforePage = (await rpc("runner_calls")).calls;
  const commandsBeforePage = proxy.commands.length;
  await phone.eval(clickText(".phone-page-tab", "Media"));
  check(
    "page selection changes the page without a command POST",
    (await phone.waitFor("document.querySelector('.phone-page-heading h1')?.textContent === 'Media'")) &&
      proxy.commands.length === commandsBeforePage &&
      (await rpc("runner_calls")).calls === beforePage,
  );

  await phone.eval("document.querySelector('#vol-phone-ctl_volume').focus()");
  const beforeKey = proxy.commands.length;
  await rpc("runner_push", { outputs: ["", "Volume: 0.51"] });
  await keyEvent(phone, "keyDown", "ArrowRight", "ArrowRight", 39);
  await sleep(250);
  check(
    "slider key change does not POST before key-up",
    proxy.commands.length === beforeKey &&
      (await phone.eval("Number(document.querySelector('#vol-phone-ctl_volume').value) === 51")),
  );
  await keyEvent(phone, "keyUp", "ArrowRight", "ArrowRight", 39);
  const keyArrived = await waitForNewCommands(beforeKey);
  const keyCommands = proxy.commands.slice(beforeKey);
  check(
    "deliberate key-up sends exactly one bounded volume target",
    keyArrived &&
      keyCommands.length === 1 &&
      keyCommands[0].controlId === "ctl_volume" &&
      keyCommands[0].value === 51,
    JSON.stringify(keyCommands),
  );
  check(
    "volume commit logs a typed outcome in Activity",
    await phone.waitFor("!!document.querySelector('.remote-activity-list li:first-child[data-state=\"confirmed\"]') && document.querySelector('.remote-activity-list li:first-child .remote-activity-label')?.textContent === document.querySelector('[data-action=\"volume\"] .tile-label')?.textContent"),
  );

  await settle(phone);
  const beforeCancel = proxy.commands.length;
  await phone.eval(`(() => {
    const slider = document.querySelector('#vol-phone-ctl_volume');
    const pointer = type => slider.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }));
    pointer('pointerdown'); pointer('pointercancel'); pointer('pointerup');
    slider.focus(); pointer('pointerdown'); slider.blur(); pointer('pointerup');
    slider.focus();
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    slider.blur();
    slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    pointer('pointerup');
  })()`);
  await sleep(200);
  check("slider pointer cancellation and blur send no command", proxy.commands.length === beforeCancel);

  // Pointer drag: value stays local until pointer release.
  await settle(phone);
  const beforeDrag = proxy.commands.length;
  const slider = await phone.eval(rectOf("#vol-phone-ctl_volume"));
  const y = slider.top + slider.height / 2;
  await phone.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: slider.left + slider.width * 0.2,
    y,
    button: "left",
    clickCount: 1,
    buttons: 1,
  });
  await phone.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: slider.left + slider.width * 0.6,
    y,
    button: "left",
    buttons: 1,
  });
  await sleep(200);
  check(
    "slider drag does not POST until pointer release",
    proxy.commands.length === beforeDrag,
  );
  await rpc("runner_push", { outputs: ["", "Volume: 0.50"] });
  await phone.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: slider.left + slider.width * 0.6,
    y,
    button: "left",
    clickCount: 1,
    buttons: 1,
  });
  const dragArrived = await waitForNewCommands(beforeDrag);
  const dragCommands = proxy.commands.slice(beforeDrag);
  check(
    "pointer release sends exactly one bounded volume target",
    dragArrived &&
      dragCommands.length === 1 &&
      dragCommands[0].value >= 0 &&
      dragCommands[0].value <= 100,
    JSON.stringify(dragCommands.map((c) => c.value)),
  );

  // ------------------------------------------------------------ live revision over WS
  await settle(phone);
  await phone.eval("window.__smokeMarker = 4711");
  const saved = await rpc("save_deck", { pageId: "page_media", name: "Media ★" });
  check("Rust parent saved a new revision", saved.revision >= 2, JSON.stringify(saved));
  check(
    "new saved revision propagates over the real WebSocket",
    await phone.waitFor("document.querySelector('.phone-page-heading h1')?.textContent === 'Media ★'", 12000),
  );
  check(
    "live update did not reload the page",
    await phone.eval("window.__smokeMarker === 4711"),
  );

  // ------------------------------------------------------------ dropped command reply -> Unknown
  await settle(phone);
  const beforeDrop = (await rpc("runner_calls")).calls;
  const commandsBeforeDrop = proxy.commands.length;
  await rpc("runner_push", { outputs: ["Paused", "", "Playing"] });
  proxy.dropNextCommandResponse = true;
  await phone.eval(
    "document.querySelector('[data-action=\"media-play-pause\"] .tile-primary').click()",
  );
  const sawUnknown = await phone.waitFor(
    "!!document.querySelector('.remote-warning[data-kind=\"unknown\"]')",
    12000,
  );
  const droppedKind = await phone.eval(
    "document.querySelector('.remote-warning')?.getAttribute('data-kind')",
  );
  check(
    "dropped reply shows a visible Unknown warning, not a retry",
    sawUnknown &&
      droppedKind === "unknown" &&
      (await phone.eval("document.querySelector('.remote-warning')?.textContent.includes('Check the desktop before trying again')")) &&
      (await phone.eval("document.querySelector('.remote-activity')?.open === false")),
    `sawUnknown=${sawUnknown} kind=${droppedKind}`,
  );
  check(
    "dropped response was the intentional truncation",
    proxy.dropped === 1,
    `dropped=${proxy.dropped}`,
  );
  writeFileSync("/tmp/deck-remote-unknown.png", Buffer.from(
    (await phone.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const afterDrop = (await rpc("runner_calls")).calls;
  check("upstream action completed before the dropped reply", afterDrop - beforeDrop === 3, `${afterDrop - beforeDrop}`);
  await sleep(1800);
  check(
    "no automatic replay after the dropped reply",
    (await rpc("runner_calls")).calls === afterDrop &&
      proxy.commands.length === commandsBeforeDrop + 1,
    `calls=${(await rpc("runner_calls")).calls} commands=${proxy.commands.length - commandsBeforeDrop}`,
  );

  // ------------------------------------------------------------ stale revision -> read-only resync
  await settle(phone);
  const statesBeforeConflict = proxy.requests.filter(
    (e) => e.method === "GET" && e.path === "/api/v1/state" && e.status === 200,
  ).length;
  const commandsBeforeConflict = proxy.commands.length;
  const callsBeforeConflict = (await rpc("runner_calls")).calls;
  proxy.rewriteNextCommandRevision = 1;
  await phone.eval(
    "document.querySelector('[data-action=\"media-play-pause\"] .tile-primary').click()",
  );
  check(
    "stale revision shows a non-mutating resync notice in Activity",
    await phone.waitFor(
      "document.querySelector('.remote-activity-list li[data-state=\"info\"] .remote-activity-message')?.textContent.includes('saved deck changed')",
      12000,
    ),
  );
  await waitForRequest(
    (e) => e.method === "GET" && e.path === "/api/v1/state" && e.status === 200,
    12000,
  );
  check(
    "stale revision triggers a fresh authenticated snapshot",
    proxy.requests.filter(
      (e) => e.method === "GET" && e.path === "/api/v1/state" && e.status === 200,
    ).length > statesBeforeConflict,
  );
  check(
    "conflict resync returns controls to active",
    await phone.waitFor("!!document.querySelector('.remote-connection[data-state=\"active\"]')", 15000),
  );

  check("conflict resync does not replay or run the rejected action",
    proxy.commands.length === commandsBeforeConflict + 1 &&
    (await rpc("runner_calls")).calls === callsBeforeConflict);

  // A normal press works again after the resync.
  await settle(phone);
  const beforeResync = (await rpc("runner_calls")).calls;
  await rpc("runner_push", { outputs: ["Paused", "", "Playing"] });
  await phone.eval(
    "document.querySelector('[data-action=\"media-play-pause\"] .tile-primary').click()",
  );
  await phone.waitFor("!!document.querySelector('.remote-activity-list li:first-child[data-state=\"confirmed\"]')", 12000);
  const afterResync = (await rpc("runner_calls")).calls;
  check("controls work after the conflict resync", afterResync - beforeResync === 3, `${afterResync - beforeResync}`);

  // ------------------------------------------------------------ revocation
  const approvedDevices = await rpc("list_devices");
  const approved = approvedDevices.find((device) => device.status === "approved");
  check("Rust parent lists the approved device", Boolean(approved));
  await rpc("revoke_device", { requestId: approved.requestId });
  check(
    "revoked device loses the deck and sees the terminal message",
    await phone.waitFor(
      "document.querySelector('.remote-pair')?.textContent.includes('removed') && !document.querySelector('.phone-grid')",
      15000,
    ),
  );
  const revokedState = await phone.eval(
    "fetch('/api/v1/state', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.status)",
  );
  check("revoked credential can no longer read state", revokedState === 401, `status ${revokedState}`);
  const beforeRevokedCommand = (await rpc("runner_calls")).calls;
  const revokedCommand = await phone.eval(
    `fetch('/api/v1/commands', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'cmd_revoked_probe', revision: ${saved.revision}, controlId: 'ctl_mic' }) }).then((r) => r.status)`,
  );
  check("revoked device cannot invoke an action", revokedCommand === 401, `status ${revokedCommand}`);
  check("revoked invoke attempt ran no adapter", (await rpc("runner_calls")).calls === beforeRevokedCommand);

  // ------------------------------------------------------------ installed-app-equivalent paste flow
  const invitation2 = await rpc("create_invitation");
  const context = await cdp.send("Target.createBrowserContext", {});
  const pasted = await openPage("pasted", `${ORIGIN}/`, {
    browserContextId: context.browserContextId,
    viewport: { width: 390, height: 844, mobile: true },
  });
  livePages.push(pasted);
  await pasted.waitFor("!!document.querySelector('.remote-app')");
  check(
    "fresh context shows the paste-link form, not HTTPS/editor fallbacks",
    await pasted.eval(
      "!!document.querySelector('.remote-pair input[placeholder]') && !document.querySelector('.app-shell, .setup-shell, .phone-shell') && !document.body.textContent.includes('HTTPS required')",
    ),
  );
  const pairsBeforePaste = proxy.pairs.length;
  await pasted.eval(setValue(".remote-pair input[placeholder]", invitation2.url));
  await sleep(200);
  check("pasting a link does not POST by itself", proxy.pairs.length === pairsBeforePaste);
  await pasted.eval(clickText(".remote-pair .button.primary", "Request approval"));
  await pasted.waitFor("document.querySelector('.remote-pair h1')?.textContent.includes('Approve this phone')");
  const pastedPair = proxy.requests.filter(e => e.method === "POST" && e.path === "/api/v1/pair").at(-1);
  const lastPair = proxy.pairs[proxy.pairs.length - 1];
  check(
    "paste-link flow pairs with the fresh invitation",
    pastedPair?.status === 200 && lastPair?.invitation === invitation2.invitation,
    JSON.stringify({ status: pastedPair?.status }),
  );
  const pastedDevices = await rpc("list_devices");
  const pastedPending = pastedDevices.find((device) => device.status === "pending");
  await rpc("approve_device", { requestId: pastedPending.requestId });
  check(
    "pasted phone becomes active with the saved deck",
    await pasted.waitFor("!!document.querySelector('.remote-connection[data-state=\"active\"]')", 15000),
  );
  const beforePastedCommand = (await rpc("runner_calls")).calls;
  await rpc("runner_push", { outputs: ["Volume: 0.50", "", "Volume: 0.50 [MUTED]"] });
  await pasted.eval(
    "document.querySelector('[data-action=\"mic-mute\"] .tile-primary').click()",
  );
  await pasted.waitFor("!!document.querySelector('.remote-activity-list li[data-state=\"confirmed\"]')", 12000);
  const afterPastedCommand = (await rpc("runner_calls")).calls;
  check(
    "pasted phone runs one confirmed fixture action",
    afterPastedCommand - beforePastedCommand === 3,
    `${afterPastedCommand - beforePastedCommand}`,
  );

  // ------------------------------------------------------------ service worker
  const swReady = await pasted
    .eval("navigator.serviceWorker.ready.then(() => true).catch(() => false)")
    .catch(() => false);
  check("service worker reaches ready", swReady === true);
  check(
    "service worker controls the cached page",
    await pasted.waitFor("navigator.serviceWorker.controller !== null", 10000),
  );
  await pasted.eval("fetch('/?cache-probe=1', { cache: 'no-store' }).then(r => r.text())");
  const cacheReport = await pasted
    .eval(
      `(async () => {
        const keys = await caches.keys();
        const shellKey = keys.find((key) => key.startsWith('deck-shell-'));
        if (!shellKey) return { shellKey: null };
        const cache = await caches.open(shellKey);
        const index = await cache.match('/index.html');
        const text = index ? await index.text() : '';
        const entries = await cache.keys();
        return {
          shellKey,
          remoteMarker: text.includes('data-zdeck-remote'),
          localMarker: text.includes('data-zdeck-local'),
          cachedUrls: entries.map((request) => request.url),
        };
      })()`,
    )
    .catch((error) => ({ error: String(error) }));
  check(
    "service worker caches the rewritten remote shell",
    cacheReport.remoteMarker === true && cacheReport.localMarker === false,
    JSON.stringify({ shellKey: cacheReport.shellKey }),
  );
  check(
    "service worker never caches API, token, or query URLs",
    Array.isArray(cacheReport.cachedUrls) &&
      cacheReport.cachedUrls.length > 0 &&
      cacheReport.cachedUrls.every(
        (url) => !url.includes("/api/") && !url.includes("invite") && !url.includes("?"),
      ),
    JSON.stringify(cacheReport.cachedUrls),
  );

  // Offline reload serves the remote shell and cannot execute actions.
  await pasted.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await pasted.reload();
  await pasted.waitFor("document.readyState === 'complete'");
  await sleep(400);
  check(
    "offline reload cannot become the editor or sample deck",
    await pasted.eval(
      "document.documentElement.hasAttribute('data-zdeck-remote') && !document.querySelector('.app-shell, .setup-shell, .phone-shell')",
    ),
  );
  check(
    "offline reload cannot run an action",
    await pasted.eval(
      "(() => { const controls = [...document.querySelectorAll('.phone-grid .tile-primary')]; return controls.length === 0 || controls.every((el) => el.disabled); })()",
    ),
  );
  await pasted.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  // Auth is still required after the cached shell reloads.
  await pasted.send("Network.clearBrowserCookies");
  await pasted.reload();
  await pasted.waitFor("document.readyState === 'complete'");
  await sleep(400);
  const afterClearState = await pasted.eval(
    "fetch('/api/v1/state', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.status)",
  );
  check("cached shell still requires API auth", afterClearState === 401, `status ${afterClearState}`);
  check(
    "unauthenticated cached shell shows pairing, not the editor",
    await pasted.eval(
      "!!document.querySelector('.remote-app') && !document.querySelector('.app-shell, .setup-shell')",
    ),
  );

  await pasted.eval("window.dispatchEvent(new Event('deck:update-ready'))");
  check("remote surface exposes the shared user-applied update banner",
    await pasted.waitFor("document.querySelector('.update-banner button')?.textContent.includes('Reload')"));

  // ------------------------------------------------------------ connection counts
  const counts = await rpc("counts");
  check(
    "Rust parent reports bounded connection/device counts",
    counts.approved === 1 && counts.pending === 0 && counts.connectedSockets === 0,
    JSON.stringify(counts),
  );

  for (const page of livePages) {
    check(`no uncaught runtime errors on ${page.label}`, page.errors.length === 0, JSON.stringify(page.errors));
  }
  log("");
  log(`${results.length - failures}/${results.length} checks passed`);
  exitCode = failures === 0 ? 0 : 1;
}

async function removeWithRetry(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`Could not remove owned temporary directory: ${path}`);
}

async function rawHttps(method, path, origin, host, body) {
  return new Promise((resolve, reject) => {
    const headers = { host: host || HOST };
    if (origin) headers.origin = origin;
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: tlsPort,
        servername: HOST,
        method,
        path,
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const started = Date.now();
try {
  await main();
} catch (error) {
  check("smoke run completed without harness error", false, error?.stack || String(error));
} finally {
  try {
    for (const page of livePages) {
      await cdp?.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    }
    ws?.close();
  } catch {
    // Best effort.
  }
  killChrome();
  await new Promise((resolve) => {
    if (!chrome) return resolve();
    if (chrome.exitCode !== null) return resolve();
    chrome.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  tlsServer?.close();
  try {
    if (chromeDir) await removeWithRetry(chromeDir);
    if (certDir) await removeWithRetry(certDir);
  } catch (cleanupError) {
    log(`cleanup error: ${cleanupError?.message || cleanupError}`);
    exitCode = 1;
  }
  log(`finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(exitCode);
}
