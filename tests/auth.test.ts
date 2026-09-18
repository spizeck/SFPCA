// Authorization/session helper tests. Only the Firebase Admin SDK and
// Next.js request-context boundaries are mocked; the authorization
// decisions under test are real.
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockAdminGet, mockVerifySessionCookie, mockCookieGet } = vi.hoisted(
  () => ({
    mockAdminGet: vi.fn(),
    mockVerifySessionCookie: vi.fn(),
    mockCookieGet: vi.fn(),
  }),
);

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: () => ({ doc: () => ({ get: mockAdminGet }) }),
  }),
  adminAuth: () => ({
    verifySessionCookie: mockVerifySessionCookie,
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));

import { getCurrentUser, isAdmin } from "@/lib/auth";

const adminDoc = (exists: boolean, data?: Record<string, unknown>) => ({
  exists,
  data: () => data,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  mockAdminGet.mockReset();
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
    expect((await isAdmin(" admin@example.com")).isAdmin).toBe(false);
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
