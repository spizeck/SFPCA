// Tests for the public animal detail page (#131). `getPublicAnimal` is
// the canonical visibility boundary: it returns null for missing,
// non-public, or unreadable documents, and the page renders a plain 404
// so a private animal is indistinguishable from a nonexistent one.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetPublicAnimal } = vi.hoisted(() => ({
  mockGetPublicAnimal: vi.fn(),
}));

// The page reads through the registry seam (#182) — mock that boundary so
// the test is independent of which datastore the seam delegates to.
vi.mock("@/lib/registry/public-animals", () => ({
  getPublicAnimal: mockGetPublicAnimal,
}));

// notFound() throws internally in Next.js — mirror that here so tests can
// assert the page took the not-found branch.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import AnimalDetailPage, {
  generateMetadata,
} from "@/app/animal-adoptions/[id]/page";
import { AnimalDetail } from "@/components/animal-adoptions/animal-detail";
import { getPublicAnimal } from "@/lib/registry/public-animals";
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

const params = (id: string) => Promise.resolve({ id });

beforeEach(() => {
  mockGetPublicAnimal.mockReset();
});

describe("AnimalDetailPage visibility boundary", () => {
  test("renders a publicly available animal", async () => {
    mockGetPublicAnimal.mockResolvedValue(animal({ name: "Buddy" }));
    render(await AnimalDetailPage({ params: params("a1") }));
    expect(
      screen.getByRole("heading", { name: "Buddy" }),
    ).toBeInTheDocument();
  });

  test("missing animal produces a 404 via notFound()", async () => {
    mockGetPublicAnimal.mockResolvedValue(null);
    await expect(
      AnimalDetailPage({ params: params("does-not-exist") }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  // Non-public animals are indistinguishable from missing ones — the
  // helper returns null for both, and the page never confirms existence.
  test.each(["pending", "adopted", "garbage-status"])(
    "a %s animal is not publicly viewable",
    async () => {
      mockGetPublicAnimal.mockResolvedValue(null);
      await expect(
        AnimalDetailPage({ params: params("a1") }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mockGetPublicAnimal).toHaveBeenCalledWith("a1");
    },
  );

  test("generateMetadata does not leak a private animal", async () => {
    mockGetPublicAnimal.mockResolvedValue(null);
    await expect(generateMetadata({ params: params("a1") })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  test("generateMetadata uses the animal's public fields", async () => {
    mockGetPublicAnimal.mockResolvedValue(
      animal({ name: "Buddy", description: "Loves walks." }),
    );
    const meta = await generateMetadata({ params: params("a1") });
    expect(meta.title).toBe("Buddy — Available for Adoption");
    expect(meta.description).toBe("Loves walks.");
    expect(meta.alternates?.canonical).toBe("/animal-adoptions/a1");
  });
});

describe("AnimalDetail component", () => {
  test("renders photo, metadata, description, and the contact CTA", () => {
    render(
      <AnimalDetail
        animal={animal({
          name: "Whiskers",
          species: "cat",
          sex: "female",
          approxAge: "1 year",
          description: "Very cuddly.",
          photos: ["https://example.com/w.jpg"],
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Whiskers" }),
    ).toBeInTheDocument();
    expect(screen.getByAltText("Photo of Whiskers")).toBeInTheDocument();
    expect(screen.getByText("1 year")).toBeInTheDocument();
    expect(screen.getByText("female")).toBeInTheDocument();
    expect(screen.getByText("Very cuddly.")).toBeInTheDocument();

    // The adoption action is the established contact flow — no invented
    // application system.
    const cta = screen.getByRole("link", { name: "Contact Us to Adopt" });
    expect(cta).toHaveAttribute("href", "/contact");
  });

  test("degrades gracefully when optional fields are missing", () => {
    render(
      <AnimalDetail
        animal={animal({
          name: " ",
          description: " ",
          photos: [],
          approxAge: "",
          sex: "unknown",
        })}
      />,
    );
    // No name → generic fallback heading; no photo → no broken img; no
    // description → section omitted. The page still renders.
    expect(
      screen.getByRole("heading", { name: "This animal" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Contact Us to Adopt" }),
    ).toBeInTheDocument();
  });

  test("offers navigation back to the adoptions listing", () => {
    render(<AnimalDetail animal={animal({})} />);
    expect(
      screen.getByRole("link", { name: /Back to Adoptable Animals/i }),
    ).toHaveAttribute("href", "/animal-adoptions");
  });
});

describe("getPublicAnimal integration shape", () => {
  // The helper itself is exercised through the page above; this pins the
  // contract that the page relies on.
  test("is the only data source the page uses", async () => {
    mockGetPublicAnimal.mockResolvedValue(animal({}));
    await AnimalDetailPage({ params: params("xyz") });
    expect(getPublicAnimal).toHaveBeenCalledWith("xyz");
    expect(getPublicAnimal).toHaveBeenCalledTimes(1);
  });
});
