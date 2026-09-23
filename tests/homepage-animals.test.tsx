// Tests for the homepage adoptable-animals preview (#126). The section
// is covered directly, and the page itself is exercised to prove the
// preview is fed by the canonical public query (getAvailableAnimals —
// the same lifecycle boundary as the listing and detail routes), is
// bounded, and disappears rather than erroring when nothing is
// available.
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetAvailableAnimals, mockGetDoc, mockGetDocs } = vi.hoisted(
  () => ({
    mockGetAvailableAnimals: vi.fn(),
    mockGetDoc: vi.fn(),
    mockGetDocs: vi.fn(),
  }),
);

vi.mock("@/lib/registry/public-animals", () => ({
  getAvailableAnimals: mockGetAvailableAnimals,
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, col: string, id: string) => ({ col, id }),
  getDoc: mockGetDoc,
  collection: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  getDocs: mockGetDocs,
}));

import { AnimalsSection } from "@/components/homepage/animals-section";
import HomePage from "@/app/page";
import type { Animal, Homepage, SiteSettings } from "@/lib/types";

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

const HOMEPAGE: Homepage = {
  hero: { title: "Welcome", subtitle: "To SFPCA" },
  about: { title: "About", content: "We help animals." },
  whoWeAre: { title: "Team", subtitle: "", team: [] },
  services: {
    title: "Services",
    items: [
      { title: "A", description: "a" },
      { title: "B", description: "b" },
      { title: "C", description: "c" },
    ],
  },
  whereWeAre: {
    title: "Find us",
    subtitle: "",
    address: "Saba",
    mapEmbedUrl: "",
    hours: "",
  },
  donation: { title: "Donate", content: "", paymentMethods: "" },
};

const SETTINGS: SiteSettings = {
  contact: { phone: "", email: "", whatsapp: "", address: "", hours: "" },
  social: { facebook: "", instagram: "", twitter: "" },
  mapEmbedUrl: "",
  locationCode: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAvailableAnimals.mockResolvedValue([]);
  mockGetDocs.mockResolvedValue({ forEach: () => {}, docs: [] });
  mockGetDoc.mockImplementation((ref: { col: string }) =>
    Promise.resolve({
      exists: () => true,
      data: () => (ref.col === "homepage" ? HOMEPAGE : SETTINGS),
    }),
  );
});

describe("AnimalsSection", () => {
  test("renders each provided animal as a link to its detail page", () => {
    render(
      <AnimalsSection
        animals={[
          animal({ id: "a1", name: "Buddy" }),
          animal({ id: "a2", name: "Whiskers", species: "cat" }),
        ]}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Learn more about Buddy" }),
    ).toHaveAttribute("href", "/animal-adoptions/a1");
    expect(
      screen.getByRole("link", { name: "Learn more about Whiskers" }),
    ).toHaveAttribute("href", "/animal-adoptions/a2");
  });

  test("links through to the full adoption listing", () => {
    render(<AnimalsSection animals={[animal({})]} />);

    expect(
      screen.getByRole("link", { name: "View All Adoptable Animals" }),
    ).toHaveAttribute("href", "/animal-adoptions");
  });

  test("renders nothing when no animals are available", () => {
    const { container } = render(<AnimalsSection animals={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("homepage animal preview", () => {
  test("uses the canonical public query and bounds the preview to one row", async () => {
    mockGetAvailableAnimals.mockResolvedValue([
      animal({ id: "a1", name: "Buddy" }),
      animal({ id: "a2", name: "Whiskers", species: "cat" }),
      animal({ id: "a3", name: "Charlie" }),
      animal({ id: "a4", name: "Daisy" }),
      animal({ id: "a5", name: "Rocky" }),
    ]);

    render(await HomePage());

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Adoptable Animals" }),
      ).toBeInTheDocument(),
    );
    // The canonical lifecycle boundary — the homepage never reads
    // animals through a separate path.
    expect(mockGetAvailableAnimals).toHaveBeenCalledTimes(1);
    // Bounded to 3: the fourth and fifth animals never render.
    for (const name of ["Buddy", "Whiskers", "Charlie"]) {
      expect(
        screen.getByRole("link", { name: `Learn more about ${name}` }),
      ).toBeInTheDocument();
    }
    expect(screen.queryByText("Daisy")).not.toBeInTheDocument();
    expect(screen.queryByText("Rocky")).not.toBeInTheDocument();
  });

  test("omits the section when the public query returns nothing", async () => {
    // getAvailableAnimals also returns [] on fetch failure, so this
    // covers both the empty and the failed-closed cases: the homepage
    // renders normally without the section.
    mockGetAvailableAnimals.mockResolvedValue([]);

    render(await HomePage());

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Welcome" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("heading", { name: "Adoptable Animals" }),
    ).not.toBeInTheDocument();
  });
});
