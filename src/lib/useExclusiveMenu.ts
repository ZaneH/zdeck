import { useEffect, useRef } from "react";
import { registerOpenMenu, unregisterOpenMenu } from "./menuRegistry";

/** Keep one application menu open at a time without stealing focus from the new trigger. */
export function useExclusiveMenu(open: boolean, dismiss: () => void) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;
    const close = () => dismissRef.current();
    registerOpenMenu(close);
    return () => unregisterOpenMenu(close);
  }, [open]);
}
