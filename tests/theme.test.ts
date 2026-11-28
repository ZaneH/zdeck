import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, controlGeometry } from "../src/lib/theme";
import type { Control } from "../src/lib/types";
import { MAX_COLUMN_SPAN, MAX_ROW_SPAN } from "../src/lib/deck";

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

  it("uses white browser chrome for Classic Macintosh and preserves the saved accent", () => {
    const setProperty = vi.fn();
    const setAttribute = vi.fn();
    const root = { dataset: {}, style: { setProperty } };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => ({ setAttribute }) });
    applyTheme("macintosh", "#6ee7b7");
    expect(root.dataset).toEqual({ theme: "macintosh" });
    expect(setProperty).toHaveBeenCalledWith("--accent", "#6ee7b7");
    expect(setAttribute).toHaveBeenCalledWith("content", "#ffffff");
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

  it("keeps Glass sliders narrow and tall for every saved span without changing the control", () => {
    for (const action of ["volume", "plugin"] as const) {
      for (const columnSpan of [undefined, 1, 2, 3, MAX_COLUMN_SPAN]) {
        for (const rowSpan of [undefined, ...Array.from({ length: MAX_ROW_SPAN }, (_, i) => i + 1)]) {
          const control: Control = action === "volume"
            ? { id: "level", action, label: "Level", volume: 64, columnSpan, rowSpan }
            : { id: "level", action, label: "Level", pluginId: "studio", pluginAction: "level", pluginArgs: {}, columnSpan, rowSpan };
          const saved = structuredClone(control);
          expect(controlGeometry(control, "slider", "glass"))
            .toEqual({ columns: 1, rows: Math.max(2, rowSpan ?? 2), shape: "slider" });
          for (const theme of ["dark", "light", "terminal"] as const) {
            expect(controlGeometry(control, "slider", theme))
              .toEqual({ columns: columnSpan ?? 1, rows: rowSpan ?? 1, shape: "tile" });
          }
          // Switching to a button restores stored sizing without the slider constraint.
          expect(controlGeometry(control, "button", "dark"))
            .toEqual({ columns: columnSpan ?? 1, rows: rowSpan ?? 1, shape: "tile" });
          expect(control).toEqual(saved);
        }
      }
    }
  });

  it("gives Glass volume and plugin dials 2×2 modules without losing saved taller/larger spans", () => {
    for (const action of ["volume", "plugin"] as const) {
      for (const columnSpan of [undefined, ...Array.from({ length: MAX_COLUMN_SPAN }, (_, i) => i + 1)]) {
        for (const rowSpan of [undefined, ...Array.from({ length: MAX_ROW_SPAN }, (_, i) => i + 1)]) {
          const control: Control = action === "volume"
            ? { id: "dial", label: "Level", action, volume: 50, columnSpan, rowSpan, presentation: "dial" }
            : { id: "dial", label: "Level", action, pluginId: "studio", pluginAction: "level", pluginArgs: {}, columnSpan, rowSpan, presentation: "dial" };
          const saved = structuredClone(control);
          const columns = Math.max(2, columnSpan ?? 2);
          const rows = Math.max(2, rowSpan ?? 2);
          expect(controlGeometry(control, "dial", "glass"))
            .toEqual({ columns, rows, shape: "module" });
          for (const theme of ["dark", "light", "terminal"] as const) {
            expect(controlGeometry(control, "dial", theme))
              .toEqual({ columns: columnSpan ?? 1, rows: rowSpan ?? 1, shape: "tile" });
          }
          expect(controlGeometry(control, "button", "glass").columns).toBe(columnSpan ?? 1);
          expect(control).toEqual(saved);
        }
      }
    }
  });

  it("keeps classic geometry and saved spans for Dark, Light and Wasteland Terminal", () => {
    for (const theme of ["dark", "light", "terminal", "macintosh"] as const) {
      expect(controlGeometry(play, "button", theme)).toEqual({ columns: 1, rows: 1, shape: "tile" });
      expect(controlGeometry({ ...play, columnSpan: 3, rowSpan: 2 }, "button", theme))
        .toEqual({ columns: 3, rows: 2, shape: "tile" });
    }
    expect(play).not.toHaveProperty("columnSpan");
  });
});
