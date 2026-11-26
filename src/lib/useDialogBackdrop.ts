import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Dismiss a native <dialog> only when a press starts and ends on its backdrop.
 * Clicks on the dialog's own padding share the dialog as target, so the
 * geometry check keeps them (and inside drags) from closing it.
 */
export function useDialogBackdrop(ref: RefObject<HTMLDialogElement | null>, dismissible = true, onDismiss?: () => void): void {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !dismissible) return;
    let startedOnBackdrop = false;

    const outsideRect = (event: MouseEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };
    const onPointerDown = (event: PointerEvent) => {
      startedOnBackdrop = event.target === dialog && outsideRect(event);
    };
    const onClick = (event: MouseEvent) => {
      if (startedOnBackdrop && event.target === dialog && outsideRect(event)) {
        if (onDismiss) onDismiss(); else dialog.close();
      }
      startedOnBackdrop = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("click", onClick);
    };
  }, [ref, dismissible, onDismiss]);
}
