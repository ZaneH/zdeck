import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

export type PreferenceFixture = "off" | "on" | "loading" | "saving" | "failed";

export function mockDesktopPreferences(fixture: PreferenceFixture = "off") {
  const tauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  let enabled = fixture === "on";
  mockIPC((command, payload) => {
    if (command === "desktop_close_to_tray") {
      return fixture === "loading" ? new Promise<boolean>(() => {}) : enabled;
    }
    if (command === "desktop_set_close_to_tray") {
      if (fixture === "saving") return new Promise<boolean>(() => {});
      if (fixture === "failed") throw new Error("Disk full");
      enabled = (payload as { enabled: boolean }).enabled;
      return enabled;
    }
    throw new Error(`Unexpected story IPC: ${command}`);
  });
  return () => {
    clearMocks();
    if (tauri) Object.defineProperty(globalThis, "isTauri", tauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  };
}
