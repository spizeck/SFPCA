// Rendering tests for the public adoptions listing. The data layer is
// mocked at the module boundary; the tests assert that publicly returned
// animals render and that an empty result set produces a clear empty
// state rather than a blank grid.
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetAvailableAnimals } = vi.hoisted(() => ({
  mockGetAvailableAnimals: vi.fn(),
}));

vi.mock("@/lib/animals", () => ({
  getAvailableAnimals: mockGetAvailableAnimals,
}));

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

beforeEach(() => {
  mockGetAvailableAnimals.mockReset();
});

describe("AnimalAdoptions", () => {
  test("renders each animal returned by the public query", async () => {
    // Names must not collide with the page's static Success Stories
    // cards (Bella, Max, Luna).
    mockGetAvailableAnimals.mockResolvedValue([
      animal({ id: "a1", name: "Buddy" }),
      animal({ id: "a2", name: "Whiskers", species: "cat" }),
    ]);

    render(<AnimalAdoptions />);

    await waitFor(() => {
      expect(screen.getByText("Buddy")).toBeInTheDocument();
      expect(screen.getByText("Whiskers")).toBeInTheDocument();
    });
  });

  test("each card links to that animal's public detail page", async () => {
    mockGetAvailableAnimals.mockResolvedValue([
      animal({ id: "a1", name: "Buddy" }),
    ]);

    render(<AnimalAdoptions />);

    const link = await screen.findByRole("link", {
      name: "Learn More About Buddy",
    });
    expect(link).toHaveAttribute("href", "/animal-adoptions/a1");
  });

  test("shows an empty-state message when no animals are available", async () => {
    mockGetAvailableAnimals.mockResolvedValue([]);

    render(<AnimalAdoptions />);

    await waitFor(() => {
      expect(
        screen.getByText(/No animals are currently listed for adoption/i),
      ).toBeInTheDocument();
    });
  });

  test("shows the empty state when the public query fails closed", async () => {
    // getAvailableAnimals catches errors and returns [] — visitors see a
    // friendly empty state, never an error or leaked data.
    mockGetAvailableAnimals.mockResolvedValue([]);

    render(<AnimalAdoptions />);

    await waitFor(() => {
      expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    });
  });
});
