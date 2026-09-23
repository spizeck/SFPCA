// Authorization/session helper tests. Only the Firebase Admin SDK,
// Postgres admin-users seam, and Next.js request-context boundaries are
// mocked; the authorization decisions under test are real.
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockFindAdminUser,
  mockVerifySessionCookie,
  mockCookieGet,
  mockLogError,
} = vi.hoisted(() => ({
  mockFindAdminUser: vi.fn(),
  mockVerifySessionCookie: vi.fn(),
  mockCookieGet: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/firebase-admin", () => ({
  adminAuth: () => ({
    verifySessionCookie: mockVerifySessionCookie,
  }),
}));

// The authorization record is Postgres admin_users — the seam is mocked
// here; the lookup itself is exercised for real in tests/db.
vi.mock("@/lib/registry/admin-users", () => ({
  findAdminUser: mockFindAdminUser,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));

vi.mock("@/lib/logger", () => ({
  logError: mockLogError,
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  getCurrentUser,
  isAdmin,
  isExpectedAuthError,
  requireAdmin,
} from "@/lib/auth";

const adminUser = (email: string, role: "admin" | "editor" = "editor") => ({
  id: "admin-user-id",
  email,
  role,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  // Neutralize any ambient ADMIN_EMAILS so each test controls the
  // allowlist explicitly.
  vi.stubEnv("ADMIN_EMAILS", "");
  mockFindAdminUser.mockReset();
  mockVerifySessionCookie.mockReset();
  mockCookieGet.mockReset();
  mockLogError.mockReset();
});

describe("isAdmin", () => {
  test("grants admin role from the ADMIN_EMAILS allowlist without hitting Postgres", async () => {
    vi.stubEnv("ADMIN_EMAILS", "admin@example.com,editor@example.com");
    const result = await isAdmin("admin@example.com");
    expect(result).toEqual({ isAdmin: true, role: "admin" });
    expect(mockFindAdminUser).not.toHaveBeenCalled();
  });

  test("trims whitespace around allowlist entries", async () => {
    vi.stubEnv("ADMIN_EMAILS", "  admin@example.com , other@example.com ");
    mockFindAdminUser.mockResolvedValue(null);
    expect((await isAdmin("admin@example.com")).isAdmin).toBe(true);
    expect((await isAdmin("other@example.com")).isAdmin).toBe(true);
    // The input email is normalized the same way, so a padded token
    // email still resolves to the same allowlisted identity.
    expect((await isAdmin(" admin@example.com ")).isAdmin).toBe(true);
  });

  test("honors the role stored on the admin_users row", async () => {
    mockFindAdminUser.mockResolvedValue(
      adminUser("staff@example.com", "editor"),
    );
    const result = await isAdmin("staff@example.com");
    expect(result).toEqual({ isAdmin: true, role: "editor" });
  });

  test("denies a user present in neither the allowlist nor admin_users", async () => {
    vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
    mockFindAdminUser.mockResolvedValue(null);
    expect(await isAdmin("stranger@example.com")).toEqual({
      isAdmin: false,
    });
  });

  test("fails closed — and logs — when the admin_users lookup errors", async () => {
    mockFindAdminUser.mockRejectedValue(new Error("postgres unavailable"));
    expect(await isAdmin("staff@example.com")).toEqual({ isAdmin: false });
    // The failure is denied correctly AND diagnosable: a Postgres
    // outage here would otherwise silently lock out every admin.
    expect(mockLogError).toHaveBeenCalledWith(
      "auth",
      "admin-lookup",
      expect.any(Error),
    );
  });

  test("matches the env allowlist case-insensitively", async () => {
    vi.stubEnv("ADMIN_EMAILS", "Admin@Example.COM");
    expect((await isAdmin("admin@example.com")).isAdmin).toBe(true);
    expect((await isAdmin("ADMIN@EXAMPLE.COM")).isAdmin).toBe(true);
  });

  test("ignores empty allowlist entries from a misconfigured value", async () => {
    vi.stubEnv("ADMIN_EMAILS", ",,,");
    mockFindAdminUser.mockResolvedValue(null);
    expect(await isAdmin("admin@example.com")).toEqual({ isAdmin: false });
    expect(await isAdmin("")).toEqual({ isAdmin: false });
  });

  test("denies a missing or empty email without consulting Postgres", async () => {
    expect(await isAdmin("")).toEqual({ isAdmin: false });
    // @ts-expect-error verifying the runtime guard for missing claims
    expect(await isAdmin(undefined)).toEqual({ isAdmin: false });
    expect(mockFindAdminUser).not.toHaveBeenCalled();
  });
});

describe("getCurrentUser", () => {
  test("returns null when no session cookie exists", async () => {
    mockCookieGet.mockReturnValue(undefined);
    expect(await getCurrentUser()).toBeNull();
    expect(mockVerifySessionCookie).not.toHaveBeenCalled();
  });

  test("returns the decoded claims for a valid session cookie", async () => {
    const claims = { email: "admin@example.com", email_verified: true };
    mockCookieGet.mockReturnValue({ value: "valid-cookie" });
    mockVerifySessionCookie.mockResolvedValue(claims);
    expect(await getCurrentUser()).toEqual(claims);
    expect(mockVerifySessionCookie).toHaveBeenCalledWith("valid-cookie", true);
  });

  test("returns null when the session cookie is invalid or revoked", async () => {
    mockCookieGet.mockReturnValue({ value: "forged-cookie" });
    mockVerifySessionCookie.mockRejectedValue(new Error("invalid"));
    expect(await getCurrentUser()).toBeNull();
  });

  test("expected cookie rejections fail silently — no error noise", async () => {
    mockCookieGet.mockReturnValue({ value: "expired-cookie" });
    mockVerifySessionCookie.mockRejectedValue(
      Object.assign(new Error("expired"), {
        code: "auth/session-cookie-expired",
      }),
    );
    expect(await getCurrentUser()).toBeNull();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  test("unexpected verification failures are logged — Firebase outages must be diagnosable", async () => {
    mockCookieGet.mockReturnValue({ value: "any-cookie" });
    mockVerifySessionCookie.mockRejectedValue(
      Object.assign(new Error("deadline exceeded"), { code: "4" }),
    );
    expect(await getCurrentUser()).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      "session",
      "verify-session-cookie",
      expect.any(Error),
    );
  });
});

describe("isExpectedAuthError", () => {
  test("recognizes routine client-credential rejections", () => {
    for (const code of [
      "auth/id-token-expired",
      "auth/id-token-revoked",
      "auth/invalid-id-token",
      "auth/session-cookie-expired",
      "auth/session-cookie-revoked",
      "auth/invalid-session-cookie",
      "auth/argument-error",
    ]) {
      expect(isExpectedAuthError(Object.assign(new Error("x"), { code })))
        .toBe(true);
    }
  });

  test("does not classify infrastructure failures as expected", () => {
    expect(
      isExpectedAuthError(
        Object.assign(new Error("x"), { code: "auth/internal-error" }),
      ),
    ).toBe(false);
    expect(isExpectedAuthError(new Error("network down"))).toBe(false);
    expect(isExpectedAuthError("weird")).toBe(false);
  });
});

describe("requireAdmin", () => {
  const session = (claims: unknown) => {
    mockCookieGet.mockReturnValue({ value: "session-cookie" });
    mockVerifySessionCookie.mockResolvedValue(claims);
  };

  test("authorizes a verified session whose email is in admin_users", async () => {
    session({ email: "staff@example.com", email_verified: true });
    mockFindAdminUser.mockResolvedValue(
      adminUser("staff@example.com", "editor"),
    );
    const result = await requireAdmin();
    expect(result.authorized).toBe(true);
    expect(result.role).toBe("editor");
    expect(result.user?.email).toBe("staff@example.com");
  });

  test("denies when there is no session cookie", async () => {
    mockCookieGet.mockReturnValue(undefined);
    const result = await requireAdmin();
    expect(result).toEqual({ authorized: false, user: null, role: null });
    expect(mockFindAdminUser).not.toHaveBeenCalled();
  });

  test("denies when the session cookie is invalid, expired, or revoked", async () => {
    mockCookieGet.mockReturnValue({ value: "bad-cookie" });
    mockVerifySessionCookie.mockRejectedValue(new Error("expired"));
    const result = await requireAdmin();
    expect(result).toEqual({ authorized: false, user: null, role: null });
    expect(mockFindAdminUser).not.toHaveBeenCalled();
  });

  test("denies a verified user who is not in admin_users", async () => {
    session({ email: "user@example.com", email_verified: true });
    mockFindAdminUser.mockResolvedValue(null);
    const result = await requireAdmin();
    expect(result.authorized).toBe(false);
    expect(result.role).toBeNull();
  });

  test("fails closed when the admin lookup errors", async () => {
    session({ email: "staff@example.com", email_verified: true });
    mockFindAdminUser.mockRejectedValue(new Error("postgres down"));
    const result = await requireAdmin();
    expect(result.authorized).toBe(false);
  });
});
