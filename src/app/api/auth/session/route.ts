import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { isAdmin } from "@/lib/auth";
import { cookies } from "next/headers";

export async function POST(request: NextRequest) {
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
      maxAge: expiresIn,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });

    return NextResponse.json({ authorized: true, role });
  } catch (error) {
    console.error("Session creation error:", error);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete("session");
  return NextResponse.json({ success: true });
}
