import { describe, expect, it } from "vitest";
import {
  INITIAL_DECK_STATE,
  INSTALL_OPTIONS,
  LINKS,
  MINI_DECK_CONTROLS,
  SCENES,
  TRACKS,
  applyMiniControl,
} from "../src/landing/data";

describe("landing data and mini deck", () => {
  it("points GitHub link at ZaneH/zdeck and defines all three OS install tabs", () => {
    expect(LINKS.github).toBe("https://github.com/ZaneH/zdeck");
    expect(INSTALL_OPTIONS.map((o) => o.id)).toEqual(["macos", "linux", "windows"]);
  });

  it("cycles scene, toggles mic and playback, clamps volume, and advances track", () => {
    const byId = (id: string) => MINI_DECK_CONTROLS.find((c) => c.id === id)!;

    let state = applyMiniControl(INITIAL_DECK_STATE, byId("mini-scene"));
    expect(SCENES[state.sceneIndex]).toBe("Desktop");
    expect(state.status).toBe("Scene: Desktop");

    state = applyMiniControl(state, byId("mini-mic"));
    expect(state.micMuted).toBe(true);
    expect(state.status).toBe("Mic muted");

    state = applyMiniControl(state, byId("mini-play"));
    expect(state.playing).toBe(false);

    state = applyMiniControl(state, byId("mini-vol"), 150);
    expect(state.volume).toBe(100);

    state = applyMiniControl(state, byId("mini-spotify"));
    expect(state.playing).toBe(true);
    expect(TRACKS[state.trackIndex]).toBe("Lo-Fi Loop 04");
  });
});
