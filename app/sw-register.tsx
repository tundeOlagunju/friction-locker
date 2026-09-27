"use client";

import { useEffect } from "react";

/**
 * Registers the offline worker from the same directory as the web manifest.
 * Deriving the URL this way keeps installs working both at a domain root and
 * under a GitHub Pages repository path.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    const register = async () => {
      const manifestHref = document.querySelector<HTMLLinkElement>(
        'link[rel="manifest"]',
      )?.href;
      const workerUrl = new URL(
        "sw.js",
        manifestHref ?? new URL("./", window.location.href),
      );
      const scope = new URL("./", workerUrl).pathname;

      try {
        const registration = await navigator.serviceWorker.register(
          workerUrl.href,
          { scope },
        );
        await registration.update();

        // The first page load happened before the worker controlled it. Give
        // the newly active worker the exact same-origin resources already used
        // by that page so the very next launch can be fully offline.
        const readyRegistration = await navigator.serviceWorker.ready;
        const loadedResources = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name);
        readyRegistration.active?.postMessage({
          type: "CACHE_SHELL",
          urls: [window.location.href, manifestHref, ...loadedResources].filter(
            (url): url is string => {
              if (!url) return false;
              const resourceUrl = new URL(url, window.location.href);
              return (
                resourceUrl.origin === window.location.origin &&
                resourceUrl.pathname.startsWith(scope)
              );
            },
          ),
        });
      } catch (error) {
        // The app still works online when private browsing or browser policy
        // prevents service-worker storage.
        console.warn("Offline mode could not be enabled.", error);
      }
    };

    if (document.readyState === "complete") {
      void register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
