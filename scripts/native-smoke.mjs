#!/usr/bin/env node
// Opt-in headful WebKit layout check: temporary data and setup navigation only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "linux", "This native smoke currently targets Linux.");
assert(process.env.WAYLAND_DISPLAY || process.env.DISPLAY, "A desktop display is required.");
const root = mkdtempSync(join(tmpdir(), "zdeck-native-smoke-"));
const child = spawn(resolve("src-tauri/target/debug/deck"), [], {
  detached: true,
  env: {
    ...process.env,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    ZDECK_NATIVE_SMOKE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", chunk => { output = (output + chunk.toString()).slice(-20000); });
}
function stop(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
const interrupt = () => { process.exitCode = 130; stop("SIGKILL"); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(() => stop("SIGTERM"), 8000);
const force = setTimeout(() => stop("SIGKILL"), 11000);
try {
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert(!process.exitCode, "Native smoke interrupted.");
  assert(status.code === 0 || status.signal === "SIGTERM", `Unexpected native exit: ${JSON.stringify(status)}\n${output}`);
  assert(!/EGL_BAD_PARAMETER|GLIBC_\S+.*not found|MESA-LOADER: failed|Failed to create GBM device/.test(output), output);
  // An alive GTK parent is insufficient: a failed WebKit child leaves it blank.
  const file = join(root, "data", "com.deck.local", "deck.v1.json");
  const document = JSON.parse(readFileSync(file, "utf8"));
  assert(document.revision > 0 && document.deck.pages.length > 0, "Frontend did not initialize its native deck.");
  const reports = output.split("\n").filter(line => line.startsWith("ZDECK_NATIVE_LAYOUT "))
    .map(line => JSON.parse(line.slice("ZDECK_NATIVE_LAYOUT ".length)));
  for (const step of ["welcome", "build", "try", "editor"]) {
    const report = reports.find(report => report.step === step);
    assert(report, `Missing ${step} layout report; build with --features native-smoke.\n${output}`);
    assert(report.dpr > 0 && report.dpr <= 8, `Invalid WebKit pixel ratio: ${JSON.stringify(report)}`);
    assert(report.width >= 760 && report.height >= 500 && report.font >= 12 && report.font <= 20, `Invalid viewport/font: ${JSON.stringify(report)}`);
    assert(!report.overflow, `Horizontal overflow: ${JSON.stringify(report)}`);
    if (step === "editor") {
      assert(report.workspace?.width >= 700 && report.grid?.width >= 200 && report.inspector?.width >= 250, JSON.stringify(report));
    } else {
      assert(report.story?.width >= 500 && report.heading?.width >= 500 && report.heading?.height < 100, JSON.stringify(report));
      if (step === "welcome") assert(report.key?.width >= 70 && report.key?.height >= 70, JSON.stringify(report));
      if (step === "try") assert(report.key?.width >= 140, JSON.stringify(report));
    }
    console.log(`PASS native WebKit ${step} layout: ${report.width}×${report.height}, pixel ratio ${report.dpr}.`);
  }
  console.log("PASS native frontend initialized its isolated deck without EGL/GBM loader errors.");
  console.log("Only setup navigation exercised; no real OBS/audio/media or phone-service actions.");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  clearTimeout(timer);
  clearTimeout(force);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  stop("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
