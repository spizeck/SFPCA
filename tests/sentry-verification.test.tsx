// Tests for the controlled Sentry verification mechanism (#140): the
// server action re-checks admin authorization itself (actions are POST
// endpoints, not covered by AdminLayout), and both triggers produce
// the unmistakable synthetic marker through real capture paths.
// @sentry/nextjs is mocked — nothing here can contact sentry.io.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const requireAdmin = vi.fn();
const captureException = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireAdmin: (...args: unknown[]) => requireAdmin(...args),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

import {
  SENTRY_VERIFICATION_MARKER,
  sentryVerificationError,
} from "@/lib/sentry-verification";
import { fireSentryVerification } from "@/app/admin/sentry-check/actions";
import { SentryCheckPanel } from "@/components/admin/sentry-check-panel";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sentryVerificationError", () => {
  test("produces the unmistakable synthetic marker per surface", () => {
    expect(sentryVerificationError("browser").message).toContain(
      `${SENTRY_VERIFICATION_MARKER}:browser`,
    );
    expect(sentryVerificationError("server").message).toContain(
      `${SENTRY_VERIFICATION_MARKER}:server`,
    );
    // Synthetic only — nothing that resembles real customer data.
    for (const surface of ["browser", "server"] as const) {
      const msg = sentryVerificationError(surface).message;
      expect(msg).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      expect(msg).not.toMatch(/receipts\//);
      expect(msg).not.toMatch(/Bearer\s+\S+/i);
    }
  });
});

describe("fireSentryVerification (server action)", () => {
  test("anonymous/non-admin calls return quietly — no throw, no event", async () => {
    requireAdmin.mockResolvedValue({ authorized: false, user: null });
    await expect(fireSentryVerification()).resolves.toEqual({
      fired: false,
    });
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
  });

  test("authorized admin produces the synthetic server error", async () => {
    requireAdmin.mockResolvedValue({ authorized: true, user: {} });
    await expect(fireSentryVerification()).rejects.toThrow(
      `${SENTRY_VERIFICATION_MARKER}:server`,
    );
  });
});

describe("SentryCheckPanel", () => {
  test("renders both triggers and the verification marker", () => {
    render(<SentryCheckPanel />);
    expect(
      screen.getByRole("button", { name: /Throw browser test error/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Throw server test error/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(SENTRY_VERIFICATION_MARKER)).toBeInTheDocument();
  });

  test("browser button throws through the contained real ErrorFallback path", () => {
    render(<SentryCheckPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: /Throw browser test error/ }),
    );
    // The synthetic crash is contained by the panel's own boundary and
    // renders the same shared ErrorFallback visitors hit — one
    // captureException through the real #139 capture site.
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0].message).toContain(
      `${SENTRY_VERIFICATION_MARKER}:browser`,
    );
    // The rest of the panel survived — the other triggers still render.
    expect(
      screen.getByRole("button", { name: /Throw server test error/ }),
    ).toBeInTheDocument();
    // "Try again" resets the boundary and restores the trigger.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      screen.getByRole("button", { name: /Throw browser test error/ }),
    ).toBeInTheDocument();
  });

  test("server button reports not-authorized without throwing an event", async () => {
    requireAdmin.mockResolvedValue({ authorized: false, user: null });
    render(<SentryCheckPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: /Throw server test error/ }),
    );
    await screen.findByText(/Not authorized — no event was sent/);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
  });

  test("server button surfaces the thrown verification path for admins", async () => {
    requireAdmin.mockResolvedValue({ authorized: true, user: {} });
    render(<SentryCheckPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: /Throw server test error/ }),
    );
    await screen.findByText(/Server test error thrown/);
  });
});
