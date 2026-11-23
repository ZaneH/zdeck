import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  applyServiceWorkerUpdate,
  SERVICE_WORKER_UPDATE_EVENT,
} from "../lib/pwa";

export function UpdateBanner() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onReady = () => setReady(true);
    window.addEventListener(SERVICE_WORKER_UPDATE_EVENT, onReady);
    return () => window.removeEventListener(SERVICE_WORKER_UPDATE_EVENT, onReady);
  }, []);

  if (!ready) return null;

  return (
    <div className="update-banner" role="status">
      <span>A new version is ready.</span>
      <button type="button" className="button small" onClick={applyServiceWorkerUpdate}>
        <RefreshCw size={15} aria-hidden="true" />
        Reload
      </button>
    </div>
  );
}
