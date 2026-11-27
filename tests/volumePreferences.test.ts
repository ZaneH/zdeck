import { describe, expect, it } from "vitest";
import { loadVolumes, saveVolumes } from "../src/lib/volumePreferences";

describe("volume preferences", () => {
  it("restores explicit values across sessions, including mute and maximum", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    expect(loadVolumes(storage)).toEqual({ value: {}, error: null });
    const value = { speakers: 73, muted: 0, loud: 100 };
    expect(saveVolumes(storage, value)).toBe(true);
    expect(loadVolumes(storage)).toEqual({ value, error: null });
    expect([...data.keys()]).toEqual(["deck.volumes.v1"]);
  });

  it.each(["invalid", "null", "[]", '{"speaker":101}', '{"speaker":-1}', '{"speaker":2.5}', '{"speaker":"50"}'])("ignores corrupt preferences without blocking launch: %s", raw => {
    expect(loadVolumes({ getItem: () => raw, setItem() {} })).toEqual({ value: {}, error: expect.any(String) });
  });

  it("reports unavailable storage and failed saves", () => {
    const blocked = { getItem(): string { throw Error("blocked"); }, setItem() { throw Error("full"); } };
    for (const storage of [null, blocked]) {
      expect(loadVolumes(storage).error).toBeTruthy();
      expect(saveVolumes(storage, { speakers: 70 })).toBe(false);
    }
  });
});
