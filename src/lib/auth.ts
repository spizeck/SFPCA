import { adminAuth } from "./firebase-admin";
import { findAdminUser } from "./registry/admin-users";
import { resolveOwnerSession } from "./registry/persons";
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

// Owner-side session resolution (#166). The chain is deliberately the
// whole of the authorization: session cookie → Firebase uid →
// auth_identities → persons. A valid session alone proves WHO signed
// in, never WHICH person they are — person comes back null while the
// identity is unlinked (e.g. an account claim is pending staff review),
// and portal surfaces must treat that as "no owner data", not as a
// failure or a guess.
export async function requireOwner() {
  const user = await getCurrentUser();
  if (!user) {
    return { authorized: false, user: null, identity: null, person: null };
  }
  try {
    const ctx = await resolveOwnerSession(user.uid);
    if (!ctx) {
      // Session exists but no registry identity row yet — provisioning
      // happens in the session route; a missing row here means it failed
      // or hasn't run. Deny cleanly rather than fabricating a link.
      return { authorized: false, user, identity: null, person: null };
    }
    return {
      authorized: true,
      user,
      identity: ctx.identity,
      person: ctx.person,
    };
  } catch (error) {
    // A Postgres outage must not silently grant or deny-by-accident —
    // log it and fail closed.
    logError("auth", "owner-session-resolve", error);
    return { authorized: false, user, identity: null, person: null };
  }
}
