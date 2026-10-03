// Tests for /api/app-state (#275): the banner depends on this endpoint
// telling confirmed 'live' apart from an unreadable lifecycle — a failed
// app_state read must NOT answer 'live' or the banner could drop the
// fictional-data label mid-demo while data is still served.
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockLifecycleStrict } = vi.hoisted(() => ({
  mockLifecycleStrict: vi.fn(),
}));

vi.mock("@/lib/app-lifecycle", () => ({
  getAppLifecycleStrict: mockLifecycleStrict,
}));

import { GET } from "@/app/api/app-state/route";

beforeEach(() => {
  mockLifecycleStrict.mockReset();
});

describe("GET /api/app-state", () => {
  test("returns the confirmed lifecycle", async () => {
    mockLifecycleStrict.mockResolvedValue("prelaunch-demo");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lifecycle: "prelaunch-demo",
    });
  });

  test("a failed lifecycle read answers 503, never a guessed 'live'", async () => {
    mockLifecycleStrict.mockResolvedValue(undefined);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ lifecycle: "unavailable" });
  });
});
