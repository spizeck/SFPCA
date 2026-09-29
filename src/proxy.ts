import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getProxyAction } from "@/lib/maintenance";
import { isVerifiedAdminSession } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  const sessionCookie = request.cookies.get("session")?.value;
  const action = getProxyAction(
    request.nextUrl.pathname,
    Boolean(sessionCookie),
  );

  if (action === "login") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (action === "maintenance") {
    return NextResponse.redirect(new URL("/under-construction", request.url));
  }

  if (action === "admin-check") {
    // Verified admin bypass (#189): the proxy runs on the Node.js
    // runtime, so the same auth stack the pages use is available here —
    // Firebase session-cookie verification (signature, expiry,
    // revocation) followed by the admin_users lookup in
    // isVerifiedAdminSession (Postgres-only by design: ADMIN_EMAILS
    // bootstrap does not earn the public-site bypass). A forged,
    // expired, revoked, or non-admin cookie falls through to the
    // maintenance redirect; the check fails closed.
    const bypass = await isVerifiedAdminSession(sessionCookie);
    return bypass
      ? NextResponse.next()
      : NextResponse.redirect(new URL("/under-construction", request.url));
  }

  return NextResponse.next();
}

// Runs on every request; the maintenance predicates in lib/maintenance.ts
// decide which paths are gated and which are exempt, so no public route can
// bypass the gate via a deeper URL.
export const config = {
  matcher: "/:path*",
};
