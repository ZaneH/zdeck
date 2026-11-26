import { beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement } from "react";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: true, setters: [vi.fn(), vi.fn(), vi.fn(), vi.fn()], index: 0, effect: () => {} }));
vi.mock("react", () => ({
  useId: () => "help-id",
  useState: (initial: unknown) => [initial, mocks.setters[mocks.index++]],
  useEffect: (effect: () => void) => { mocks.effect = effect; },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/lib/native", () => ({ nativeAvailable: () => mocks.native }));
import { DesktopPreferencesCard } from "../src/components/DesktopPreferencesCard";
import { HelpTooltip } from "../src/components/HelpTooltip";
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => {
  mocks.index = 0; mocks.native = true;
  mocks.invoke.mockReset().mockResolvedValue(false);
  mocks.setters.forEach(set => set.mockReset());
});
function checkbox(element: ReactElement): ReactElement<{ onChange: (event: unknown) => void }> {
  const children = (element.props as { children: ReactElement[] }).children;
  const row = children[1].props as { children: ReactElement[] };
  const label = row.children[0].props as { children: ReactElement[] };
  return label.children[0] as ReactElement<{ onChange: (event: unknown) => void }>;
}
it("does not offer the preference or invoke IPC in browser mode", () => {
  mocks.native = false;
  expect(DesktopPreferencesCard()).toBeNull();
  mocks.effect();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it("aligns inline help with the checkbox row and opens on hover or focus without a native title", () => {
  const element = DesktopPreferencesCard()!;
  const children = (element.props as { children: ReactElement[] }).children;
  const row = children[1].props as { className: string; children: ReactElement[] };
  expect(row.className).toBe("desktop-close-row");
  expect(children.filter(child => child && (child.props as { role?: string }).role === "status")).toHaveLength(0);
  expect(row.children[0].type).toBe("label");
  const label = row.children[0].props as { children: ReactElement[] };
  expect(label.children[0].type).toBe("input");
  expect(label.children[1].type).toBe("span");
  expect(row.children[1].type).toBe(HelpTooltip);
  const help = HelpTooltip(row.children[1].props as ComponentProps<typeof HelpTooltip>).props as {
    onMouseEnter: () => void; onMouseLeave: () => void; onFocus: () => void;
    onKeyDown: (event: { key: string; stopPropagation: () => void }) => void; children: ReactElement[];
  };
  const trigger = help.children[0].props as { title?: string };
  const tooltip = help.children[1].props as { role: string; "aria-hidden": boolean };
  expect(trigger.title).toBeUndefined();
  expect(tooltip.role).toBe("tooltip");
  expect(tooltip["aria-hidden"]).toBe(true);
  help.onMouseEnter();
  expect(mocks.setters[3]).toHaveBeenLastCalledWith(true);
  help.onMouseLeave();
  expect(mocks.setters[3]).toHaveBeenLastCalledWith(false);
  help.onFocus();
  expect(mocks.setters[3]).toHaveBeenLastCalledWith(true);
  help.onKeyDown({ key: "Escape", stopPropagation() {} });
  expect(mocks.setters[3]).toHaveBeenLastCalledWith(false);
});
it("loads the authoritative native preference", async () => {
  mocks.invoke.mockResolvedValue(true);
  DesktopPreferencesCard(); mocks.effect(); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("desktop_close_to_tray");
  expect(mocks.setters[0]).toHaveBeenCalledWith(true);
});
it("reports load failure without blocking the rest of Settings", async () => {
  mocks.invoke.mockRejectedValue("Cannot read settings");
  DesktopPreferencesCard(); mocks.effect(); await flush();
  expect(mocks.setters[2]).toHaveBeenCalledWith("Cannot read settings");
  expect(mocks.setters[1]).toHaveBeenLastCalledWith(false);
});
it("only changes the checkbox after native save succeeds", async () => {
  mocks.invoke.mockResolvedValue(true);
  const element = DesktopPreferencesCard()!;
  checkbox(element).props.onChange({ target: { checked: true } });
  expect(mocks.setters[0]).not.toHaveBeenCalled();
  await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("desktop_set_close_to_tray", { enabled: true });
  expect(mocks.setters[0]).toHaveBeenCalledWith(true);
});
it("does not claim success after a failed save", async () => {
  mocks.invoke.mockRejectedValue("Disk full");
  checkbox(DesktopPreferencesCard()!).props.onChange({ target: { checked: true } });
  await flush();
  expect(mocks.setters[0]).not.toHaveBeenCalled();
  expect(mocks.setters[2]).toHaveBeenLastCalledWith("Preference was not saved. Disk full");
});
