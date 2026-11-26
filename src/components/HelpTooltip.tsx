import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Info } from "lucide-react";

/** Shared hover, keyboard and touch help; Escape dismisses without moving focus. */
export function HelpTooltip({ label, children, trigger }: {
  label: string; children: ReactNode; trigger?: (descriptionId: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);
  return <span className="setting-help" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
    {trigger ? trigger(id) : <button type="button" aria-label={label} aria-describedby={id}
      onClick={() => setOpen(true)}><Info size={16} aria-hidden="true" /></button>}
    <span id={id} className="setting-tooltip" role="tooltip" aria-hidden={!open}>{children}</span>
  </span>;
}
