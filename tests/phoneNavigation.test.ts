import { describe, expect, it } from "vitest";
import {
  classifyPhoneSwipe,
  classifyPhoneVerticalSwipe,
  isPhoneControlTarget,
  phonePageTarget,
  phoneSectionEdges,
  phoneSectionTarget,
} from "../src/components/phoneNavigation";

const control = { closest: (selector: string) => (selector.includes("button") ? {} : null) };
const content = { closest: () => null };
const viewport = { top: 24, bottom: 524 };

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

describe("phone section swipe classification", () => {
  it("maps one deliberate up or down swipe to one section step", () => {
    expect(classifyPhoneVerticalSwipe(8, -120)).toBe(1);
    expect(classifyPhoneVerticalSwipe(-6, 120)).toBe(-1);
  });

  it("ignores short and diagonal gestures", () => {
    expect(classifyPhoneVerticalSwipe(0, -47)).toBe(0);
    expect(classifyPhoneVerticalSwipe(0, 47)).toBe(0);
    expect(classifyPhoneVerticalSwipe(60, -80)).toBe(0);
    expect(classifyPhoneVerticalSwipe(80, -80)).toBe(0);
    expect(classifyPhoneVerticalSwipe(40, -80)).toBe(1);
  });
});

describe("phone section boundaries", () => {
  it("treats a short section as both start and end", () => {
    const edges = phoneSectionEdges({ top: 24, bottom: 420 }, viewport);
    expect(edges).toEqual({ short: true, atStart: true, atEnd: true });
    expect(phoneSectionTarget(1, 3, 1, edges)).toBe(2);
    expect(phoneSectionTarget(1, 3, -1, edges)).toBe(0);
  });

  it("pages down only from the top of a tall section", () => {
    const edges = phoneSectionEdges({ top: 24, bottom: 1200 }, viewport);
    expect(edges).toEqual({ short: false, atStart: true, atEnd: false });
    expect(phoneSectionTarget(1, 3, 1, edges)).toBeNull();
    expect(phoneSectionTarget(1, 3, -1, edges)).toBe(0);
  });

  it("pages up only from the bottom of a tall section", () => {
    const edges = phoneSectionEdges({ top: -676, bottom: 524 }, viewport);
    expect(edges).toEqual({ short: false, atStart: false, atEnd: true });
    expect(phoneSectionTarget(1, 3, 1, edges)).toBe(2);
    expect(phoneSectionTarget(1, 3, -1, edges)).toBeNull();
  });

  it("leaves the middle of a tall section to native scrolling", () => {
    const edges = phoneSectionEdges({ top: -300, bottom: 900 }, viewport);
    expect(edges).toEqual({ short: false, atStart: false, atEnd: false });
    expect(phoneSectionTarget(1, 3, 1, edges)).toBeNull();
    expect(phoneSectionTarget(1, 3, -1, edges)).toBeNull();
  });

  it("never wraps at the first or last section", () => {
    const edges = phoneSectionEdges({ top: 24, bottom: 420 }, viewport);
    expect(phoneSectionTarget(0, 3, -1, edges)).toBeNull();
    expect(phoneSectionTarget(2, 3, 1, edges)).toBeNull();
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
