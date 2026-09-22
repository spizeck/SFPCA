// Component tests for /admin/animals (#91). Firebase is mocked at the
// module boundary; these tests pin down mutation hardening: pending
// guards, double-click prevention, field-level validation preserving
// data, named destructive confirmation, and a retryable load-error
// state distinct from "no records".
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockGetDocs,
  mockAddDoc,
  mockUpdateDoc,
  mockDeleteDoc,
  mockToast,
} = vi.hoisted(() => ({
  mockGetDocs: vi.fn(),
  mockAddDoc: vi.fn(),
  mockUpdateDoc: vi.fn(),
  mockDeleteDoc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  getDocs: mockGetDocs,
  addDoc: mockAddDoc,
  updateDoc: mockUpdateDoc,
  deleteDoc: mockDeleteDoc,
  doc: vi.fn((_db: unknown, _col: string, id: string) => ({ id })),
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import AnimalsManager from "@/app/admin/animals/page";

function animalDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDocs.mockResolvedValue({ docs: [] });
});

describe("admin animals", () => {
  test("shows a retryable error state when the list fails to load", async () => {
    mockGetDocs
      .mockRejectedValueOnce(new Error("permission-denied"))
      .mockResolvedValueOnce({
        docs: [animalDoc("a1", { name: "Buddy", species: "dog", sex: "male", approxAge: "2y", description: "", status: "available" })],
      });

    render(<AnimalsManager />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Couldn.t load animals/,
      ),
    );
    // The failed load must not masquerade as an empty list.
    expect(
      screen.queryByText(/No animals found/),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByText("Buddy")).toBeInTheDocument(),
    );
  });

  test("shows the empty state only when the load succeeded", async () => {
    render(<AnimalsManager />);
    await waitFor(() =>
      expect(screen.getByText(/No animals found/)).toBeInTheDocument(),
    );
  });

  test("double-clicking Add Animal submits only once", async () => {
    let resolveAdd: () => void = () => {};
    mockAddDoc.mockImplementation(
      () => new Promise((r) => { resolveAdd = () => r(undefined); }),
    );
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText(/No animals found/));

    fireEvent.click(screen.getByRole("button", { name: /Add Animal/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Rex" },
    });

    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Add Animal" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(mockAddDoc).toHaveBeenCalledTimes(1);

    resolveAdd();
    await waitFor(() => expect(mockGetDocs).toHaveBeenCalledTimes(2));
  }, 15000);

  test("keeps dialog data and shows a safe error when save fails", async () => {
    mockAddDoc.mockRejectedValue(new Error("unavailable"));
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText(/No animals found/));

    fireEvent.click(screen.getByRole("button", { name: /Add Animal/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Rex" },
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add Animal" }),
    );

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
    // Dialog stays open with the entered data intact.
    expect(screen.getByLabelText("Name")).toHaveValue("Rex");
    // Raw Firebase error text is never shown to staff.
    const descriptions = mockToast.mock.calls.map(
      (c) => c[0].description as string,
    );
    expect(descriptions.join(" ")).not.toContain("unavailable");
  });

  test("shows a field-level error instead of writing an invalid status", async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        animalDoc("a1", {
          name: "Buddy",
          species: "dog",
          sex: "male",
          approxAge: "2y",
          description: "",
          status: "bogus-legacy",
        }),
      ],
    });
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText("Buddy"));

    fireEvent.click(screen.getByRole("button", { name: "Edit Buddy" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Update Animal" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Select a valid animal status/,
      ),
    );
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    // Entered data is preserved.
    expect(screen.getByLabelText("Name")).toHaveValue("Buddy");
  });

  test("delete requires confirmation naming the animal; cancel keeps it", async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        animalDoc("a1", {
          name: "Buddy",
          species: "dog",
          sex: "male",
          approxAge: "2y",
          description: "",
          status: "available",
        }),
      ],
    });
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText("Buddy"));

    fireEvent.click(screen.getByRole("button", { name: "Delete Buddy" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Buddy/);
    expect(dialog).toHaveTextContent(/cannot be undone/i);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockDeleteDoc).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  test("confirming delete removes the animal", async () => {
    mockDeleteDoc.mockResolvedValue(undefined);
    mockGetDocs.mockResolvedValue({
      docs: [
        animalDoc("a1", {
          name: "Buddy",
          species: "dog",
          sex: "male",
          approxAge: "2y",
          description: "",
          status: "available",
        }),
      ],
    });
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText("Buddy"));

    fireEvent.click(screen.getByRole("button", { name: "Delete Buddy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockDeleteDoc).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Success" }),
    );
  });
});
