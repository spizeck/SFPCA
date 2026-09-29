// The maintenance gate's trust decision (#189): isVerifiedAdminSession
// runs the REAL chain — firebase-admin session-cookie verification then
// the live admin_users row lookup (Postgres-only: ADMIN_EMAILS does not
// earn the bypass, keeping revocation single-source) — with nothing
// mocked. These tests pin the reject side: anything that cannot be
// cryptographically verified as a signed-in admin session must fail
// closed. The accept side — and the env-only-no-bypass split — is
// proven end-to-end by tests/e2e/maintenance.spec.ts, where the same
// function runs inside the proxy against the Auth emulator.
import { describe, expect, test } from "vitest";
import { isVerifiedAdminSession } from "@/lib/auth";

// Shapes an attacker can present in a `session` cookie. None are signed
// by Firebase — verification must reject each without reaching the
// admin-lookup stage.
const FORGED_COOKIES = [
  "forged-session-cookie",
  "x".repeat(4096),
  // Structurally plausible unsigned JWT (header.payload.signature)
  // claiming admin — signature verification must refuse it.
  "eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2UifQ.eyJzdWIiOiJhdHRhY2tlciIsImVtYWlsIjoiYWRtaW5Ac2ZwY2Eub3JnIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsImFkbWluIjp0cnVlLCJleHAiOjk5OTk5OTk5OTl9.forged",
];

describe("isVerifiedAdminSession", () => {
  test("missing or empty cookies are never admin", async () => {
    expect(await isVerifiedAdminSession(undefined)).toBe(false);
    expect(await isVerifiedAdminSession(null)).toBe(false);
    expect(await isVerifiedAdminSession("")).toBe(false);
  });

  test("forged and unsigned cookies are rejected", async () => {
    for (const cookie of FORGED_COOKIES) {
      expect(await isVerifiedAdminSession(cookie)).toBe(false);
    }
  });
});
