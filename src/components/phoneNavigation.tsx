import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

const SWIPE_MIN = 48;
const SWIPE_RATIO = 1.5;

/** Swipe left -> next page (1), right -> previous (-1); short or diagonal drags are ignored. */
export function classifyPhoneSwipe(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) <= Math.abs(dy) * SWIPE_RATIO) return 0;
  return dx < 0 ? 1 : -1;
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
  const start = useRef<{ x: number; y: number } | null>(null);
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const sectionKey = sectionIds.join("|");

  // A page change resets the section position; deck snapshots on the same page do not.
  useEffect(() => {
    setSectionIndex(0);
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
      scroller.scrollTo({
        top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - padding,
        behavior: reduce ? "auto" : "smooth",
      });
      setSectionIndex(index);
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

  return {
    sectionIndex,
    goToSection,
    pagerProps: { onPointerDown, onPointerUp, onPointerCancel },
  };
}

export function PhoneSectionNav({
  names,
  index,
  onSelect,
}: {
  names: string[];
  index: number;
  onSelect: (index: number) => void;
}) {
  if (names.length < 2) return null;
  const current = Math.min(index, names.length - 1);
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
      <span className="phone-section-current" aria-live="polite">
        {names[current]}
        <span className="phone-section-count"> {current + 1} / {names.length}</span>
      </span>
      <button
        type="button"
        className="icon-button phone-section-step"
        aria-label="Next section"
        disabled={current >= names.length - 1}
        onClick={() => onSelect(current + 1)}
      >
        <ChevronDown size={18} aria-hidden="true" />
      </button>
    </nav>
  );
}
