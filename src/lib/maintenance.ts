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

// The owner portal (#166) — authenticated owner self-service. Session-
// gated like /admin and maintenance-exempt like /login: annual
// confirmation and owner reports must stay reachable while the public
// site is under construction (the reminder emails link here).
function isPortalPath(pathname: string): boolean {
  return pathname === "/portal" || pathname.startsWith("/portal/");
}

function isAuthApiPath(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

// Operational machine-to-machine APIs (#216): Vercel cron invocations
// (/api/cron/reminders, /api/cron/sweep-receipts) and the Resend
// delivery webhook (/api/webhooks/resend). Maintenance mode gates
// public interactive traffic — it is not a switch for background
// infrastructure, and silently redirecting these routes would suspend
// reminders, receipt sweeping, and delivery writebacks for the whole
// window. Every handler here authenticates independently and fails
// closed (CRON_SECRET bearer / svix signature), so exemption widens no
// public surface — the maintenance redirect is the only thing removed.
// Deliberately NOT a blanket /api/ exemption: any future public API
// stays gated. The bare namespace roots match for uniformity; they
// have no handler, so they 404 rather than redirect.
function isOpsApiPath(pathname: string): boolean {
  return (
    pathname === "/api/cron" ||
    pathname.startsWith("/api/cron/") ||
    pathname === "/api/webhooks" ||
    pathname.startsWith("/api/webhooks/")
  );
}

// Exact public paths that must stay reachable while the gate is on.
const MAINTENANCE_EXEMPT_PATHS = new Set([
  "/under-construction",
  "/login",
  "/site.webmanifest",
  "/robots.txt",
  "/sitemap.xml",
  // Generated share images must stay reachable so the Under Construction
  // page's own social metadata resolves while the gate is up.
  "/opengraph-image",
  "/twitter-image",
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
  if (
    isAdminPath(pathname) ||
    isAuthApiPath(pathname) ||
    isPortalPath(pathname) ||
    isOpsApiPath(pathname)
  ) {
    return true;
  }
  return MAINTENANCE_EXEMPT_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

export type ProxyAction = "allow" | "login" | "maintenance" | "admin-check";

// Single routing decision for every request. The session gates are
// evaluated before maintenance so maintenance mode can never bypass or
// alter them: an unauthenticated /admin or /portal request always goes
// to /login, and an authenticated one still reaches it.
//
// "admin-check" (#189): a gated public path with a session cookie. Cookie
// PRESENCE proves nothing — a cookie value is client-controlled — so the
// proxy must verify the session before allowing the bypass: Firebase
// session-cookie verification plus a live Postgres admin_users row
// (ADMIN_EMAILS alone does not bypass — revocation stays single-source).
// No cookie means the redirect is unconditional, so anonymous visitors
// never pay the verification cost.
export function getProxyAction(
  pathname: string,
  hasSession: boolean,
  env: Record<string, string | undefined> = process.env,
): ProxyAction {
  if (isAdminPath(pathname) || isPortalPath(pathname)) {
    return hasSession ? "allow" : "login";
  }
  if (isMaintenanceMode(env) && !isMaintenanceExemptPath(pathname)) {
    return hasSession ? "admin-check" : "maintenance";
  }
  return "allow";
}
