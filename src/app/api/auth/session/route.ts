import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { isAdmin, isExpectedAuthError } from "@/lib/auth";
import { logError, logWarn } from "@/lib/logger";
import { cookies } from "next/headers";

// Cross-origin POSTs could plant a session cookie in a victim's browser
// (login CSRF) and cross-site DELETEs could force a logout. Browsers
// always send Origin on fetch/form mutations, so reject when it is
// present and doesn't match the request host; absent Origin means a
// non-browser client, which carries no ambient authority to abuse.
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

// Shared attributes so the cookie written at login and cleared at
// logout always match; SameSite=Lax is set explicitly rather than
// relying on the browser default.
function sessionCookieAttributes() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ authorized: false }, { status: 403 });
  }

  try {
    const { idToken } = await request.json();

    const decodedToken = await adminAuth().verifyIdToken(idToken);
    const email = decodedToken.email!;

    // Firestore/Storage rules require a verified email for admin access;
    // enforce the same boundary for session creation.
    if (!decodedToken.email_verified) {
      return NextResponse.json({ authorized: false }, { status: 403 });
    }

    const { isAdmin: userIsAdmin, role } = await isAdmin(email);

    if (!userIsAdmin) {
      return NextResponse.json({ authorized: false }, { status: 403 });
    }

    // Admins authorized via the ADMIN_EMAILS env allowlist are not visible
    // to the security rules, which check the admins collection. Bootstrap a
    // document so server-side and rules-side authorization agree.
    const adminRef = adminDb().collection("admins").doc(email);
    const adminSnap = await adminRef.get();
    if (!adminSnap.exists) {
      await adminRef.set({ email, role: "admin", createdAt: new Date() });
    }

    const expiresIn = 60 * 60 * 24 * 5 * 1000;
    const sessionCookie = await adminAuth().createSessionCookie(idToken, { expiresIn });

    const cookieStore = await cookies();
    cookieStore.set("session", sessionCookie, {
      ...sessionCookieAttributes(),
      maxAge: expiresIn,
    });

    return NextResponse.json({ authorized: true, role });
  } catch (error) {
    // Malformed JSON and invalid/expired/revoked ID tokens are routine
    // client failures (and attacker-craftable) — warn only, never
    // error-level noise. Anything else is a Firebase/infra failure
    // locking out legitimate admins.
    if (isExpectedAuthError(error) || error instanceof SyntaxError) {
      logWarn("session", "create", "session request rejected");
    } else {
      logError("session", "create", error);
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ success: false }, { status: 403 });
  }

  const cookieStore = await cookies();
  cookieStore.set("session", "", { ...sessionCookieAttributes(), maxAge: 0 });
  return NextResponse.json({ success: true });
}
