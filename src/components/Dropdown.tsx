import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
}

/**
 * Shared text dropdown for choosing a value. Mirrors the inspector's icon
 * disclosure: a bordered trigger with a value and a menu of checked rows.
 */
export function Dropdown({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((option) => option.value === value) ?? options[0];
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div
      className="dropdown" ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (!open && !disabled && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      <button
        ref={trigger} type="button" className="dropdown-trigger"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={`${label}: ${current?.label ?? ""}`} disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="dropdown-label">{label}</span>
        <span className="dropdown-value">{current?.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menu} id={id} className="dropdown-menu" role="menu" aria-label={label}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const rows = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
            const index = rows.indexOf(document.activeElement as HTMLElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
            rows[next]?.focus();
          }}
        >
          {options.map((option) => (
            <button
              key={option.value} type="button" role="menuitemradio" tabIndex={-1}
              aria-checked={option.value === value}
              onClick={() => { onChange(option.value); close(); }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
