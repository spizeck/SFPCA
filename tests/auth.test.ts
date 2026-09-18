// Authorization/session helper tests. Only the Firebase Admin SDK and
// Next.js request-context boundaries are mocked; the authorization
// decisions under test are real.
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockAdminGet, mockDocId, mockVerifySessionCookie, mockCookieGet } =
  vi.hoisted(() => ({
    mockAdminGet: vi.fn(),
    mockDocId: vi.fn(),
    mockVerifySessionCookie: vi.fn(),
    mockCookieGet: vi.fn(),
  }));

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: () => ({
      doc: (id: string) => {
        mockDocId(id);
        return { get: mockAdminGet };
      },
    }),
  }),
  adminAuth: () => ({
    verifySessionCookie: mockVerifySessionCookie,
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));

import { getCurrentUser, isAdmin, requireAdmin } from "@/lib/auth";

const adminDoc = (exists: boolean, data?: Record<string, unknown>) => ({
  exists,
  data: () => data,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  // Neutralize any ambient ADMIN_EMAILS so each test controls the
  // allowlist explicitly.
  vi.stubEnv("ADMIN_EMAILS", "");
  mockAdminGet.mockReset();
  mockDocId.mockReset();
  mockVerifySessionCookie.mockReset();
  mockCookieGet.mockReset();
});

describe("isAdmin", () => {
  test("grants admin role from the ADMIN_EMAILS allowlist without hitting Firestore", async () => {
    vi.stubEnv("ADMIN_EMAILS", "admin@example.com,editor@example.com");
    const result = await isAdmin("admin@example.com");
    expect(result).toEqual({ isAdmin: true, role: "admin" });
    expect(mockAdminGet).not.toHaveBeenCalled();
  });

  test("trims whitespace around allowlist entries", async () => {
    vi.stubEnv("ADMIN_EMAILS", "  admin@example.com , other@example.com ");
    mockAdminGet.mockResolvedValue(adminDoc(false));
    expect((await isAdmin("admin@example.com")).isAdmin).toBe(true);
    expect((await isAdmin("other@example.com")).isAdmin).toBe(true);
    // The input email is normalized the same way, so a padded token
    // email still resolves to the same allowlisted identity.
    expect((await isAdmin(" admin@example.com ")).isAdmin).toBe(true);
  });

  test("honors the role stored on the admins document", async () => {
    mockAdminGet.mockResolvedValue(adminDoc(true, { role: "editor" }));
    const result = await isAdmin("staff@example.com");
    expect(result).toEqual({ isAdmin: true, role: "editor" });
  });

  test("defaults to editor when the admins document has no role", async () => {
    mockAdminGet.mockResolvedValue(adminDoc(true, { email: "x@example.com" }));
    const result = await isAdmin("staff@example.com");
    expect(result).toEqual({ isAdmin: true, role: "editor" });
  });

  test("denies a user present in neither the allowlist nor the collection", async () => {
    vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
    mockAdminGet.mockResolvedValue(adminDoc(false));
    expect(await isAdmin("stranger@example.com")).toEqual({
      isAdmin: false,
    });
  });

  test("fails closed when Firestore lookup errors", async () => {
    mockAdminGet.mockRejectedValue(new Error("firestore unavailable"));
    expect(await isAdmin("staff@example.com")).toEqual({ isAdmin: false });
  });

  test("matches the env allowlist case-insensitively", async () => {
    vi.stubEnv("ADMIN_EMAILS", "Admin@Example.COM");
    expect((await isAdmin("admin@example.com")).isAdmin).toBe(true);
    expect((await isAdmin("ADMIN@EXAMPLE.COM")).isAdmin).toBe(true);
  });

  test("ignores empty allowlist entries from a misconfigured value", async () => {
    vi.stubEnv("ADMIN_EMAILS", ",,,");
    mockAdminGet.mockResolvedValue(adminDoc(false));
    expect(await isAdmin("admin@example.com")).toEqual({ isAdmin: false });
    expect(await isAdmin("")).toEqual({ isAdmin: false });
  });

  test("denies a missing or empty email without consulting Firestore", async () => {
    expect(await isAdmin("")).toEqual({ isAdmin: false });
    // @ts-expect-error verifying the runtime guard for missing claims
    expect(await isAdmin(undefined)).toEqual({ isAdmin: false });
    expect(mockAdminGet).not.toHaveBeenCalled();
  });

  test("looks up the admins document by the exact (un-normalized) email", async () => {
    // The security rules key admins/<email> on the exact token email, so
    // doc lookup must not be lowercased even though env matching is.
    mockAdminGet.mockResolvedValue(adminDoc(false));
    await isAdmin("MixedCase@Example.com");
    expect(mockDocId).toHaveBeenCalledWith("MixedCase@Example.com");
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
});

describe("requireAdmin", () => {
  const session = (claims: unknown) => {
    mockCookieGet.mockReturnValue({ value: "session-cookie" });
    mockVerifySessionCookie.mockResolvedValue(claims);
  };

  test("authorizes a verified session whose email is in the admins collection", async () => {
    session({ email: "staff@example.com", email_verified: true });
    mockAdminGet.mockResolvedValue(adminDoc(true, { role: "editor" }));
    const result = await requireAdmin();
    expect(result.authorized).toBe(true);
    expect(result.role).toBe("editor");
    expect(result.user?.email).toBe("staff@example.com");
  });

  test("denies when there is no session cookie", async () => {
    mockCookieGet.mockReturnValue(undefined);
    const result = await requireAdmin();
    expect(result).toEqual({ authorized: false, user: null, role: null });
    expect(mockAdminGet).not.toHaveBeenCalled();
  });

  test("denies when the session cookie is invalid, expired, or revoked", async () => {
    mockCookieGet.mockReturnValue({ value: "bad-cookie" });
    mockVerifySessionCookie.mockRejectedValue(new Error("expired"));
    const result = await requireAdmin();
    expect(result).toEqual({ authorized: false, user: null, role: null });
    expect(mockAdminGet).not.toHaveBeenCalled();
  });

  test("denies a verified user who is not in the admins collection", async () => {
    session({ email: "user@example.com", email_verified: true });
    mockAdminGet.mockResolvedValue(adminDoc(false));
    const result = await requireAdmin();
    expect(result.authorized).toBe(false);
    expect(result.role).toBeNull();
  });

  test("fails closed when the admin lookup errors", async () => {
    session({ email: "staff@example.com", email_verified: true });
    mockAdminGet.mockRejectedValue(new Error("firestore down"));
    const result = await requireAdmin();
    expect(result.authorized).toBe(false);
  });
});
