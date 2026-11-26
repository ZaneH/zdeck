import { describe, expect, it } from "vitest";
import {
  classifyPhoneSwipe,
  isPhoneControlTarget,
  phonePageTarget,
} from "../src/components/phoneNavigation";

const control = { closest: (selector: string) => (selector.includes("button") ? {} : null) };
const content = { closest: () => null };

describe("phone page swipe classification", () => {
  it("turns a clear horizontal drag into one page step", () => {
    expect(classifyPhoneSwipe(-120, 8)).toBe(1);
    expect(classifyPhoneSwipe(120, -8)).toBe(-1);
  });

  it("ignores short taps and drags", () => {
    expect(classifyPhoneSwipe(47, 0)).toBe(0);
    expect(classifyPhoneSwipe(-20, 4)).toBe(0);
  });

  it("ignores diagonal scroll gestures", () => {
    expect(classifyPhoneSwipe(-80, 60)).toBe(0);
    expect(classifyPhoneSwipe(-80, 80)).toBe(0);
    expect(classifyPhoneSwipe(-80, 40)).toBe(1);
  });
});

describe("phone gesture start targets", () => {
  it("keeps controls and missing targets out of page swipes", () => {
    expect(isPhoneControlTarget(control as unknown as EventTarget)).toBe(true);
    expect(isPhoneControlTarget(null)).toBe(true);
    expect(isPhoneControlTarget({} as EventTarget)).toBe(true);
  });

  it("allows a swipe that starts on page content", () => {
    expect(isPhoneControlTarget(content as unknown as EventTarget)).toBe(false);
  });
});

describe("phone page targets", () => {
  const pages = ["a", "b", "c"];
  it("moves one page without wrapping at either end", () => {
    expect(phonePageTarget(pages, "a", 1)).toBe("b");
    expect(phonePageTarget(pages, "b", -1)).toBe("a");
    expect(phonePageTarget(pages, "c", 1)).toBeNull();
    expect(phonePageTarget(pages, "a", -1)).toBeNull();
  });

  it("ignores an unknown current page", () => {
    expect(phonePageTarget(pages, "missing", 1)).toBeNull();
  });
});
