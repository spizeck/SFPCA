// Client-safe lifecycle constants — the labels themselves, with no
// server-only imports, so the banner component can compare against the
// API response without pulling the database module into the browser
// bundle. src/lib/app-lifecycle.ts is the server read/write side.
export const APP_LIFECYCLE_PRELAUNCH_DEMO = "prelaunch-demo";
export const APP_LIFECYCLE_LIVE = "live";
export type AppLifecycleLabel =
  | typeof APP_LIFECYCLE_PRELAUNCH_DEMO
  | typeof APP_LIFECYCLE_LIVE;
