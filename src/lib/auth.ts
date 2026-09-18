import { adminAuth, adminDb } from "./firebase-admin";
import { cookies } from "next/headers";

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session")?.value;

  if (!sessionCookie) {
    return null;
  }

  try {
    const decodedClaims = await adminAuth().verifySessionCookie(sessionCookie, true);
    return decodedClaims;
  } catch (error) {
    return null;
  }
}

export async function isAdmin(email: string): Promise<{ isAdmin: boolean; role?: "admin" | "editor" }> {
  if (!email) {
    return { isAdmin: false };
  }

  // The env allowlist is a bootstrap mechanism only (see the session route,
  // which reconciles listed users into admins/ docs). Match it
  // case-insensitively so mis-cased configuration can't lock out a real
  // admin; the Firestore doc lookup below stays exact-match because the
  // security rules key on the exact token email.
  const normalizedEmail = email.trim().toLowerCase();
  const envAdmins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (envAdmins.includes(normalizedEmail)) {
    return { isAdmin: true, role: "admin" };
  }

  try {
    const adminDoc = await adminDb().collection("admins").doc(email).get();
    if (adminDoc.exists) {
      const data = adminDoc.data();
      return { isAdmin: true, role: data?.role || "editor" };
    }
  } catch (error) {
    console.error("Error checking admin status:", error);
  }

  return { isAdmin: false };
}

export async function requireAdmin() {
  const user = await getCurrentUser();
  
  if (!user) {
    return { authorized: false, user: null, role: null };
  }

  const { isAdmin: userIsAdmin, role } = await isAdmin(user.email!);
  
  if (!userIsAdmin) {
    return { authorized: false, user, role: null };
  }

  return { authorized: true, user, role };
}
