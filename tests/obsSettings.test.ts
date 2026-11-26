import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { ObsConsole } from "../src/lib/useObsConsole";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => () => void)[] }));
const ipc = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), forget: vi.fn() }));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
  useEffect(effect: () => () => void) { hooks.effects.push(effect); },
}));
vi.mock("../src/lib/native", () => ({ obsLoadPreferences: ipc.load, obsSavePreferences: ipc.save, obsForgetPreferences: ipc.forget }));
import { ObsSettingsCard } from "../src/components/ObsSettingsCard";

type Node = ReactElement<Record<string, any>>;
function find(node: ReactNode, predicate: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as Node;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function render(obs: ObsConsole) { hooks.cursor = 0; return ObsSettingsCard({ obs }); }
function button(obs: ObsConsole, label: string) {
  return find(render(obs), node => node.type === "button" && node.props.children === label)!.props;
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let obs: ObsConsole;
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = [];
  vi.resetAllMocks();
  ipc.load.mockResolvedValue(null); ipc.save.mockResolvedValue(undefined); ipc.forget.mockResolvedValue(undefined);
  obs = { native: true, status: "disconnected", snapshot: null, currentScene: null,
    error: null, connect: vi.fn().mockResolvedValue(true), disconnect: vi.fn(), refresh: vi.fn() } as unknown as ObsConsole;
});

it("restores saved inputs on remount, without automatically connecting", async () => {
  const saved = { port: 4466, password: "test password" };
  ipc.load.mockResolvedValue(saved);
  for (let mount = 0; mount < 2; mount++) {
    hooks.values = []; hooks.effects = [];
    render(obs);
    expect(button(obs, "Connect").disabled).toBe(true);
    const cleanup = hooks.effects[0]();
    await flush();
    expect(hooks.values.slice(0, 2)).toEqual([saved.port, saved.password]);
    expect(button(obs, "Connect").disabled).toBe(false);
    cleanup();
  }
  expect(obs.connect).not.toHaveBeenCalled();
});

it("saves only successful connections and keeps save failures visible", async () => {
  render(obs); hooks.effects[0](); await flush();
  hooks.values[0] = 4466; hooks.values[1] = "test password";
  vi.mocked(obs.connect).mockResolvedValueOnce(false);
  await button(obs, "Connect").onClick(); await flush();
  expect(ipc.save).not.toHaveBeenCalled();
  ipc.save.mockRejectedValue(new Error("secret store failure"));
  button(obs, "Connect").onClick(); await flush();
  expect(ipc.save).toHaveBeenCalledWith(4466, "test password");
  expect(hooks.values[3]).toContain("Connected, but could not save");
  expect(hooks.values[1]).toBe("test password");
});

it("allows manual connection after load failure and ignores a reply after unmount", async () => {
  ipc.load.mockRejectedValueOnce(new Error("locked"));
  render(obs); hooks.effects[0](); await flush();
  expect(button(obs, "Connect").disabled).toBe(false);
  expect(hooks.values[3]).toContain("You can still connect manually");
  let resolve!: (value: unknown) => void;
  ipc.load.mockReturnValue(new Promise(done => { resolve = done; }));
  hooks.values = []; hooks.effects = [];
  render(obs); const cleanup = hooks.effects[0](); cleanup();
  resolve({ port: 4466, password: "late" }); await flush();
  expect(hooks.values.slice(0, 2)).toEqual([4455, ""]);
});

it("forgets saved details only after deletion succeeds", async () => {
  ipc.load.mockResolvedValue({ port: 4466, password: "test password" });
  render(obs); hooks.effects[0](); await flush();
  ipc.forget.mockRejectedValueOnce(new Error("locked"));
  button(obs, "Forget saved connection").onClick(); await flush();
  expect(hooks.values.slice(0, 2)).toEqual([4466, "test password"]);
  expect(hooks.values[3]).toContain("may still be in secure storage");
  button(obs, "Forget saved connection").onClick(); await flush();
  expect(hooks.values.slice(0, 2)).toEqual([4455, ""]);
});
