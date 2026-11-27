import { useEffect, useId, useRef, useState } from "react";
import { Cog } from "lucide-react";
import { ACCENTS } from "../lib/types";
import type { Accent, Theme } from "../lib/types";
import { useExclusiveMenu } from "../lib/useExclusiveMenu";

const THEMES: { value: "" | Theme; label: string }[] = [
  { value: "", label: "Inherit" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "glass", label: "Glass" },
];

export function SectionSettingsMenu({
  sectionName, controlCount, theme, accent, inheritedTheme, inheritedAccentName, disabled = false,
  onDuplicate, duplicateReason, onTheme, onAccent,
}: {
  sectionName: string;
  controlCount: number;
  theme: Theme | null;
  accent: Accent | null;
  inheritedTheme: Theme;
  inheritedAccentName: string;
  disabled?: boolean;
  onDuplicate: () => void;
  /** Present when copying this section would exceed the page control limit. */
  duplicateReason?: string | null;
  onTheme: (theme: Theme | null) => void;
  onAccent: (accent: Accent | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useExclusiveMenu(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (action: () => void) => {
    action();
    close();
  };

  return (
    <div
      className="section-settings" ref={root}
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
        ref={trigger} type="button" className="icon-button section-settings-trigger"
        aria-label={`Section settings for ${sectionName}`} title="Section settings"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        disabled={disabled} onClick={() => setOpen(!open)}
      >
        <Cog size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menu} id={id} className="section-settings-menu" role="menu"
          aria-label={`Section settings for ${sectionName}`}
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
          <p className="section-settings-count" role="presentation">
            {controlCount} {controlCount === 1 ? "control" : "controls"}
          </p>
          <button
            type="button" role="menuitem" tabIndex={-1} className="section-settings-duplicate"
            disabled={disabled || !!duplicateReason}
            onClick={(event) => { event.stopPropagation(); choose(onDuplicate); }}
          >
            <span>Duplicate section</span>
            {duplicateReason ? <span className="section-settings-reason">{duplicateReason}</span> : null}
          </button>
          <div className="section-settings-group" role="group" aria-label="Theme">
            <p className="section-settings-label" role="presentation">Theme</p>
            {THEMES.map((option) => (
              <button
                key={option.value} type="button" role="menuitemradio" tabIndex={-1}
                aria-checked={(theme ?? "") === option.value}
                onClick={() => choose(() => onTheme(option.value ? option.value as Theme : null))}
              >
                {option.value ? option.label : `Inherit (${inheritedTheme})`}
              </button>
            ))}
          </div>
          <div className="section-settings-group" role="group" aria-label="Accent">
            <p className="section-settings-label" role="presentation">Accent</p>
            <button type="button" role="menuitemradio" tabIndex={-1} aria-checked={accent == null}
              onClick={() => choose(() => onAccent(null))}>
              Inherit ({inheritedAccentName})
            </button>
            {ACCENTS.map((item) => (
              <button
                key={item.value} type="button" role="menuitemradio" tabIndex={-1}
                aria-checked={accent === item.value}
                onClick={() => choose(() => onAccent(item.value))}
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
