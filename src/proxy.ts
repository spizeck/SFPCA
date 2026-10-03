import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getProxyAction } from "@/lib/maintenance";
import { isVerifiedAdminSession } from "@/lib/auth";
import {
  APP_LIFECYCLE_PRELAUNCH_DEMO,
  getCachedAppLifecycle,
} from "@/lib/app-lifecycle";

export async function proxy(request: NextRequest) {
  const sessionCookie = request.cookies.get("session")?.value;
  const action = getProxyAction(
    request.nextUrl.pathname,
    Boolean(sessionCookie),
  );

  let response: NextResponse;

  if (action === "login") {
    response = NextResponse.redirect(new URL("/login", request.url));
  } else if (action === "maintenance") {
    response = NextResponse.redirect(
      new URL("/under-construction", request.url),
    );
  } else if (action === "admin-check") {
    // Verified admin bypass (#189): the proxy runs on the Node.js
    // runtime, so the same auth stack the pages use is available here —
    // Firebase session-cookie verification (signature, expiry,
    // revocation) followed by the admin_users lookup in
    // isVerifiedAdminSession (Postgres-only by design: ADMIN_EMAILS
    // bootstrap does not earn the public-site bypass). A forged,
    // expired, revoked, or non-admin cookie falls through to the
    // maintenance redirect; the check fails closed.
    const bypass = await isVerifiedAdminSession(sessionCookie);
    response = bypass
      ? NextResponse.next()
      : NextResponse.redirect(new URL("/under-construction", request.url));
  } else {
    response = NextResponse.next();
  }

  // Pre-launch demo SEO guard: while the lifecycle row reads
  // 'prelaunch-demo' every response carries X-Robots-Tag: noindex, so
  // statically-prerendered pages are unindexable without a rebuild and
  // the demo dataset can never leak into search results. The read is
  // cached per instance and fails open to 'live' — a Postgres blip must
  // never deindex the real site (see src/lib/app-lifecycle.ts).
  if (
    (await getCachedAppLifecycle()) === APP_LIFECYCLE_PRELAUNCH_DEMO &&
    !response.headers.has("x-robots-tag")
  ) {
    response.headers.set("x-robots-tag", "noindex");
  }

  return response;
}

// Runs on every request; the maintenance predicates in lib/maintenance.ts
// decide which paths are gated and which are exempt, so no public route can
// bypass the gate via a deeper URL.
export const config = {
  matcher: "/:path*",
};
