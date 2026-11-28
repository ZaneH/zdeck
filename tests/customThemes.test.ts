import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultDeck, setCustomTheme } from "../src/lib/deck";
import { setSectionCustomTheme, setSectionTheme } from "../src/lib/sections";
import { applyTheme } from "../src/lib/theme";
import { parseThemePackageBytes, validateThemePackage } from "../src/lib/themePackage";
import type { CustomThemeReference, ThemePackage } from "../src/lib/themePackage";
import {
  appearanceTokens,
  customThemeStyle,
  deckThemeReferences,
  findInstalledTheme,
  isThemeInUse,
  missingThemeWarning,
  referenceKey,
  resolveDeckTheme,
  resolveSectionTheme,
} from "../src/lib/customThemes";
import type { InstalledTheme } from "../src/lib/customThemes";

const source = readFileSync(new URL("./fixtures/theme-packages/midnight-maze.json", import.meta.url), "utf8");
const pkg = parseThemePackageBytes(new TextEncoder().encode(source)) as ThemePackage;
const reference: CustomThemeReference = { id: pkg.id, version: pkg.version, digest: "a".repeat(64) };
const installed: InstalledTheme = { package: pkg, reference, source };
const PAGE = "page_stream";
const FIRST = "page_stream_section";

describe("external theme resolution and safe host tokens", () => {
  it("maps every package color and radius to a host token with no raw style field", () => {
    const tokens = appearanceTokens(pkg.appearance);
    expect(tokens["--bg"]).toBe("#05060c");
    expect(tokens["--surface-2"]).toBe("#111a3a");
    expect(tokens["--tile-surface"]).toBe("#101a38");
    expect(tokens["--section-bg"]).toBe("#05060c");
    expect(tokens["--tile-radius"]).toBe("8px");
    expect(tokens["--section-radius"]).toBe("12px");
    expect(Object.keys(tokens).every((key) => key.startsWith("--"))).toBe(true);
    const style = customThemeStyle(pkg) as Record<string, string>;
    expect(style["--custom-motif-image"]).toContain("data:image/svg+xml");
    expect(JSON.stringify(style)).not.toContain("url(\"https:");
  });

  it("rejects an invalid package instead of emitting arbitrary CSS", () => {
    expect(customThemeStyle({ ...pkg, css: "body{display:none}" } as never)).toBeNull();
    expect(customThemeStyle({ ...pkg, appearance: { ...pkg.appearance, colors: { ...pkg.appearance.colors, bg: "url(https://example.com)" } } } as never)).toBeNull();
  });

  it("matches only the exact id, version and digest and never substitutes another digest", () => {
    expect(findInstalledTheme([installed], reference)?.package).toEqual(pkg);
    const different = { ...reference, digest: "b".repeat(64) };
    expect(findInstalledTheme([installed], different)).toBeNull();
    const deck = setCustomTheme(createDefaultDeck(), different, "dark");
    const resolved = resolveDeckTheme(deck, [installed]);
    expect(resolved.appearance).toBe("dark");
    expect(resolved.missing).toBe(true);
    expect(resolved.custom).toBeNull();
    expect(resolved.style).toEqual({});
  });

  it("resolves deck and section custom appearances from their own references", () => {
    const deck = setSectionCustomTheme(
      setCustomTheme(createDefaultDeck(), reference, "glass"),
      FIRST,
      reference,
      "terminal",
    );
    expect(resolveDeckTheme(deck, [installed]).appearance).toBe("dark");
    const section = deck.pages[0].sections[0];
    expect(resolveSectionTheme(deck, section, [installed])).toMatchObject({
      appearance: "dark", missing: false, motif: "maze",
    });
  });

  it("keeps an explicit built-in section free of the deck's custom overlay", () => {
    const deck = setSectionTheme(setCustomTheme(createDefaultDeck(), reference, "dark"), PAGE, FIRST, "light");
    const section = deck.pages[0].sections[0];
    expect(section.customTheme).toBeUndefined();
    const resolved = resolveSectionTheme(deck, section, [installed]);
    expect(resolved.appearance).toBe("light");
    expect(resolved.custom).toBeNull();
    expect(resolved.missing).toBe(false);
    expect(resolved.style).toEqual({});
  });

  it("reports an unavailable section without falling back to the deck overlay", () => {
    const deck = setSectionCustomTheme(createDefaultDeck(), FIRST, reference, "terminal");
    expect(resolveSectionTheme(deck, deck.pages[0].sections[0], []).missing).toBe(true);
    expect(resolveSectionTheme(deck, deck.pages[0].sections[0], []).custom).toBeNull();
  });

  it("detects in-use references and produces concise recovery text", () => {
    const deck = setSectionCustomTheme(setCustomTheme(createDefaultDeck(), reference, "dark"), FIRST, reference, "glass");
    expect(isThemeInUse(deck, reference)).toBe(true);
    expect(isThemeInUse(deck, { ...reference, digest: "c".repeat(64) })).toBe(false);
    expect(deckThemeReferences(deck)).toEqual([reference, reference]);
    expect(missingThemeWarning(deck, [installed])).toBeNull();
    expect(missingThemeWarning(deck, [])).toContain("midnight-maze 0.1.0");
    expect(missingThemeWarning(createDefaultDeck(), [])).toBeNull();
    expect(referenceKey(reference)).toBe(`${reference.id}@${reference.version}#${reference.digest}`);
  });

  it("clears inline custom properties when a built-in appearance is chosen", () => {
    const properties = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (key: string, value: string) => { properties.set(key, value); },
        removeProperty: (key: string) => { properties.delete(key); },
      },
    };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => null });
    applyTheme("dark", "#4cc9f0", pkg.appearance);
    expect(root.dataset.customTheme).toBe("true");
    expect(properties.get("--bg")).toBe("#05060c");
    expect(properties.get("--custom-motif-image")).toContain("data:image/svg+xml");
    const plain = { ...pkg.appearance, motif: "none" as const };
    expect(appearanceTokens(plain)["--custom-motif-image"]).toBe("none");
    applyTheme("dark", "#4cc9f0", plain);
    expect(properties.get("--custom-motif-image")).toBe("none");
    applyTheme("light", "#6ee7b7");
    expect(root.dataset).toEqual({ theme: "light" });
    expect(properties.has("--bg")).toBe(false);
    expect(properties.has("--tile-radius")).toBe(false);
    expect(properties.get("--accent")).toBe("#6ee7b7");
    vi.unstubAllGlobals();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts only a validated package from an injected adapter", () => {
    expect(validateThemePackage(pkg)).not.toBeNull();
    const bad = { ...installed, package: { ...pkg, author: " padded" } } as InstalledTheme;
    expect(findInstalledTheme([bad], reference)).toBeNull();
  });
});
