// Public lifecycle read for the pre-launch demo banner. The banner is a
// client component so statically-prerendered pages reflect the CURRENT
// lifecycle without a redeploy — going live drops the banner on the next
// page load, not the next build. Returns only the lifecycle label; it is
// presentation metadata, not sensitive state.
//
// Strict read: a failed app_state lookup answers 503 instead of
// resolving 'live' — the banner must not clear a persisted demo label
// on an unconfirmed response while fictional data may still be served.
import { NextResponse } from "next/server";
import { getAppLifecycleStrict } from "@/lib/app-lifecycle";

export const dynamic = "force-dynamic";

export async function GET() {
  const lifecycle = await getAppLifecycleStrict();
  if (lifecycle === undefined) {
    return NextResponse.json(
      { lifecycle: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { lifecycle },
    // Short shared cache: the banner may lag a go-live by at most one
    // cache window, never longer. No per-user data is served here.
    { headers: { "Cache-Control": "public, max-age=15, must-revalidate" } },
  );
}
