import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, controlGeometry } from "../src/lib/theme";
import type { Control } from "../src/lib/types";

const play: Control = { id: "play", action: "media-play-pause", label: "Play / pause" };
const scene: Control = { id: "scene", action: "obs-scene", label: "Screen w Cam", scene: "Camera" };

describe("theme application", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses graphite browser chrome for Glass without replacing the user's accent", () => {
    const setProperty = vi.fn();
    const setAttribute = vi.fn();
    const root = { dataset: { theme: "light" }, style: { setProperty } };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => ({ setAttribute }) });
    applyTheme("glass", "#6ee7b7");
    expect(root.dataset.theme).toBe("glass");
    expect(setProperty).toHaveBeenCalledWith("--accent", "#6ee7b7");
    expect(setAttribute).toHaveBeenCalledWith("content", "#15171b");
  });

  it("still applies a theme when the optional theme-color meta is absent", () => {
    const root = { dataset: {}, style: { setProperty: vi.fn() } };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => null });
    expect(() => applyTheme("glass", "#4cc9f0")).not.toThrow();
    expect(root.dataset).toEqual({ theme: "glass" });
  });
});

describe("theme-owned control geometry", () => {
  it("uses a capsule for automatic media sizing, but an icon-only circle for a saved one-cell button", () => {
    expect(controlGeometry(play, "button", "glass")).toEqual({ columns: 2, rows: 1, shape: "capsule" });
    expect(controlGeometry({ ...play, columnSpan: 1, rowSpan: 1 }, "button", "glass"))
      .toEqual({ columns: 1, rows: 1, shape: "circle" });
  });

  it("derives shapes from saved dimensions, not action names", () => {
    expect(controlGeometry(scene, "button", "glass")).toEqual({ columns: 2, rows: 2, shape: "module" });
    expect(controlGeometry({ ...scene, columnSpan: 1, rowSpan: 1 }, "button", "glass").shape).toBe("circle");
    expect(controlGeometry({ ...scene, columnSpan: 2, rowSpan: 1 }, "button", "glass").shape).toBe("capsule");
    const mic: Control = { id: "mic", action: "mic-mute", label: "Microphone", columnSpan: 2, rowSpan: 2 };
    expect(controlGeometry(mic, "button", "glass").shape).toBe("module");
  });

  it("keeps classic geometry and saved spans for Dark, Light and Wasteland Terminal", () => {
    for (const theme of ["dark", "light", "terminal"] as const) {
      expect(controlGeometry(play, "button", theme)).toEqual({ columns: 1, rows: 1, shape: "tile" });
      expect(controlGeometry({ ...play, columnSpan: 3, rowSpan: 2 }, "button", theme))
        .toEqual({ columns: 3, rows: 2, shape: "tile" });
    }
    expect(play).not.toHaveProperty("columnSpan");
  });
});
