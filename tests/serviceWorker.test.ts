import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CACHE_PREFIX,
  collectPrecache,
  computeVersion,
  renderServiceWorker,
} from "../build/serviceWorkerPlugin";

const root = mkdtempSync(join(tmpdir(), "deck-sw-"));
mkdirSync(join(root, "assets"));
mkdirSync(join(root, "icons"));
writeFileSync(join(root, "index.html"), "<html>one</html>");
writeFileSync(join(root, "manifest.webmanifest"), "{}");
writeFileSync(join(root, "icons", "icon-192.png"), "192");
writeFileSync(join(root, "icons", "icon-512.png"), "512");
writeFileSync(join(root, "icons", "apple-touch-icon.png"), "apple");
writeFileSync(join(root, "icons", "favicon-32.png"), "fav");
writeFileSync(join(root, "assets", "index-abc.js"), "console.log(1)");
writeFileSync(join(root, "assets", "index-def.css"), "body{}");
writeFileSync(join(root, "secret.txt"), "not part of the shell");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("generated service worker", () => {
  it("precaches only exact known shell and hashed asset files", () => {
    const precache = collectPrecache(root);
    expect(precache).toEqual([
      "/index.html",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/apple-touch-icon.png",
      "/icons/favicon-32.png",
      "/assets/index-abc.js",
      "/assets/index-def.css",
    ]);
    expect(precache.some((url) => url.includes("*"))).toBe(false);
    expect(precache).not.toContain("/secret.txt");
  });

  it("versions the cache by build content and marker", () => {
    const precache = collectPrecache(root);
    const first = computeVersion(root, precache);
    expect(first).toHaveLength(16);
    expect(computeVersion(root, precache)).toBe(first);
    expect(computeVersion(root, precache, "build-2")).not.toBe(first);

    writeFileSync(join(root, "index.html"), "<html>two</html>");
    expect(computeVersion(root, precache)).not.toBe(first);
    writeFileSync(join(root, "index.html"), "<html>one</html>");
  });

  it("renders a versioned worker with an exact-match fetch policy", () => {
    const precache = ["/index.html", "/assets/index-abc.js"];
    const version = computeVersion(root, collectPrecache(root));
    const source = renderServiceWorker(version, precache);

    expect(source).toContain(`CACHE_PREFIX + ${JSON.stringify(version)}`);
    expect(source).toContain(JSON.stringify(precache));
    expect(source).toContain(`const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)}`);

    // Exact allowlist, never a wildcard trust of /assets/ or any API path.
    expect(source).toContain("PRECACHE_SET.has(url.pathname)");
    expect(source).not.toContain('startsWith("/assets/")');
    expect(source).not.toContain("/api");
    expect(source).toContain("if (url.search) return;");
    expect(source).toContain('NAVIGATION_PATHS = new Set(["/", "/index.html"])');

    // Install must not skipWaiting; activation cleans only this app's caches.
    const installBlock = source.slice(
      source.indexOf('addEventListener("install"'),
      source.indexOf('addEventListener("activate"'),
    );
    expect(installBlock).not.toContain("skipWaiting");
    expect(source).toContain("key.startsWith(CACHE_PREFIX) && key !== CACHE");
  });
});
