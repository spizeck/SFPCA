import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getProxyAction } from "@/lib/maintenance";

export function proxy(request: NextRequest) {
  const action = getProxyAction(
    request.nextUrl.pathname,
    Boolean(request.cookies.get("session")),
  );

  if (action === "login") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (action === "maintenance") {
    return NextResponse.redirect(new URL("/under-construction", request.url));
  }

  return NextResponse.next();
}

// Runs on every request; the maintenance predicates in lib/maintenance.ts
// decide which paths are gated and which are exempt, so no public route can
// bypass the gate via a deeper URL.
export const config = {
  matcher: "/:path*",
};
