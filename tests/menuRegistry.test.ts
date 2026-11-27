import { describe, expect, it, vi } from "vitest";
import { registerOpenMenu, unregisterOpenMenu } from "../src/lib/menuRegistry";

describe("application menu registry", () => {
  it("dismisses the previous menu when another opens", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerOpenMenu(first);
    registerOpenMenu(second);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    unregisterOpenMenu(second);
  });

  it("does not dismiss a menu that is no longer registered", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerOpenMenu(first);
    unregisterOpenMenu(first);
    registerOpenMenu(second);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    unregisterOpenMenu(second);
  });
});
