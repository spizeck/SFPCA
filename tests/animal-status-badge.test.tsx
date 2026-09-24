// Component tests for the admin animal badges (#167). Two separate
// badges — registry lifecycle and adoption listing — each spell out
// their meaning so admins never rely on color alone; unrecognized
// stored values are surfaced as unknown rather than mislabeled.
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  AnimalAdoptionBadge,
  AnimalLifecycleBadge,
} from "@/components/admin/animal-status-badge";

describe("AnimalLifecycleBadge", () => {
  test.each([
    ["active", "Active on Saba"],
    ["deceased", "Deceased"],
    ["moved-off-saba", "Moved off Saba"],
    ["unknown", "Status unconfirmed"],
  ])("lifecycle %s renders %s", (status, label) => {
    render(<AnimalLifecycleBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  test.each(["available", "adopted", "", "AVAILABLE"])(
    "unrecognized lifecycle %j is labeled Unknown",
    (status) => {
      render(<AnimalLifecycleBadge status={status} />);
      expect(screen.getByText("Unknown")).toBeInTheDocument();
    },
  );
});

describe("AnimalAdoptionBadge", () => {
  test("available on an active animal is labeled and marked public", () => {
    render(
      <AnimalAdoptionBadge status="available" lifecycleStatus="active" />,
    );
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  test.each(["pending", "adopted", "not-listed"])(
    "%s is labeled and marked not public",
    (status) => {
      render(
        <AnimalAdoptionBadge status={status} lifecycleStatus="active" />,
      );
      expect(screen.getByText("Not public")).toBeInTheDocument();
    },
  );

  test("a listed but deceased animal is not public", () => {
    render(
      <AnimalAdoptionBadge status="available" lifecycleStatus="deceased" />,
    );
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("Not public")).toBeInTheDocument();
  });

  test.each(["quarantined", "", "AVAILABLE"])(
    "unrecognized listing state %j is labeled Unknown and marked not public",
    (status) => {
      render(
        <AnimalAdoptionBadge status={status} lifecycleStatus="active" />,
      );
      expect(screen.getByText("Unknown")).toBeInTheDocument();
      expect(screen.getByText("Not public")).toBeInTheDocument();
    },
  );
});
