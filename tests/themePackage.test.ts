import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_THEME_PACKAGE_BYTES, THEME_COLOR_KEYS, parseThemePackageBytes,
  validateCustomThemeReference, validateThemePackage,
} from "../src/lib/themePackage";

const sampleUrl = new URL("./fixtures/theme-packages/midnight-maze.json", import.meta.url);
const sample = readFileSync(sampleUrl);
const valid = parseThemePackageBytes(sample);
const clone = () => JSON.parse(sample.toString("utf8"));
const invalid = (mutate: (value: any) => void) => {
  const value = clone();
  mutate(value);
  return validateThemePackage(value);
};

describe("theme package format foundation", () => {
  it("parses the shared Midnight Maze bytes and the packaged sample", () => {
    expect(valid).not.toBeNull();
    expect(valid).toMatchObject({
      schema: 1, kind: "zdeck-theme", id: "midnight-maze", version: "0.1.0",
      name: "Midnight Maze", author: "Zane Helton", license: "MIT",
      source: "https://github.com/ZaneH/zdeck",
      appearance: { base: "dark", motif: "maze", tileRadius: 8, sectionRadius: 12 },
    });
    expect(valid!.appearance.colors).toMatchObject({ maze: "#3158ff", pellet: "#ffe34b", tileSurface: "#101a38" });
    expect(Object.keys(valid!.appearance.colors).sort()).toEqual([...THEME_COLOR_KEYS].sort());
    expect(valid).not.toHaveProperty("digest");
    const packaged = readFileSync(new URL("../packages/themes/midnight-maze.zdeck-theme.json", import.meta.url));
    expect(packaged.equals(sample)).toBe(true);
    expect(parseThemePackageBytes(packaged)).toEqual(valid);
  });

  it("enforces the exact 16 KiB byte budget before parsing", () => {
    const capped = new Uint8Array(MAX_THEME_PACKAGE_BYTES);
    capped.set(sample);
    capped.fill(0x20, sample.length);
    expect(parseThemePackageBytes(capped)).not.toBeNull();
    expect(parseThemePackageBytes(new Uint8Array([...capped, 0x20]))).toBeNull();
    expect(parseThemePackageBytes(new Uint8Array(sample.length + MAX_THEME_PACKAGE_BYTES))).toBeNull();
  });

  it("rejects BOM, invalid UTF-8 and malformed JSON", () => {
    expect(parseThemePackageBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...sample]))).toBeNull();
    expect(parseThemePackageBytes(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeNull();
    expect(parseThemePackageBytes(new TextEncoder().encode("{}"))).toBeNull();
    expect(parseThemePackageBytes(new TextEncoder().encode("not json"))).toBeNull();
    expect(parseThemePackageBytes(new TextEncoder().encode(JSON.stringify(clone()) + " x"))).toBeNull();
  });

  it("rejects duplicate JSON keys, including escaped and nested keys", () => {
    const raw = sample.toString("utf8");
    for (const text of [
      raw.replace('"name":', '"name":"Hidden", "name":'),
      raw.replace('"name":', '"na\\u006de":"Hidden", "name":'),
      raw.replace('"bg":', '"bg":"#ffffff", "bg":'),
    ]) expect(parseThemePackageBytes(new TextEncoder().encode(text))).toBeNull();
    const value = clone();
    value.name = 'Braces { }, commas, and escaped "quotes"';
    expect(parseThemePackageBytes(new TextEncoder().encode(JSON.stringify(value)))).not.toBeNull();
  });

  it("rejects unpaired surrogate escapes but allows non-BMP metadata", () => {
    for (const name of ["\ud800", "\udfff", "a\ud800b"]) {
      expect(invalid(value => { value.name = name; })).toBeNull();
    }
    expect(invalid(value => { value.name = "Maze 🎮"; })).not.toBeNull();
  });

  it("rejects unknown fields at every object, including CSS and digest additions", () => {
    expect(invalid((value) => { value.digest = "a".repeat(64); })).toBeNull();
    expect(invalid((value) => { value.css = "body { display: none }"; })).toBeNull();
    expect(invalid((value) => { value.appearance.css = "body { display: none }"; })).toBeNull();
    expect(invalid((value) => { value.appearance.backgroundImage = "url(https://example.com/a.png)"; })).toBeNull();
    expect(invalid((value) => { value.appearance.colors.background = "#000000"; })).toBeNull();
    expect(invalid((value) => { delete value.appearance.colors.maze; })).toBeNull();
    expect(invalid((value) => { delete value.source; })).toBeNull();
  });

  it("rejects wrong types, nulls, arrays, control characters and unknown enums", () => {
    for (const key of ["kind", "id", "version", "name", "author", "license", "source"]) {
      expect(invalid((value) => { value[key] = null; })).toBeNull();
      expect(invalid((value) => { value[key] = []; })).toBeNull();
    }
    expect(invalid((value) => { value.schema = "1"; })).toBeNull();
    expect(invalid((value) => { value.schema = 2; })).toBeNull();
    expect(invalid((value) => { value.appearance = null; })).toBeNull();
    expect(invalid((value) => { value.appearance.colors = []; })).toBeNull();
    expect(invalid((value) => { value.appearance.base = "midnight"; })).toBeNull();
    expect(invalid((value) => { value.appearance.motif = "grid"; })).toBeNull();
    expect(invalid((value) => { value.name = "tab\t"; })).toBeNull();
    expect(invalid((value) => { value.name = " padded"; })).toBeNull();
    expect(invalid((value) => { value.name = "trailing "; })).toBeNull();
    expect(invalid((value) => { value.name = "\uFEFFmaze"; })).toBeNull();
    expect(invalid((value) => { value.name = "maze\uFEFF"; })).toBeNull();
  });

  it("allows only the five built-in bases, safe motifs and lowercase six-digit hex colors", () => {
    for (const base of ["dark", "light", "glass", "terminal", "macintosh"]) {
      expect(invalid((value) => { value.appearance.base = base; })).not.toBeNull();
    }
    for (const motif of ["none", "maze"]) {
      expect(invalid((value) => { value.appearance.motif = motif; })).not.toBeNull();
    }
    for (const color of ["red", "#fff", "#FFFFFF", "#12345g", "url(https://example.com/a.png)", "--accent", null]) {
      expect(invalid((value) => { value.appearance.colors.bg = color; })).toBeNull();
    }
  });

  it("validates integer radii consistently with Rust and rejects nonfinite or out-of-bounds values", () => {
    for (const radius of [0, 32]) {
      expect(invalid((value) => {
        value.appearance.tileRadius = radius;
        value.appearance.sectionRadius = radius;
      })).not.toBeNull();
    }
    const text = sample.toString("utf8");
    expect(parseThemePackageBytes(new TextEncoder().encode(text.replace('"tileRadius": 8', '"tileRadius": 8.0')))).not.toBeNull();
    expect(parseThemePackageBytes(new TextEncoder().encode(text.replace('"schema": 1', '"schema": 1.0')))).not.toBeNull();
    for (const radius of [-1, 33, 1.5, Infinity, -Infinity, NaN, "8", null, true]) {
      expect(invalid((value) => { value.appearance.tileRadius = radius; })).toBeNull();
      expect(invalid((value) => { value.appearance.sectionRadius = radius; })).toBeNull();
    }
    expect(invalid((value) => { value.appearance.tileRadius = Number.MAX_SAFE_INTEGER + 1; })).toBeNull();
  });

  it("validates IDs and three-part versions", () => {
    for (const id of ["a", "midnight-maze", "a0", "a".repeat(64)]) {
      expect(invalid((value) => { value.id = id; })).not.toBeNull();
    }
    for (const id of ["", "0maze", "Maze", "a".repeat(65), "../maze", "mid_night"]) {
      expect(invalid((value) => { value.id = id; })).toBeNull();
    }
    for (const version of ["0.0.0", "1.2.3", "9999.0.9999"]) {
      expect(invalid((value) => { value.version = version; })).not.toBeNull();
    }
    for (const version of ["1.2", "1.2.3.4", "00001.1.1", "1.2.x", "1.2.-3", 1, null]) {
      expect(invalid((value) => { value.version = version; })).toBeNull();
    }
  });

  it("counts UTF-8 bytes for metadata and enforces each field's limit", () => {
    expect(invalid((value) => { value.name = "é".repeat(40); })).not.toBeNull(); // 80 bytes
    expect(invalid((value) => { value.name = "a".repeat(80); })).not.toBeNull();
    expect(invalid((value) => { value.name = "é".repeat(41); })).toBeNull(); // 82 bytes
    expect(invalid((value) => { value.name = "a".repeat(81); })).toBeNull();
    expect(invalid((value) => { value.author = "é".repeat(80); })).not.toBeNull(); // 160 bytes
    expect(invalid((value) => { value.author = "é".repeat(81); })).toBeNull();
    expect(invalid((value) => { value.license = "é".repeat(40); })).not.toBeNull();
    expect(invalid((value) => { value.license = "é".repeat(41); })).toBeNull();
    expect(invalid((value) => { value.source = "é".repeat(256); })).not.toBeNull(); // 512 bytes
    expect(invalid((value) => { value.source = "é".repeat(257); })).toBeNull();
  });

  it("validates exact custom theme references separately", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(validateCustomThemeReference({ id: "midnight-maze", version: "0.1.0", digest }))
      .toEqual({ id: "midnight-maze", version: "0.1.0", digest });
    for (const bad of [
      null, [], {}, { id: "midnight-maze", version: "0.1.0" },
      { id: "midnight-maze", version: "0.1.0", digest, extra: true },
      { id: "midnight-maze", version: "0.1.0", digest: digest.toUpperCase() },
      { id: "midnight-maze", version: "0.1.0", digest: digest.slice(1) },
      { id: "../maze", version: "0.1.0", digest },
      { id: "midnight-maze", version: "1.0", digest },
      { id: "midnight-maze", version: "0.1.0", digest: 1 },
    ]) expect(validateCustomThemeReference(bad)).toBeNull();
  });
});
