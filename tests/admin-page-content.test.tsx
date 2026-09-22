// Tests that the admin page-content editors (#129) read and write the
// canonical documents the public pages render: `animalRegistration/main`
// and `animalAdoptions/main`. The registration editor must no longer
// carry fee fields — fees are code constants, not CMS content.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetDoc, mockSetDoc, mockDoc, mockToast } = vi.hoisted(() => ({
  mockGetDoc: vi.fn(),
  mockSetDoc: vi.fn(),
  mockDoc: vi.fn((_db: unknown, ...parts: string[]) => ({
    collection: parts[0],
    id: parts[1],
  })),
  mockToast: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  doc: mockDoc,
  getDoc: mockGetDoc,
  setDoc: mockSetDoc,
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import AnimalRegistrationAdminPage from "@/app/admin/animal-registration/page";
import AnimalAdoptionsAdminPage from "@/app/admin/animal-adoptions/page";

beforeEach(() => {
  mockGetDoc.mockReset().mockResolvedValue({ exists: () => false });
  mockSetDoc.mockReset().mockResolvedValue(undefined);
  mockToast.mockReset();
});

describe("admin animal-registration editor", () => {
  test("loads and saves the canonical animalRegistration/main document", async () => {
    render(<AnimalRegistrationAdminPage />);

    // findBy* waits for the loading → form transition, not just the
    // getDoc call.
    const heroTitle = await screen.findByLabelText(/^Title/);
    expect(mockDoc).toHaveBeenCalledWith({}, "animalRegistration", "main");

    fireEvent.change(heroTitle, {
      target: { value: "New Hero" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /Save/i })[0],
    );

    await waitFor(() => expect(mockSetDoc).toHaveBeenCalledTimes(1));
    const [docRef, payload] = mockSetDoc.mock.calls[0];
    expect(docRef).toEqual({ collection: "animalRegistration", id: "main" });
    expect(payload.heroTitle).toBe("New Hero");
    // Fees are business logic — the editor must not write them into the
    // content document (legacy fixedFee/notFixedFee fields get dropped on
    // the next save).
    expect(payload).not.toHaveProperty("fixedFee");
    expect(payload).not.toHaveProperty("notFixedFee");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Success" }),
    );
  });

  test("no fee inputs are rendered", async () => {
    render(<AnimalRegistrationAdminPage />);
    await screen.findByLabelText(/^Title/);
    expect(screen.queryByLabelText(/Fee/i)).not.toBeInTheDocument();
  });
});

describe("admin animal-adoptions editor", () => {
  test("loads and saves the canonical animalAdoptions/main document", async () => {
    render(<AnimalAdoptionsAdminPage />);

    // Wait for the loading → form transition; the editor has two fields
    // labelled "Title" (hero + CTA) so target the hero input by id.
    await waitFor(() =>
      expect(document.getElementById("hero-title")).not.toBeNull(),
    );
    expect(mockDoc).toHaveBeenCalledWith({}, "animalAdoptions", "main");
    const heroTitle = document.getElementById("hero-title") as HTMLElement;
    fireEvent.change(heroTitle as HTMLElement, {
      target: { value: "Adopt a Friend" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /Save/i })[0],
    );

    await waitFor(() => expect(mockSetDoc).toHaveBeenCalledTimes(1));
    const [docRef, payload] = mockSetDoc.mock.calls[0];
    expect(docRef).toEqual({ collection: "animalAdoptions", id: "main" });
    expect(payload.heroTitle).toBe("Adopt a Friend");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Success" }),
    );
  });
});
