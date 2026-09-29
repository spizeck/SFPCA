// Server-action authorization tests. A "use server" export is callable
// by direct HTTP request — not only through the admin UI — so each one
// must self-authorize via requireAdmin(). The Firestore Admin SDK and
// the auth helper are mocked; the authorization gate under test is real.
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockRequireAdmin, mockDocSet, mockDocGet } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockDocSet: vi.fn(),
  mockDocGet: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: () => ({
      doc: () => ({ set: mockDocSet, get: mockDocGet }),
    }),
  }),
}));

import {
  saveHomepageData,
  loadHomepageData,
} from "@/app/admin/homepage/actions";
import type { Homepage } from "@/lib/types";

const homepage = { hero: { title: "t", subtitle: "s" } } as Homepage;

beforeEach(() => {
  mockRequireAdmin.mockReset();
  mockDocSet.mockReset();
  mockDocGet.mockReset();
});

describe("saveHomepageData", () => {
  test("rejects a direct invocation without an admin session", async () => {
    mockRequireAdmin.mockResolvedValue({
      authorized: false,
      user: null,
      role: null,
    });
    await expect(saveHomepageData(homepage)).rejects.toThrow("Unauthorized");
    expect(mockDocSet).not.toHaveBeenCalled();
  });

  test("rejects an authenticated non-admin session", async () => {
    mockRequireAdmin.mockResolvedValue({
      authorized: false,
      user: { email: "user@example.com" },
      role: null,
    });
    await expect(saveHomepageData(homepage)).rejects.toThrow("Unauthorized");
    expect(mockDocSet).not.toHaveBeenCalled();
  });

  test("writes homepage/main for an authorized admin", async () => {
    mockRequireAdmin.mockResolvedValue({
      authorized: true,
      user: { email: "staff@example.com" },
      role: "admin",
    });
    mockDocSet.mockResolvedValue(undefined);
    await expect(saveHomepageData(homepage)).resolves.toEqual({
      ok: true,
    });
    expect(mockDocSet).toHaveBeenCalledWith(homepage);
  });

  test("a Firestore failure returns ok:false instead of rethrowing", async () => {
    // logError already reported the real error — a rethrow would be
    // captured a second time by onRequestError.
    mockRequireAdmin.mockResolvedValue({
      authorized: true,
      user: { email: "staff@example.com" },
      role: "admin",
    });
    mockDocSet.mockRejectedValue(new Error("deadline exceeded"));
    await expect(saveHomepageData(homepage)).resolves.toEqual({
      ok: false,
    });
  });
});

describe("loadHomepageData", () => {
  test("rejects a direct invocation without an admin session", async () => {
    mockRequireAdmin.mockResolvedValue({
      authorized: false,
      user: null,
      role: null,
    });
    await expect(loadHomepageData()).rejects.toThrow("Unauthorized");
    expect(mockDocGet).not.toHaveBeenCalled();
  });

  test("returns the document for an authorized admin", async () => {
    mockRequireAdmin.mockResolvedValue({
      authorized: true,
      user: { email: "staff@example.com" },
      role: "admin",
    });
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ hero: { title: "Hello" } }),
    });
    await expect(loadHomepageData()).resolves.toEqual({
      ok: true,
      data: { hero: { title: "Hello" } },
    });
  });

  test("a missing document resolves ok:true with null data", async () => {
    mockRequireAdmin.mockResolvedValue({
      authorized: true,
      user: { email: "staff@example.com" },
      role: "admin",
    });
    mockDocGet.mockResolvedValue({ exists: false });
    await expect(loadHomepageData()).resolves.toEqual({
      ok: true,
      data: null,
    });
  });

  test("a Firestore failure returns ok:false instead of rethrowing", async () => {
    mockRequireAdmin.mockResolvedValue({
      authorized: true,
      user: { email: "staff@example.com" },
      role: "admin",
    });
    mockDocGet.mockRejectedValue(new Error("deadline exceeded"));
    await expect(loadHomepageData()).resolves.toEqual({ ok: false });
  });
});
