"use client";

import { useEffect } from "react";
import { buildKlaroConfig } from "@/lib/consent";

// Module-level guard: React StrictMode double-mounts effects in dev, and
// Klaro renders into a fixed element — running setup twice would be wasteful.
let klaroInitialized = false;

/**
 * Mounts Klaro once for the whole app. The bundle is browser-only (UMD, uses
 * `self`/`document` at load time), so it is dynamically imported inside the
 * effect — it never enters the server render.
 */
export function ConsentManager() {
  useEffect(() => {
    if (klaroInitialized) return;
    let cancelled = false;
    void import("klaro/dist/klaro-no-css")
      .then((mod) => {
        if (cancelled || klaroInitialized) return;
        const klaro = (mod as unknown as { default?: typeof mod }).default ?? mod;
        const config = buildKlaroConfig();
        window.klaroConfig = config;
        window.klaro = klaro;
        klaro.setup(config);
        klaroInitialized = true;
      })
      .catch(() => {
        // A failing consent layer must never break the page — optional
        // analytics simply stays off.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
