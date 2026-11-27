// Run against a dev server: EDITOR_URL=http://127.0.0.1:5173 node scripts/editor-polish-smoke.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(process.env.EDITOR_URL || "http://127.0.0.1:5173");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Skip setup" }).click();
  assert.equal(await page.getByRole("button", { name: /^Section:/ }).count(), 0);
  assert.ok(await page.locator(".reorder-note").evaluate(el => parseFloat(getComputedStyle(el).marginTop) >= 16));

  await page.getByRole("button", { name: "Page: Stream", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Media", exact: true }).click();
  const tile = page.locator('.control-tile[data-action="volume"]').first();
  const id = await tile.locator(".tile-primary").getAttribute("aria-label");
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
  assert.ok(await page.getByRole("menuitem", { name: "Rename", exact: true }).evaluate(el => el === document.activeElement));
  await page.keyboard.press("Escape");
  await tile.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === "control-label");
  await page.locator("#control-label").fill("Remembered volume");
  await page.locator("#control-label").press("Enter");
  await page.getByRole("slider", { name: "Preview volume", exact: true }).fill("73");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await tile.locator(".tile-primary").click();
  assert.equal(await page.getByRole("slider", { name: "Preview volume", exact: true }).inputValue(), "73");
  assert.equal(await tile.locator(".tile-primary").getAttribute("aria-label"), "Select Remembered volume");
  assert.notEqual(id, "Select Remembered volume");

  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Select Remembered volume", exact: true }).count(), 0);
  await page.reload();
  await page.waitForLoadState("networkidle");
  assert.equal(await page.getByRole("button", { name: "Select Remembered volume", exact: true }).count(), 0);
  console.log("PASS: selector removed, hint spacing, context menu mouse/keyboard/Escape, rename, volume restart, delete restart");
} finally {
  await browser.close();
}
