import { adminAuth } from "./firebase-admin";
import { findAdminUser } from "./registry/admin-users";
import { logError } from "./logger";
import { cookies } from "next/headers";

// Firebase Auth error codes that represent an expected rejection —
// expired/revoked/invalid credentials, or a malformed client token —
// rather than an infrastructure failure. These are normal outcomes
// (logout, expiry, attacker-crafted input) and must not produce
// error-level operational noise. Everything else (network, quota,
// internal) indicates a real Firebase/infra problem worth alerting on.
const EXPECTED_AUTH_ERROR_CODES = new Set([
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/session-cookie-expired",
  "auth/session-cookie-revoked",
  "auth/invalid-session-cookie",
  "auth/argument-error",
  "auth/user-disabled",
]);

export function isExpectedAuthError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && EXPECTED_AUTH_ERROR_CODES.has(code);
}

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
    // Expired/revoked/malformed cookies are routine — silently logged
    // out. Anything else (Firebase unreachable, internal error) means
    // admins are being locked out by an infra failure: log it.
    if (!isExpectedAuthError(error)) {
      logError("session", "verify-session-cookie", error);
    }
    return null;
  }
}

export async function isAdmin(email: string): Promise<{ isAdmin: boolean; role?: "admin" | "editor" }> {
  if (!email) {
    return { isAdmin: false };
  }

  // The env allowlist is a bootstrap/emergency mechanism only — the
  // authoritative record is Postgres admin_users (the session route
  // provisions a row for env-listed users on first login). Match it
  // case-insensitively so mis-cased configuration can't lock out a real
  // admin.
  const normalizedEmail = email.trim().toLowerCase();
  const envAdmins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (envAdmins.includes(normalizedEmail)) {
    return { isAdmin: true, role: "admin" };
  }

  try {
    const adminUser = await findAdminUser(email);
    if (adminUser) {
      return { isAdmin: true, role: adminUser.role };
    }
  } catch (error) {
    // Fail closed to non-admin, but a Postgres outage here silently
    // locks out every admin — that must be diagnosable.
    logError("auth", "admin-lookup", error);
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
