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
  mockAdminGet,
  mockAdminSet,
  mockCookieSet,
  mockIsAdmin,
} = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
  mockCreateSessionCookie: vi.fn(),
  mockAdminGet: vi.fn(),
  mockAdminSet: vi.fn(),
  mockCookieSet: vi.fn(),
  mockIsAdmin: vi.fn(),
}));

vi.mock("@/lib/firebase-admin", () => ({
  adminAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
    createSessionCookie: mockCreateSessionCookie,
  }),
  adminDb: () => ({
    collection: () => ({
      doc: () => ({ get: mockAdminGet, set: mockAdminSet }),
    }),
  }),
}));

vi.mock("@/lib/auth", () => ({
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
  mockAdminGet.mockReset();
  mockAdminSet.mockReset();
  mockCookieSet.mockReset();
  mockIsAdmin.mockReset();
});

describe("POST /api/auth/session", () => {
  test("issues a 5-day httpOnly sameSite=lax session cookie for a verified admin", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockAdminGet.mockResolvedValue({ exists: true });
    mockCreateSessionCookie.mockResolvedValue("signed-session-cookie");

    const response = await POST(postRequest({ idToken: "valid-token" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ authorized: true, role: "admin" });
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
    mockAdminGet.mockResolvedValue({ exists: true });
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

  test("rejects a verified user who is not an admin", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "user@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: false });

    const response = await POST(postRequest({ idToken: "token" }));
    expect(response.status).toBe(403);
    expect((await response.json()).authorized).toBe(false);
    expect(mockCreateSessionCookie).not.toHaveBeenCalled();
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

  test("bootstraps an admins/ doc for an env-allowlisted admin", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockAdminGet.mockResolvedValue({ exists: false });
    mockCreateSessionCookie.mockResolvedValue("cookie");

    await POST(postRequest({ idToken: "token" }));
    expect(mockAdminSet).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "staff@example.com",
        role: "admin",
      }),
    );
  });

  test("does not rewrite an existing admins/ doc", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockAdminGet.mockResolvedValue({ exists: true });
    mockCreateSessionCookie.mockResolvedValue("cookie");

    await POST(postRequest({ idToken: "token" }));
    expect(mockAdminSet).not.toHaveBeenCalled();
  });

  test("accepts a same-origin request", async () => {
    mockVerifyIdToken.mockResolvedValue({
      email: "staff@example.com",
      email_verified: true,
    });
    mockIsAdmin.mockResolvedValue({ isAdmin: true, role: "admin" });
    mockAdminGet.mockResolvedValue({ exists: true });
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
