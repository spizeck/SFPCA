// Rendering tests for the public adoptions listing. Animals arrive as a
// server-fetched prop (#182 — the registry read seam is server-side), so
// the tests assert that provided animals render and that an empty list
// produces a clear empty state rather than a blank grid.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { AnimalAdoptions } from "@/components/animal-adoptions/animal-adoptions-page";
import type { Animal } from "@/lib/types";

function animal(overrides: Partial<Animal>): Animal {
  return {
    id: "a1",
    name: "Buddy",
    species: "dog",
    sex: "male",
    approxAge: "2 years",
    description: "A friendly dog.",
    status: "available",
    photos: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AnimalAdoptions", () => {
  test("renders each animal provided by the server", () => {
    // Names must not collide with the page's static Success Stories
    // cards (Bella, Max, Luna).
    render(
      <AnimalAdoptions
        animals={[
          animal({ id: "a1", name: "Buddy" }),
          animal({ id: "a2", name: "Whiskers", species: "cat" }),
        ]}
      />,
    );

    expect(screen.getByText("Buddy")).toBeInTheDocument();
    expect(screen.getByText("Whiskers")).toBeInTheDocument();
  });

  test("each card links to that animal's public detail page", () => {
    render(<AnimalAdoptions animals={[animal({ id: "a1", name: "Buddy" })]} />);

    const link = screen.getByRole("link", {
      name: "Learn More About Buddy",
    });
    expect(link).toHaveAttribute("href", "/animal-adoptions/a1");
  });

  test("species filter narrows the rendered cards", () => {
    render(
      <AnimalAdoptions
        animals={[
          animal({ id: "a1", name: "Buddy", species: "dog" }),
          animal({ id: "a2", name: "Whiskers", species: "cat" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cats" }));
    expect(screen.queryByText("Buddy")).not.toBeInTheDocument();
    expect(screen.getByText("Whiskers")).toBeInTheDocument();
  });

  test("shows an empty-state message when no animals are available", () => {
    render(<AnimalAdoptions animals={[]} />);

    expect(
      screen.getByText(/No animals are currently listed for adoption/i),
    ).toBeInTheDocument();
  });
});
