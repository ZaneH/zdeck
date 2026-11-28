import { describe, expect, it, vi } from "vitest";
import type { Control } from "../src/lib/types";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: vi.fn(),
}));
import { ControlTile } from "../src/components/ControlTile";

const control: Control = { id: "volume", label: "Volume", action: "volume", volume: 50, presentation: "dial" };
const event = (extra = {}) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), target: { closest: () => null }, ...extra });

describe("Native slider gestures", () => {
  it.each(["preview", "live", "remote"] as const)("leaves native thumb capture alone in %s and commits once on release", (semantics) => {
    const commit = vi.fn();
    const tile = ControlTile({ control: { ...control, presentation: "slider" }, variant: "phone", volume: 50,
      semantics, onVolumeCommit: commit });
    const input = tile.props.children[3].props.children[1];
    const currentTarget = { value: "75", setPointerCapture: vi.fn() };
    const pointer = event({ pointerId: 1, button: 0, isPrimary: true, currentTarget });
    input.props.onPointerDown(pointer);
    expect(currentTarget.setPointerCapture).not.toHaveBeenCalled();
    input.props.onChange({ target: currentTarget });
    expect(commit).toHaveBeenCalledTimes(semantics === "live" ? 1 : 0);
    input.props.onPointerUp(pointer);
    input.props.onPointerUp(pointer);
    expect(commit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it("does not commit a cancelled native slider gesture", () => {
    const commit = vi.fn();
    const tile = ControlTile({ control: { ...control, presentation: "slider" }, variant: "phone", volume: 50,
      onVolumeCommit: commit });
    const input = tile.props.children[3].props.children[1];
    const pointer = event({ pointerId: 1, button: 0, isPrimary: true, currentTarget: { value: "75" } });
    input.props.onPointerDown(pointer);
    input.props.onPointerCancel(pointer);
    input.props.onPointerUp(pointer);
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("Glass whole-pill slider gestures", () => {
  const target = () => ({ value: "50", focus: vi.fn(), setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ top: 100, bottom: 300, height: 200 }) });
  const pointer = (currentTarget: ReturnType<typeof target>, clientY: number, extra = {}) =>
    event({ currentTarget, clientY, pointerId: 1, button: 0, isPrimary: true, ...extra });
  const slider = (extra = {}) => ControlTile({ control: { ...control, presentation: "slider" },
    variant: "phone", appearance: "glass", volume: 50, ...extra }).props.children[3].props.children[1];

  it.each(["preview", "live", "remote"] as const)("drags from anywhere on the pill in %s without duplicate release commits", (semantics) => {
    const commit = vi.fn(), change = vi.fn(), input = slider({ semantics, onVolumeCommit: commit, onVolumeChange: change });
    const currentTarget = target(), down = pointer(currentTarget, 200);
    input.props.onPointerDown(down);
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(currentTarget.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    input.props.onPointerMove(pointer(currentTarget, 250));
    input.props.onPointerMove(pointer(currentTarget, 150));
    input.props.onPointerMove(pointer(currentTarget, 150));
    expect(change.mock.calls).toEqual([[25], [75]]);
    expect(commit).toHaveBeenCalledTimes(semantics === "live" ? 2 : 0);
    input.props.onPointerUp(pointer(currentTarget, 150));
    input.props.onPointerUp(pointer(currentTarget, 150));
    expect(commit).toHaveBeenLastCalledWith(75);
    expect(commit).toHaveBeenCalledTimes(semantics === "live" ? 2 : 1);
    expect(currentTarget.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps long phone drags local and sends only the final target on release", () => {
    const commit = vi.fn(), change = vi.fn(), input = slider({ semantics: "remote", onVolumeCommit: commit, onVolumeChange: change }), currentTarget = target();
    input.props.onPointerDown(pointer(currentTarget, 200));
    for (let index = 0; index < 200; index++) input.props.onPointerMove(pointer(currentTarget, 100 + index % 200));
    input.props.onPointerMove(pointer(currentTarget, 154));
    expect(change.mock.calls.length).toBeGreaterThan(100);
    expect(commit).not.toHaveBeenCalled();
    input.props.onPointerUp(pointer(currentTarget, 154));
    expect(commit).toHaveBeenCalledExactlyOnceWith(73);
  });

  it("clamps captured drags outside the pill and rounds to the volume step", () => {
    const change = vi.fn(), input = slider({ onVolumeChange: change }), currentTarget = target();
    input.props.onPointerDown(pointer(currentTarget, 20));
    input.props.onPointerMove(pointer(currentTarget, 600));
    input.props.onPointerMove(pointer(currentTarget, 225));
    expect(change.mock.calls).toEqual([[100], [0], [38]]);
  });

  it.each([false, true])("ignores another pointer (primary=%s) without replacing the original gesture", (isPrimary) => {
    const commit = vi.fn(), input = slider({ onVolumeCommit: commit }), currentTarget = target();
    input.props.onPointerDown(pointer(currentTarget, 200));
    input.props.onPointerDown(pointer(currentTarget, 100, { pointerId: 2, isPrimary }));
    input.props.onPointerMove(pointer(currentTarget, 100, { pointerId: 2, isPrimary: false }));
    input.props.onPointerUp(pointer(currentTarget, 100, { pointerId: 2, isPrimary: false }));
    input.props.onPointerCancel(pointer(currentTarget, 100, { pointerId: 2, isPrimary: false }));
    input.props.onLostPointerCapture(pointer(currentTarget, 100, { pointerId: 2, isPrimary: false }));
    input.props.onPointerMove(pointer(currentTarget, 250));
    input.props.onPointerUp(pointer(currentTarget, 250));
    expect(commit).toHaveBeenCalledExactlyOnceWith(25);
    expect(currentTarget.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["onPointerCancel", "onLostPointerCapture", "onBlur"])("does not commit after %s", (cancel) => {
    const commit = vi.fn(), input = slider({ semantics: "remote", onVolumeCommit: commit }), currentTarget = target();
    input.props.onPointerDown(pointer(currentTarget, 100));
    input.props[cancel](pointer(currentTarget, 100));
    input.props.onPointerMove(pointer(currentTarget, 300));
    input.props.onPointerUp(pointer(currentTarget, 300));
    expect(commit).not.toHaveBeenCalled();
  });

  it("never starts or commits a disabled gesture", () => {
    const commit = vi.fn(), change = vi.fn(), input = slider({ disabled: true, onVolumeCommit: commit, onVolumeChange: change }), currentTarget = target();
    input.props.onPointerDown(pointer(currentTarget, 100));
    input.props.onPointerMove(pointer(currentTarget, 300));
    input.props.onPointerUp(pointer(currentTarget, 300));
    expect(currentTarget.setPointerCapture).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("Phone dial commits", () => {
  it.each([false, true])("keeps dial movement local until release (cancelled=%s)", (cancelled) => {
    const commit = vi.fn();
    const dial = ControlTile({ control, variant: "phone", semantics: "remote", volume: 50,
      onVolumeCommit: commit }).props.children[3].props.children[2];
    const currentTarget = { focus: vi.fn(), setPointerCapture: vi.fn() };
    const pointer = event({ pointerId: 1, isPrimary: true, button: 0, clientY: 200, currentTarget });
    dial.props.onPointerDown(pointer);
    dial.props.onPointerMove({ ...pointer, clientY: 170 });
    expect(commit).not.toHaveBeenCalled();
    if (cancelled) dial.props.onPointerCancel();
    dial.props.onPointerUp(pointer);
    if (cancelled) expect(commit).not.toHaveBeenCalled();
    else expect(commit).toHaveBeenCalledExactlyOnceWith(70);
  });

  it("commits keyboard changes only on key release", () => {
    const commit = vi.fn();
    const dial = ControlTile({ control, variant: "phone", semantics: "remote", volume: 50,
      onVolumeCommit: commit }).props.children[3].props.children[2];
    dial.props.onKeyDown(event({ key: "ArrowUp" }));
    expect(commit).not.toHaveBeenCalled();
    dial.props.onKeyUp(event({ key: "ArrowUp" }));
    expect(commit).toHaveBeenCalledExactlyOnceWith(51);
  });
});

describe("Editor tile interactions", () => {
  it("captures Alt + arrows before nested sliders/dials can change their targets", () => {
    const move = vi.fn();
    const tiles = Array.from({ length: 6 }, (_, index) => ({
      offsetLeft: index % 2 * 110, offsetWidth: 100,
      offsetTop: Math.floor(index / 2) * 106, offsetHeight: 96,
      getBoundingClientRect: () => { throw new Error("Animated bounds must not determine the row"); },
    }));
    const tile = ControlTile({ control, variant: "editor", volume: 50, order: { index: 1, total: 6, move } });
    const key = event({ key: "ArrowDown", altKey: true, ctrlKey: false, metaKey: false,
      currentTarget: { parentElement: { querySelectorAll: () => tiles } } });
    tile.props.onKeyDownCapture(key);
    expect(move).toHaveBeenCalledWith(control.id, 3);
    expect(key.preventDefault).toHaveBeenCalledOnce();
    expect(key.stopPropagation).toHaveBeenCalledOnce();
  });

  it("keeps horizontal arrows as single-slot moves and clamps at the edge", () => {
    const move = vi.fn();
    const tile = ControlTile({ control, variant: "editor", volume: 50, order: { index: 0, total: 3, move } });
    const currentTarget = { parentElement: null };
    tile.props.onKeyDownCapture(event({ key: "ArrowRight", altKey: true, currentTarget }));
    expect(move).toHaveBeenLastCalledWith(control.id, 1);
    tile.props.onKeyDownCapture(event({ key: "ArrowLeft", altKey: true, currentTarget }));
    expect(move).toHaveBeenLastCalledWith(control.id, 0);
  });

  it("captures Editor tile clicks as selection, not a nested target/action gesture", () => {
    const select = vi.fn(), commit = vi.fn();
    const tile = ControlTile({ control, variant: "editor", volume: 50, onPrimary: select, onVolumeCommit: commit,
      order: { index: 0, total: 2, move: vi.fn() } });
    const click = event();
    tile.props.onClickCapture(click);
    expect(click.stopPropagation).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not intercept phone or Live gestures, or reorder disabled tiles", () => {
    const move = vi.fn(), select = vi.fn();
    for (const variant of ["phone", "editor"] as const) {
      const tile = ControlTile({ control, variant, semantics: variant === "phone" ? "preview" : "live", volume: 50, onPrimary: select });
      const click = event();
      tile.props.onClickCapture(click);
      expect(click.stopPropagation).not.toHaveBeenCalled();
    }
    const disabled = ControlTile({ control, variant: "editor", volume: 50, disabled: true, onPrimary: select,
      order: { index: 0, total: 2, move } });
    disabled.props.onClickCapture(event());
    disabled.props.onKeyDownCapture(event({ key: "ArrowDown", altKey: true }));
    expect(select).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });
});
