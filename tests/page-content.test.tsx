// Tests for the #129 page-content wiring: the public adoptions and
// registration pages render the admin-managed `animalAdoptions/main` and
// `animalRegistration/main` documents, fall back to safe defaults when a
// document is absent or malformed, and the admin editor writes the
// canonical document without fee fields (fees are code constants).
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetAvailableAnimals } = vi.hoisted(() => ({
  mockGetAvailableAnimals: vi.fn(),
}));

vi.mock("@/lib/registry/public-animals", () => ({
  getAvailableAnimals: mockGetAvailableAnimals,
}));

// The registration component imports the Firebase SDKs for form
// submission; stub them so importing it never touches a real backend.
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  setDoc: vi.fn(),
  serverTimestamp: vi.fn(),
}));

vi.mock("firebase/storage", () => ({
  ref: vi.fn(),
  uploadBytes: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({ db: {}, storage: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { AnimalAdoptions } from "@/components/animal-adoptions/animal-adoptions-page";
import { AnimalRegistration } from "@/components/animal-registration/animal-registration-page";
import {
  DEFAULT_ADOPTIONS_CONTENT,
  DEFAULT_REGISTRATION_CONTENT,
  normalizeAdoptionsContent,
  normalizeRegistrationContent,
} from "@/lib/page-content";

beforeEach(() => {
  mockGetAvailableAnimals.mockReset().mockResolvedValue([]);
});

describe("normalizeAdoptionsContent", () => {
  test("returns defaults for a missing or non-object document", () => {
    expect(normalizeAdoptionsContent(null)).toEqual(DEFAULT_ADOPTIONS_CONTENT);
    expect(normalizeAdoptionsContent("junk")).toEqual(
      DEFAULT_ADOPTIONS_CONTENT,
    );
    expect(normalizeAdoptionsContent(42)).toEqual(DEFAULT_ADOPTIONS_CONTENT);
  });

  test("keeps valid fields and falls back per-field for bad ones", () => {
    const result = normalizeAdoptionsContent({
      heroTitle: "Adopt Today",
      heroDescription: 123,
      successStories: "not-an-array",
      partners: [{ name: "SABA Vet", logo: "🏥" }, { broken: true }],
    });
    expect(result.heroTitle).toBe("Adopt Today");
    expect(result.heroDescription).toBe(
      DEFAULT_ADOPTIONS_CONTENT.heroDescription,
    );
    expect(result.successStories).toEqual(
      DEFAULT_ADOPTIONS_CONTENT.successStories,
    );
    expect(result.partners).toEqual([{ name: "SABA Vet", logo: "🏥" }]);
  });

  test("an empty stories array falls back to defaults", () => {
    const result = normalizeAdoptionsContent({ successStories: [] });
    expect(result.successStories).toEqual(
      DEFAULT_ADOPTIONS_CONTENT.successStories,
    );
  });
});

describe("normalizeRegistrationContent", () => {
  test("returns defaults for a missing document", () => {
    expect(normalizeRegistrationContent(undefined)).toEqual(
      DEFAULT_REGISTRATION_CONTENT,
    );
  });

  test("keeps valid list items and drops non-strings", () => {
    const result = normalizeRegistrationContent({
      howToPayItems: ["Bank transfer", 5, "Office drop-off"],
      whatHappensNextItems: "nope",
    });
    expect(result.howToPayItems).toEqual(["Bank transfer", "Office drop-off"]);
    expect(result.whatHappensNextItems).toEqual(
      DEFAULT_REGISTRATION_CONTENT.whatHappensNextItems,
    );
  });

  test("ignores unexpected fields such as legacy fee values", () => {
    const result = normalizeRegistrationContent({
      heroTitle: "Register",
      fixedFee: "999",
      notFixedFee: "888",
    });
    expect(result.heroTitle).toBe("Register");
    expect(result).not.toHaveProperty("fixedFee");
    expect(result).not.toHaveProperty("notFixedFee");
  });
});

describe("AnimalAdoptions content rendering", () => {
  test("renders stored admin-managed content", async () => {
    render(
      <AnimalAdoptions
        content={{
          ...DEFAULT_ADOPTIONS_CONTENT,
          heroTitle: "Custom Adoptions Hero",
          successStories: [
            { name: "Rex", story: "Rex found a home.", image: "🐶" },
          ],
          partners: [{ name: "Island Vet", logo: "🩺" }],
        }}
      />,
    );

    expect(screen.getByText("Custom Adoptions Hero")).toBeInTheDocument();
    expect(screen.getByText("Rex found a home.")).toBeInTheDocument();
    expect(screen.getByText("Island Vet")).toBeInTheDocument();
    expect(screen.queryByText("Bella")).not.toBeInTheDocument();
  });

  test("renders default copy when no content is provided", async () => {
    render(<AnimalAdoptions />);
    expect(screen.getByText("Animal Adoptions")).toBeInTheDocument();
    expect(screen.getByText("Local Pet Rescue")).toBeInTheDocument();
  });
});

describe("AnimalRegistration content rendering", () => {
  test("renders stored copy while fees stay bound to code constants", () => {
    render(
      <AnimalRegistration
        content={{
          ...DEFAULT_REGISTRATION_CONTENT,
          heroTitle: "Register Your Pet Now",
          howToPayTitle: "Payment Options",
        }}
      />,
    );

    expect(screen.getByText("Register Your Pet Now")).toBeInTheDocument();
    expect(screen.getByText("Payment Options")).toBeInTheDocument();
    // Fees come from REGISTRATION_FEE_* constants, never the CMS doc.
    expect(screen.getByText(/Spayed\/Neutered: \$10/)).toBeInTheDocument();
    expect(screen.getByText(/Not Fixed: \$100/)).toBeInTheDocument();
  });
});
