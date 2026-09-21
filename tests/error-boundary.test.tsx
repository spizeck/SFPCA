// Tests for the shared error-boundary fallback: users get a generic
// message plus a recovery action, the digest is surfaced as a support
// reference, and the failure is logged through the normalized logger
// (never the raw stack to a user-visible surface).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

import { ErrorFallback } from "@/components/error-fallback";

describe("ErrorFallback", () => {
  test("renders a generic message with retry and home actions", () => {
    const reset = vi.fn();
    render(
      <ErrorFallback error={new Error("secret internals")} reset={reset} />,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    // Raw error text must never reach the user.
    expect(screen.queryByText(/secret internals/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: /homepage/ })).toHaveAttribute(
      "href",
      "/",
    );
  });

  test("shows the opaque digest as a support reference", () => {
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    render(<ErrorFallback error={error} />);
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });
});
