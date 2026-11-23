export const SERVICE_WORKER_UPDATE_EVENT = "deck:update-ready";

let reloadRequested = false;
let hadController = false;

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  if (!["http:", "https:"].includes(window.location.protocol)) return;

  hadController = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && reloadRequested) window.location.reload();
    hadController = true;
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        const notify = () => {
          if (registration.waiting) {
            window.dispatchEvent(new Event(SERVICE_WORKER_UPDATE_EVENT));
          }
        };

        notify();
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              notify();
            }
          });
        });
      })
      .catch(() => {
        // Service workers are an enhancement; the app remains usable without one.
      });
  });
}

export function applyServiceWorkerUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => {
      if (!registration?.waiting) {
        reloadRequested = false;
        return;
      }
      reloadRequested = true;
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    })
    .catch(() => {
      reloadRequested = false;
    });
}
