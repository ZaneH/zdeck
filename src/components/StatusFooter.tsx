import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronUp, CircleHelp, Globe, GlobeLock, Unplug, Pencil, Play, Plug, Settings2 } from "lucide-react";
import type { FooterPreferences } from "../lib/footerPreferences";
import type { RemoteStatus } from "../lib/nativeRemote";

type MenuItem = { label: string; href?: string; action?: () => void; disabled?: boolean; selected?: boolean };

function FooterMenu({ label, icon, tone, detail, items }: {
  label: string; icon: ReactNode; tone?: string; detail: string; items: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="footer-item" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
    if (!open && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setOpen(true); }
  }}>
    <button ref={trigger} type="button" className={`footer-trigger ${tone ?? ""}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)} onContextMenu={event => { event.preventDefault(); setOpen(true); }}>
      {icon}<span>{label}</span><ChevronUp size={11} aria-hidden="true" />
    </button>
    {open ? <div className="footer-popup">
      <p className="footer-detail">{detail}</p>
      <div ref={menu} id={id} role="menu" aria-label={label} onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const entries = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
        const index = entries.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
        entries[next]?.focus();
      }}>
        {items.map(item => item.href ? <a key={item.label} role="menuitem" tabIndex={-1} href={item.href} onClick={close}>{item.label}</a>
          : <button key={item.label} type="button" tabIndex={-1}
            role={item.selected === undefined ? "menuitem" : "menuitemradio"} aria-checked={item.selected}
            disabled={item.disabled} onClick={() => { item.action?.(); close(); }}>{item.label}</button>)}
      </div>
    </div> : null}
  </div>;
}

export function StatusFooter({ preferences, native, service, serviceFailed, pluginCount, pluginsUnknown,
  live, canRun, onEdit, onRun, feedback }: {
  preferences: FooterPreferences; native: boolean; service: RemoteStatus | null; serviceFailed: boolean;
  pluginCount: number; pluginsUnknown: boolean; live: boolean; canRun: boolean;
  onEdit: () => void; onRun: () => void; feedback: ReactNode;
}) {
  const serviceLabel = !native ? "Service unavailable" : serviceFailed ? "Service unknown" : !service ? "Checking service"
    : service.running ? "Service running" : "Service stopped";
  const serviceIcon = !native ? <GlobeLock size={14} aria-hidden="true" /> : serviceFailed || !service ? <CircleHelp size={14} aria-hidden="true" />
    : service.running ? <Globe size={14} aria-hidden="true" /> : <Unplug size={14} aria-hidden="true" />;
  return <footer className={`status-footer${preferences.dividers ? " has-dividers" : ""}`} aria-label="Application status" data-live={live} data-ready={canRun}>
    <span className="sr-only" role="status">{!native ? "Preview only. Controls are simulated." : live ? "Controls armed. Controls run on this computer." : "Editing. Controls are disarmed."}</span>
    {feedback}
    <div className="status-footer-row">
      <FooterMenu label={!native ? "Preview only" : live ? "Controls armed" : "Editing"}
        icon={live ? <Play size={13} aria-hidden="true" /> : <Pencil size={13} aria-hidden="true" />}
        tone={live ? "is-armed" : undefined}
        detail={!native ? "Browser controls are simulated. Use the desktop app to run actions on this computer."
          : live ? "Controls run on this computer. Editing or leaving the deck returns to Editing."
            : "Controls do not run in Editing. Arm them explicitly to run saved actions on this computer."}
        items={native ? [
          { label: "Edit controls", selected: !live, action: onEdit },
          { label: "Run controls", selected: live, disabled: !canRun, action: onRun },
        ] : [{ label: "Open settings", href: "#/settings/general" }]} />
      {preferences.service ? <FooterMenu label={serviceLabel} icon={serviceIcon}
        tone={native && service?.running ? "is-connected" : native && service && !service.running ? "is-disconnected" : undefined}
        detail={!native ? "The private phone service is available only in the desktop app."
          : serviceFailed ? "Could not check the local service. Its current state is unknown."
            : service ? `${service.running ? "The local service is running. Phone and network reachability are not checked." : "The local service is stopped."}${service.error ? ` ${service.error}` : ""}`
              : "Waiting for local service status."}
        items={[{ label: "Phone connection settings", href: "#/settings/phone" }]} /> : null}
      {preferences.plugins ? <FooterMenu label={pluginsUnknown ? "Plugins unknown" : `${pluginCount} ${pluginCount === 1 ? "plugin" : "plugins"} loaded`}
        icon={<Plug size={14} aria-hidden="true" />} detail={pluginsUnknown ? "Plugin status could not be read or is still loading. Open Integrations to review it."
          : "Counts enabled plugins with a connected runtime and a loaded manifest, not all installed packages."}
        items={[{ label: "Manage plugins", href: "#/settings/integrations" }]} /> : null}
      <a className="footer-settings" href="#/settings/footer" aria-label="Configure footer"><Settings2 size={14} aria-hidden="true" /></a>
    </div>
  </footer>;
}
