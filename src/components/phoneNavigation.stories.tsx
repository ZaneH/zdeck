import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";
import { PhoneSectionNav, usePhoneNavigation } from "./phoneNavigation";

function NavigationFixture({ tall = false }: { tall?: boolean }) {
  const scrollerRef = useRef<HTMLElement>(null);
  const [pageId, setPageId] = useState("a");
  const navigation = usePhoneNavigation({
    pageId, pageIds: ["a", "b"], sectionIds: ["one", "two", "three"],
    onPageChange: setPageId, scrollerRef,
  });
  return <div data-page={pageId} data-section-index={navigation.sectionIndex}>
    <main ref={scrollerRef} {...navigation.pagerProps} aria-label="Swipe sections" style={{
      width: 360, height: 400, boxSizing: "border-box", overflowY: "auto",
      display: "flex", flexDirection: "column", touchAction: "pan-y", overscrollBehavior: "contain",
      // Like both phone callers, section appearance changes the scroller's layout.
      padding: navigation.sectionIndex === 1 ? 28 : 16,
      gap: navigation.sectionIndex === 1 ? 22 : 18,
      background: navigation.sectionIndex === 1 ? "#eee" : "#234",
    }}>
      {["one", "two", "three"].map((id, index) => <section key={id} data-phone-section={id}
        style={{ height: tall && index === 1 ? 1000 : 320, flexShrink: 0 }}>
        <h2 className="section-heading">{id}</h2>
        <button type="button">Action {id}</button>
        <input type="range" aria-label={`Volume ${id}`} />
        <div role="slider" aria-label={`Custom slider ${id}`} aria-valuenow={50} tabIndex={0}>Slider</div>
        <div className="control-tile">Tile {id}</div>
      </section>)}
      <div aria-hidden="true" style={{ height: 400, flexShrink: 0 }} />
    </main>
    <PhoneSectionNav count={3} index={navigation.sectionIndex} onSelect={navigation.goToSection}
      announcement={navigation.announcement} />
  </div>;
}

const meta = {
  title: "Phone/Navigation",
  component: NavigationFixture,
  parameters: { layout: "centered" },
} satisfies Meta<typeof NavigationFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

function touch(target: Element, type: string, x: number, y: number, count = type === "touchend" || type === "touchcancel" ? 0 : 1) {
  const point = new Touch({ identifier: 1, target, clientX: x, clientY: y });
  const event = new TouchEvent(type, {
    bubbles: true, cancelable: true,
    touches: Array.from({ length: count }, (_, identifier) => new Touch({ identifier, target, clientX: x, clientY: y })),
    changedTouches: [point],
  });
  target.dispatchEvent(event);
  return event;
}

function pointer(target: Element, type: string, x: number, y: number, pointerId = 1) {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId, pointerType: "touch", isPrimary: true, clientX: x, clientY: y,
  }));
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function elements(canvas: HTMLElement) {
  const main = canvas.querySelector<HTMLElement>("main")!;
  const shell = main.parentElement!;
  const sections = Array.from(main.querySelectorAll<HTMLElement>("[data-phone-section]"));
  const atSection = async (index: number) => {
    await waitFor(() => {
      expect(shell.dataset.sectionIndex).toBe(String(index));
      const top = main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop);
      expect(Math.abs(sections[index].getBoundingClientRect().top - top)).toBeLessThanOrEqual(1);
    });
    await frame();
    await frame();
    expect(shell.dataset.sectionIndex).toBe(String(index));
  };
  return { main, shell, sections, atSection };
}

export const SequentialSwipes: Story = {
  play: async ({ canvasElement }) => {
    const { main, shell, atSection } = elements(canvasElement);
    const changes: string[] = [];
    const observer = new MutationObserver((records) => {
      changes.push(...records.map((record) => record.oldValue!));
    });
    observer.observe(shell, { attributes: true, attributeFilter: ["data-section-index"], attributeOldValue: true });
    try {
      for (const index of [1, 2, 1, 0, 1, 0]) {
        const before = shell.dataset.sectionIndex!;
        const dy = index > Number(before) ? -120 : 120;
        pointer(main, "pointerdown", 100, 200);
        touch(main, "touchstart", 100, 200);
        expect(touch(main, "touchmove", 100, 200 + dy).defaultPrevented).toBe(true);
        // A browser can cancel the pointer stream without cancelling the touch stream.
        pointer(main, "pointercancel", 100, 200 + dy);
        await frame();
        expect(shell.dataset.sectionIndex).toBe(before);
        touch(main, "touchend", 100, 200 + dy);
        await atSection(index);
        changes.push(`settled:${index}`);
      }
      expect(changes).toEqual([
        "0", "settled:1", "1", "settled:2", "2", "settled:1",
        "1", "settled:0", "0", "settled:1", "1", "settled:0",
      ]);
      expect(shell.dataset.page).toBe("a");
    } finally {
      observer.disconnect();
    }
  },
};

export const CancelledAndControlGestures: Story = {
  play: async ({ canvasElement }) => {
    const { main, shell, atSection } = elements(canvasElement);
    pointer(main, "pointerdown", 200, 200);
    pointer(main, "pointercancel", 100, 200);
    pointer(main, "pointerup", 60, 200);
    expect(shell.dataset.page).toBe("a");
    pointer(main, "pointerdown", 200, 200, 1);
    pointer(main, "pointerup", 60, 200, 2);
    expect(shell.dataset.page).toBe("a");

    touch(main, "touchstart", 100, 200);
    touch(main, "touchmove", 100, 80);
    touch(main, "touchcancel", 100, 80);
    touch(main, "touchend", 100, 80);
    await atSection(0);
    touch(main, "touchstart", 100, 200);
    touch(main, "touchmove", 100, 80, 2);
    touch(main, "touchend", 100, 80);
    await atSection(0);

    for (const target of main.querySelectorAll("button, input, [role=slider], .control-tile")) {
      pointer(target, "pointerdown", 200, 200);
      touch(target, "touchstart", 100, 200);
      expect(touch(target, "touchmove", 100, 80).defaultPrevented).toBe(false);
      touch(target, "touchend", 100, 80);
      pointer(target, "pointerup", 60, 200);
      await atSection(0);
      expect(shell.dataset.page).toBe("a");
    }
    touch(main, "touchstart", 100, 200);
    touch(main, "touchmove", 100, 180);
    touch(main, "touchend", 100, 180);
    await atSection(0);

    // Cancelled sequences do not poison subsequent vertical or horizontal gestures.
    touch(main, "touchstart", 100, 200);
    touch(main, "touchmove", 100, 80);
    touch(main, "touchend", 100, 80);
    await atSection(1);
    pointer(main, "pointerdown", 200, 200);
    pointer(main, "pointerup", 60, 200);
    await waitFor(() => expect(shell.dataset.page).toBe("b"));
    await waitFor(() => expect(main.scrollTop).toBe(0));
    expect(shell.dataset.sectionIndex).toBe("0");
  },
};

export const TallSection: Story = {
  args: { tall: true },
  play: async ({ canvasElement }) => {
    const { main, shell, sections, atSection } = elements(canvasElement);
    canvasElement.querySelector<HTMLButtonElement>('[aria-label="Next section"]')!.click();
    await atSection(1);
    touch(main, "touchstart", 100, 200);
    expect(touch(main, "touchmove", 100, 80).defaultPrevented).toBe(false);
    // Synthetic touches have no native default action; model the browser's scroll explicitly.
    main.scrollTop += 180;
    await frame();
    touch(main, "touchend", 100, 80);
    await frame();
    expect(shell.dataset.sectionIndex).toBe("1");
    for (const dy of [-120, 120]) {
      touch(main, "touchstart", 100, 200);
      expect(touch(main, "touchmove", 100, 200 + dy).defaultPrevented).toBe(false);
      touch(main, "touchend", 100, 200 + dy);
      await frame();
      expect(shell.dataset.sectionIndex).toBe("1");
    }
    touch(main, "touchstart", 100, 200);
    expect(touch(main, "touchmove", 100, 80).defaultPrevented).toBe(false);
    main.scrollTop += sections[2].getBoundingClientRect().top
      - main.getBoundingClientRect().top - parseFloat(getComputedStyle(main).paddingTop);
    await frame();
    await frame();
    expect(shell.dataset.sectionIndex).toBe("1");
    touch(main, "touchcancel", 100, 80);
    await waitFor(() => expect(shell.dataset.sectionIndex).toBe("2"));
    canvasElement.querySelector<HTMLButtonElement>('[aria-label="Previous section"]')!.click();
    await atSection(1);

    main.scrollTop += sections[1].getBoundingClientRect().bottom
      - (main.getBoundingClientRect().bottom - parseFloat(getComputedStyle(main).paddingBottom));
    await frame();
    touch(main, "touchstart", 100, 200);
    expect(touch(main, "touchmove", 100, 80).defaultPrevented).toBe(true);
    touch(main, "touchend", 100, 80);
    await atSection(2);
    touch(main, "touchstart", 100, 200);
    expect(touch(main, "touchmove", 100, 320).defaultPrevented).toBe(true);
    touch(main, "touchend", 100, 320);
    await atSection(1);
    touch(main, "touchstart", 100, 200);
    expect(touch(main, "touchmove", 100, 320).defaultPrevented).toBe(true);
    touch(main, "touchend", 100, 320);
    await atSection(0);
  },
};
