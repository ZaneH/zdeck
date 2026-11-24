import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SetupGuide } from "./SetupGuide";

function SetupExample({ canAdd = true, storageAlert = null }: { canAdd?: boolean; storageAlert?: string | null }) {
  const [message, setMessage] = useState<string | null>(null);
  return message ? <main className="settings-view">
    <h1>Local demo complete</h1><p role="status">{message} No deck or preferences were saved.</p>
    <button className="button secondary" onClick={() => setMessage(null)}>Restart demo</button>
  </main> : <SetupGuide pageName="Stream" canAdd={canAdd} storageAlert={storageAlert}
    onDismiss={() => setMessage("Setup skipped in Storybook.")}
    onFinish={(control) => { if (!canAdd) return false; setMessage(`Example control: ${control.label}.`); return true; }} />;
}
const meta = { title: "Onboarding/Setup guide", component: SetupExample,
  parameters: { layout: "fullscreen" }, args: { canAdd: true, storageAlert: null } } satisfies Meta<typeof SetupExample>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Try the example controls, then continue through Build and Try. All state is local. */
export const FirstUse: Story = {};
/** The alert is visible immediately; continue to Try to see the disabled Add button. */
export const PageFull: Story = { args: { canAdd: false, storageAlert: "This page is full. Skip setup to make room or choose another page." } };
export const StorageUnavailable: Story = { args: { storageAlert: "Example storage warning: changes cannot be saved. This is a visual fixture." } };
