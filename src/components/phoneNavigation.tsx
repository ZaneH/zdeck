import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

const SWIPE_MIN = 48;
const SWIPE_RATIO = 1.5;
const EDGE_SLOP = 4;

/** Swipe left -> next page (1), right -> previous (-1); short or diagonal drags are ignored. */
export function classifyPhoneSwipe(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) <= Math.abs(dy) * SWIPE_RATIO) return 0;
  return dx < 0 ? 1 : -1;
}

/** Swipe up -> next section (1), down -> previous (-1); glancing drags are ignored. */
export function classifyPhoneVerticalSwipe(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dy) < SWIPE_MIN || Math.abs(dy) <= Math.abs(dx) * SWIPE_RATIO) return 0;
  return dy < 0 ? 1 : -1;
}

export interface PhoneSectionEdges {
  short: boolean;
  atStart: boolean;
  atEnd: boolean;
}

/** Section edges in scroller-content coordinates; short sections count as both ends. */
export function phoneSectionEdges(
  section: { top: number; bottom: number },
  viewport: { top: number; bottom: number },
): PhoneSectionEdges {
  const short = section.bottom - section.top <= viewport.bottom - viewport.top + EDGE_SLOP;
  return {
    short,
    atStart: short || section.top >= viewport.top - EDGE_SLOP,
    atEnd: short || section.bottom <= viewport.bottom + EDGE_SLOP,
  };
}

/** One section step in the gesture direction; null at edges so sections never wrap. */
export function phoneSectionTarget(
  index: number,
  count: number,
  direction: -1 | 1,
  edges: Pick<PhoneSectionEdges, "atStart" | "atEnd">,
): number | null {
  if (direction === 1) return edges.atEnd && index + 1 < count ? index + 1 : null;
  return edges.atStart && index > 0 ? index - 1 : null;
}

/** True when a gesture starts on a control that owns its own drag/click behavior. */
export function isPhoneControlTarget(target: EventTarget | null): boolean {
  const node = target as { closest?: (selector: string) => unknown } | null;
  return (
    !node ||
    typeof node.closest !== "function" ||
    Boolean(
      node.closest(
        "button, a, input, select, textarea, label, dialog, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='button'], [role='switch'], .control-tile, .dial-face",
      ),
    )
  );
}

/** Target page for a swipe delta; null at either end so pages never wrap. */
export function phonePageTarget(
  pageIds: string[],
  pageId: string,
  delta: number,
): string | null {
  const index = pageIds.indexOf(pageId);
  if (index < 0) return null;
  return pageIds[index + delta] ?? null;
}

interface PhoneNavigationOptions {
  pageId: string;
  pageIds: string[];
  sectionIds: string[];
  onPageChange: (pageId: string) => void;
  scrollerRef: RefObject<HTMLElement | null>;
}

export function usePhoneNavigation({
  pageId,
  pageIds,
  sectionIds,
  onPageChange,
  scrollerRef,
}: PhoneNavigationOptions) {
  const [sectionIndex, setSectionIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const start = useRef<{ x: number; y: number } | null>(null);
  const touchStart = useRef<{
    x: number;
    y: number;
    index: number;
    count: number;
    edges: PhoneSectionEdges;
  } | null>(null);
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const sectionKey = sectionIds.join("|");

  // A page change resets the section position; deck snapshots on the same page do not.
  useEffect(() => {
    setSectionIndex(0);
    setAnnouncement("");
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [pageId, scrollerRef]);

  useEffect(() => {
    setSectionIndex((current) =>
      Math.min(current, Math.max(0, sectionIds.length - 1)),
    );
  }, [sectionKey]);

  // Follow the section the user actually scrolled to, without scrolling anything.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + parseFloat(getComputedStyle(scroller).paddingTop);
      let nearest = 0;
      scroller.querySelectorAll<HTMLElement>("[data-phone-section]").forEach((el, index) => {
        if (el.getBoundingClientRect().top <= top + 4) nearest = index;
      });
      setSectionIndex((current) => (current === nearest ? current : nearest));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sectionKey, scrollerRef]);

  const goToSection = useCallback(
    (index: number) => {
      const scroller = scrollerRef.current;
      const sections = scroller?.querySelectorAll<HTMLElement>("[data-phone-section]");
      const target = sections?.[index];
      if (!scroller || !target) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const padding = parseFloat(getComputedStyle(scroller).paddingTop);
      scroller.scrollTo({ top: scroller.scrollTop, behavior: "auto" });
      scroller.scrollTo({
        top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - padding,
        behavior: reduce ? "auto" : "smooth",
      });
      setSectionIndex(index);
      const name = target.querySelector<HTMLElement>(".section-heading")?.textContent?.trim();
      setAnnouncement(name ? `Showing ${name}` : "");
    },
    [scrollerRef],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) {
      start.current = null;
      return;
    }
    start.current = isPhoneControlTarget(event.target)
      ? null
      : { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const from = start.current;
    start.current = null;
    if (!from || !event.isPrimary) return;
    const delta = classifyPhoneSwipe(event.clientX - from.x, event.clientY - from.y);
    if (!delta) return;
    const target = phonePageTarget(pageIds, pageId, delta);
    if (target) onPageChangeRef.current(target);
  };

  const onPointerCancel = () => {
    start.current = null;
  };

  // Own boundary swipes before native momentum starts; tall-section middles keep native scrolling.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onTouchMove = (event: TouchEvent) => {
      const from = touchStart.current;
      if (!from || event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - from.x;
      const dy = event.touches[0].clientY - from.y;
      if (Math.abs(dy) < 6 || Math.abs(dy) <= Math.abs(dx) * SWIPE_RATIO) return;
      if ((dy < 0 && from.edges.atEnd) || (dy > 0 && from.edges.atStart)) {
        if (event.cancelable) event.preventDefault();
      }
    };
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => scroller.removeEventListener("touchmove", onTouchMove);
  }, [pageId, sectionKey, scrollerRef]);

  const onTouchStart = (event: ReactTouchEvent<HTMLElement>) => {
    if (event.touches.length !== 1 || isPhoneControlTarget(event.target)) {
      touchStart.current = null;
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) {
      touchStart.current = null;
      return;
    }
    const sections = Array.from(scroller.querySelectorAll<HTMLElement>("[data-phone-section]"));
    if (!sections.length) {
      touchStart.current = null;
      return;
    }
    const touch = event.touches[0];
    const scrollerRect = scroller.getBoundingClientRect();
    const style = getComputedStyle(scroller);
    const viewport = {
      top: scrollerRect.top + parseFloat(style.paddingTop),
      bottom: scrollerRect.bottom - parseFloat(style.paddingBottom),
    };
    let index = 0;
    sections.forEach((section, current) => {
      if (section.getBoundingClientRect().top <= viewport.top + EDGE_SLOP) index = current;
    });
    touchStart.current = {
      x: touch.clientX,
      y: touch.clientY,
      index,
      count: sections.length,
      edges: phoneSectionEdges(sections[index].getBoundingClientRect(), viewport),
    };
  };

  const onTouchEnd = (event: ReactTouchEvent<HTMLElement>) => {
    const from = touchStart.current;
    touchStart.current = null;
    if (!from || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const direction = classifyPhoneVerticalSwipe(touch.clientX - from.x, touch.clientY - from.y);
    if (!direction) return;
    const target = phoneSectionTarget(from.index, from.count, direction, from.edges);
    if (target !== null) goToSection(target);
  };

  const onTouchCancel = () => {
    touchStart.current = null;
  };

  return {
    sectionIndex,
    announcement,
    goToSection,
    pagerProps: {
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onTouchStart,
      onTouchEnd,
      onTouchCancel,
    },
  };
}

export function PhoneSectionNav({
  count,
  index,
  onSelect,
  announcement,
}: {
  count: number;
  index: number;
  onSelect: (index: number) => void;
  announcement: string;
}) {
  if (count < 2) return null;
  const current = Math.min(index, count - 1);
  return (
    <nav className="phone-section-nav" aria-label="Page sections">
      <button
        type="button"
        className="icon-button phone-section-step"
        aria-label="Previous section"
        disabled={current <= 0}
        onClick={() => onSelect(current - 1)}
      >
        <ChevronUp size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-button phone-section-step"
        aria-label="Next section"
        disabled={current >= count - 1}
        onClick={() => onSelect(current + 1)}
      >
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </nav>
  );
}
