// Component tests for the admin animal status badge. Admins must be able
// to tell public from non-public states without relying on color alone —
// every badge spells out its visibility, and unrecognized stored values
// are surfaced as unknown rather than mislabeled.
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { AnimalStatusBadge } from "@/components/admin/animal-status-badge";

describe("AnimalStatusBadge", () => {
  test("available animals are labeled and marked public", () => {
    render(<AnimalStatusBadge status="available" />);
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  test.each(["pending", "adopted"])(
    "%s animals are labeled and marked not public",
    (status) => {
      render(<AnimalStatusBadge status={status} />);
      expect(
        screen.getByText(status === "pending" ? "Pending" : "Adopted"),
      ).toBeInTheDocument();
      expect(screen.getByText("Not public")).toBeInTheDocument();
    },
  );

  test.each(["quarantined", "", "AVAILABLE"])(
    "unrecognized status %j is labeled Unknown and marked not public",
    (status) => {
      render(<AnimalStatusBadge status={status} />);
      expect(screen.getByText("Unknown")).toBeInTheDocument();
      expect(screen.getByText("Not public")).toBeInTheDocument();
    },
  );
});
