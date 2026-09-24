// Tests for the /api/auth/session route handlers — the privileged
// session boundary. The Firebase Admin SDK and Next.js request-context
// boundaries are mocked; the route's own decisions (token verification,
// email verification, admin check, cookie attributes, origin checks,
// env-allowlist bootstrapping) are real.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyIdToken,
  mockCreateSessionCookie,
  mockSetCustomUserClaims,
  mockProvisionAdminUser,
  mockCookieSet,
  mockIsAdmin,
  mockUpsertAuthIdentity,
  mockProvisionOwnerLink,
} = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
  mockCreateSessionCookie: vi.fn(),
  mockSetCustomUserClaims: vi.fn(),
  mockProvisionAdminUser: vi.fn(),
  mockCookieSet: vi.fn(),
  mockIsAdmin: vi.fn(),
  mockUpsertAuthIdentity: vi.fn(),
  mockProvisionOwnerLink: vi.fn(),
}));

vi.mock("@/lib/firebase-admin", () => ({
  adminAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
    createSessionCookie: mockCreateSessionCookie,
    setCustomUserClaims: mockSetCustomUserClaims,
  }),
}));

// Postgres admin_users provisioning — the seam is mocked here; the
// insert semantics are exercised for real in tests/db.
vi.mock("@/lib/registry/admin-users", () => ({
  provisionAdminUser: mockProvisionAdminUser,
}));

// Owner-side identity/provisioning seams (#166) — mocked so the route
// tests exercise the route's own decisions; the real behavior is
// covered against PGlite in tests/db.
vi.mock("@/lib/registry/persons", () => ({
  upsertAuthIdentity: mockUpsertAuthIdentity,
}));
vi.mock("@/lib/registry/owner-requests", () => ({
  provisionOwnerLink: mockProvisionOwnerLink,
}));

// Partial mock: isAdmin is stubbed, but isExpectedAuthError stays real —
// the classification under test decides which failures are routine
// client rejections vs infrastructure errors worth paging on.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  isAdmin: mockIsAdmin,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mockCookieSet }),
}));

import { POST, DELETE } from "@/app/api/auth/session/route";

const FIVE_DAYS_MS = 60 * 60 * 24 * 5 * 1000;
const HOST = "sfpca.example.com";

const postRequest = (
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new NextRequest(`https://${HOST}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const deleteRequest = (headers: Record<string, string> = {}) =>
  new NextRequest(`https://${HOST}/api/auth/session`, {
    method: "DELETE",
    headers,
  });

beforeEach(() => {
  vi.unstubAllEnvs();
  mockVerifyIdToken.mockReset();
  mockCreateSessionCookie.mockReset();
  mockSetCustomUserClaims.mockReset();
  mockProvisionAdminUser.mockReset();
  mockCookieSet.mockReset();
  mockIsAdmin.mockReset();
  mockUpsertAuthIdentity.mockReset();
  mockProvisionOwnerLink.mockReset();
  mockProvisionAdminUser.mockResolvedValue(null);
  mockUpsertAuthIdentity.mockResolvedValue({
    id: "identity-1",
    provider: "firebase",
    providerUid: "uid-1",
    email: "user@example.com",
    personId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  mockProvisionOwnerLink.mockResolvedValue({
    status: "created",
    person: { id: "person-1" },
  });
});

describe("POST /api/auth/session", () => {
  test("issues a 5-day httpOnly sameSite=lax session cookie for a verified admin", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockCreateSessionCookie.mockResolvedValue("signed-session-cookie");

    const response = await POST(postRequest({ idToken: "valid-token" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authorized: true,
      isAdmin: true,
      role: "admin",
    });
    expect(mockVerifyIdToken).toHaveBeenCalledWith("valid-token");
    expect(mockCreateSessionCookie).toHaveBeenCalledWith("valid-token", {
      expiresIn: FIVE_DAYS_MS,
    });
    expect(mockCookieSet).toHaveBeenCalledWith(
      "session",
      "signed-session-cookie",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: FIVE_DAYS_MS,
        secure: false, // NODE_ENV=test → not production
      }),
    );
  });

  test("marks the cookie secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockCreateSessionCookie.mockResolvedValue("cookie");

    await POST(postRequest({ idToken: "valid-token" }));
    expect(mockCookieSet).toHaveBeenCalledWith(
      "session",
      "cookie",
      expect.objectContaining({ secure: true }),
    );
  });

  test("rejects an unverified email before checking admin status", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: false,
    });

    const response = await POST(postRequest({ idToken: "token" }));
    expect(response.status).toBe(403);
    expect((await response.json()).authorized).toBe(false);
    expect(mockIsAdmin).not.toHaveBeenCalled();
    expect(mockCreateSessionCookie).not.toHaveBeenCalled();
  });

  test("issues an owner session for a verified non-admin and clears their claim", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "user@example.com",
      email_verified: true,
      uid: "uid-1",
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: false });

    const response = await POST(postRequest({ idToken: "token" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authorized: true,
      isAdmin: false,
      owner: "created",
    });
    // The owner session cookie is real — but the admin claim is
    // explicitly cleared so a removed admin's rules-side access cannot
    // linger in a stale token.
    expect(mockCreateSessionCookie).toHaveBeenCalled();
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith("uid-1", {
      admin: false,
    });
    expect(mockProvisionAdminUser).not.toHaveBeenCalled();
    // The owner-side identity was materialized and provisioned.
    expect(mockUpsertAuthIdentity).toHaveBeenCalledWith({
      providerUid: "uid-1",
      email: "user@example.com",
    });
    expect(mockProvisionOwnerLink).toHaveBeenCalled();
  });

  test("still issues the session when owner provisioning fails", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "user@example.com",
      email_verified: true,
      uid: "uid-2",
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: false });
    mockUpsertAuthIdentity.mockRejectedValue(new Error("db down"));

    const response = await POST(postRequest({ idToken: "token" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authorized: true,
      isAdmin: false,
      owner: "unavailable",
    });
    expect(mockCreateSessionCookie).toHaveBeenCalled();
  });

  test("rejects an invalid or malformed token with 401", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("bad token"));
    const response = await POST(postRequest({ idToken: "forged" }));
    expect(response.status).toBe(401);
    expect(mockCreateSessionCookie).not.toHaveBeenCalled();
  });

  test("rejects a malformed request body with 401", async () => {
    const response = await POST(postRequest("not-json{{{"));
    expect(response.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  test("provisions the admin_users row and sets the admin claim on login", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
      uid: "uid-admin",
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockCreateSessionCookie.mockResolvedValue("cookie");

    await POST(postRequest({ idToken: "token" }));
    expect(mockProvisionAdminUser).toHaveBeenCalledWith("staff@example.com");
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith("uid-admin", {
      admin: true,
      adminRole: "admin",
    });
  });

  test("accepts a same-origin request", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockCreateSessionCookie.mockResolvedValue("cookie");

    const response = await POST(
      postRequest({ idToken: "token" }, { origin: `https://${HOST}` }),
    );
    expect(response.status).toBe(200);
  });

  test("rejects a cross-origin POST (login CSRF)", async () => {
    const response = await POST(
      postRequest({ idToken: "token" }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockCreateSessionCookie).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/auth/session", () => {
  test("clears the session cookie with matching attributes", async () => {
    const response = await DELETE(deleteRequest());
    expect(response.status).toBe(200);
    expect(mockCookieSet).toHaveBeenCalledWith(
      "session",
      "",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      }),
    );
  });

  test("rejects a cross-site DELETE (forced-logout CSRF)", async () => {
    const response = await DELETE(
      deleteRequest({ origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});
