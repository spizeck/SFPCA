// Server-side maintenance gate. SITE_MAINTENANCE_MODE is deliberately NOT a
// NEXT_PUBLIC_* variable: it is read on the server (per request in proxy.ts,
// at route generation in robots.ts/sitemap.ts) and is expected to be set to
// "true" only in the Vercel Production environment. Preview, local
// development, and CI leave it unset and therefore see the full site.

export function isMaintenanceMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SITE_MAINTENANCE_MODE === "true";
}

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function isAuthApiPath(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

// Exact public paths that must stay reachable while the gate is on.
const MAINTENANCE_EXEMPT_PATHS = new Set([
  "/under-construction",
  "/login",
  "/site.webmanifest",
  "/robots.txt",
  "/sitemap.xml",
]);

// Prefixes for framework/static infrastructure required to render the
// Under Construction page (and any allowed page) correctly.
const MAINTENANCE_EXEMPT_PREFIXES = [
  "/_next/",
  "/videos/",
  "/favicon",
  "/apple-touch-icon",
  "/android-chrome",
];

export function isMaintenanceExemptPath(pathname: string): boolean {
  if (MAINTENANCE_EXEMPT_PATHS.has(pathname)) return true;
  if (isAdminPath(pathname) || isAuthApiPath(pathname)) return true;
  return MAINTENANCE_EXEMPT_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

export type ProxyAction = "allow" | "login" | "maintenance";

// Single routing decision for every request. The admin session gate is
// evaluated first so that maintenance mode can never bypass or alter it:
// in maintenance mode an unauthenticated /admin request still goes to
// /login, and an authenticated one still reaches the admin area.
export function getProxyAction(
  pathname: string,
  hasSession: boolean,
  env: Record<string, string | undefined> = process.env,
): ProxyAction {
  if (isAdminPath(pathname)) {
    return hasSession ? "allow" : "login";
  }
  if (isMaintenanceMode(env) && !isMaintenanceExemptPath(pathname)) {
    return "maintenance";
  }
  return "allow";
}
