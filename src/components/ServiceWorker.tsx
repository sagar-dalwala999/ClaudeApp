"use client";

/**
 * Registers the passthrough worker in `public/sw.js`.
 *
 * Registration is what makes the archive installable, and installation is what
 * gives a phone a share sheet entry for it. Failure is silent by design: the
 * app works perfectly well as a website, and a browser that blocks workers
 * (private mode, older Safari) should not see an error about it.
 */
import { useEffect } from "react";

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "https:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
      // Workers need a secure context; without one there is nothing to register.
      return;
    }
    const timer = setTimeout(() => {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }, 1_000);
    return () => clearTimeout(timer);
  }, []);

  return null;
}
