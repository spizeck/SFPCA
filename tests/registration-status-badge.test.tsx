// Rendering tests for the registration status badge used by staff. Every
// supported status must have a clear label, and unknown/malformed values
// must surface as needing attention rather than being silently coerced.
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { RegistrationStatusBadge } from "@/components/admin/registration-status-badge";

describe("RegistrationStatusBadge", () => {
  test.each([
    ["pending", "Pending"],
    ["approved", "Verified"],
    ["rejected", "Rejected"],
  ])("renders %s as %s", (status, label) => {
    render(<RegistrationStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/Needs review/)).not.toBeInTheDocument();
  });

  test("unknown statuses surface as needing attention", () => {
    render(<RegistrationStatusBadge status="archived" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();
  });
});
