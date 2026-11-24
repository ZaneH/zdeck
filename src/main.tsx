import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { registerServiceWorker } from "./lib/pwa";
import { consumeInvitationFragment } from "./lib/remotePhone";
import { RemotePhoneApp } from "./components/RemotePhoneApp";
import { UpdateBanner } from "./components/UpdateBanner";

// The server marks served pages as remote. Capture and strip the invitation
// fragment before React renders or the service worker starts, so the token is
// never re-read by a StrictMode double render or persisted to browser storage.
const remoteSurface = document.documentElement.hasAttribute("data-zdeck-remote");
const initialInvite = remoteSurface ? consumeInvitationFragment() : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {remoteSurface ? <><RemotePhoneApp initialInvite={initialInvite} /><UpdateBanner /></> : <App />}
  </StrictMode>,
);

registerServiceWorker();
