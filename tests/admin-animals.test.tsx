// Component tests for /admin/animals (#91, Postgres cutover in #183).
// The server actions are mocked at the module boundary; these tests pin
// down mutation hardening: pending guards, double-click prevention,
// field-level validation preserving data, named destructive
// confirmation, and a retryable load-error state distinct from "no
// records". Postgres behavior itself is covered by tests/db.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockListAnimals,
  mockSaveAnimal,
  mockDeleteAnimal,
  mockToast,
} = vi.hoisted(() => ({
  mockListAnimals: vi.fn(),
  mockSaveAnimal: vi.fn(),
  mockDeleteAnimal: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/admin/animals/actions", () => ({
  listAnimalsAction: mockListAnimals,
  saveAnimalAction: mockSaveAnimal,
  deleteAnimalAction: mockDeleteAnimal,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import AnimalsManager from "@/app/admin/animals/page";

function animalRow(
  registryId: string,
  data: Record<string, unknown>,
) {
  return {
    id: registryId,
    registryId,
    name: "",
    species: "dog",
    sex: "unknown",
    approxAge: "",
    description: "",
    status: "available",
    photos: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...data,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListAnimals.mockResolvedValue([]);
  mockSaveAnimal.mockResolvedValue({ ok: true });
  mockDeleteAnimal.mockResolvedValue({ ok: true });
});

describe("admin animals", () => {
  test("shows a retryable error state when the list fails to load", async () => {
    mockListAnimals
      .mockRejectedValueOnce(new Error("permission-denied"))
      .mockResolvedValueOnce([
        animalRow("a1", { name: "Buddy", species: "dog", sex: "male", approxAge: "2y" }),
      ]);

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
    let resolveSave: () => void = () => {};
    mockSaveAnimal.mockImplementation(
      () => new Promise((r) => { resolveSave = () => r({ ok: true }); }),
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
    expect(mockSaveAnimal).toHaveBeenCalledTimes(1);

    resolveSave();
    await waitFor(() => expect(mockListAnimals).toHaveBeenCalledTimes(2));
  }, 15000);

  test("keeps dialog data and shows a safe error when save fails", async () => {
    mockSaveAnimal.mockResolvedValue({ ok: false });
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
    // Raw server error text is never shown to staff.
    const descriptions = mockToast.mock.calls.map(
      (c) => c[0].description as string,
    );
    expect(descriptions.join(" ")).not.toContain("unavailable");
  });

  test("a concurrency conflict tells staff to reopen the record", async () => {
    mockListAnimals.mockResolvedValue([
      animalRow("a1", { name: "Buddy", species: "dog", sex: "male" }),
    ]);
    mockSaveAnimal.mockResolvedValue({ ok: false, reason: "conflict" });
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText("Buddy"));

    fireEvent.click(screen.getByRole("button", { name: "Edit Buddy" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Update Animal" }),
    );

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          description: expect.stringContaining("changed by someone else"),
        }),
      ),
    );
  });

  test("shows a field-level error instead of writing an invalid status", async () => {
    mockListAnimals.mockResolvedValue([
      animalRow("a1", {
        name: "Buddy",
        species: "dog",
        sex: "male",
        approxAge: "2y",
        status: "bogus-legacy",
      }),
    ]);
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
    expect(mockSaveAnimal).not.toHaveBeenCalled();
    // Entered data is preserved.
    expect(screen.getByLabelText("Name")).toHaveValue("Buddy");
  });

  test("delete requires confirmation naming the animal; cancel keeps it", async () => {
    mockListAnimals.mockResolvedValue([
      animalRow("a1", {
        name: "Buddy",
        species: "dog",
        sex: "male",
        approxAge: "2y",
      }),
    ]);
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText("Buddy"));

    fireEvent.click(screen.getByRole("button", { name: "Delete Buddy" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Buddy/);
    expect(dialog).toHaveTextContent(/cannot be undone/i);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockDeleteAnimal).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  test("confirming delete removes the animal", async () => {
    mockListAnimals.mockResolvedValue([
      animalRow("a1", {
        name: "Buddy",
        species: "dog",
        sex: "male",
        approxAge: "2y",
      }),
    ]);
    render(<AnimalsManager />);
    await waitFor(() => screen.getByText("Buddy"));

    fireEvent.click(screen.getByRole("button", { name: "Delete Buddy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockDeleteAnimal).toHaveBeenCalledTimes(1));
    expect(mockDeleteAnimal).toHaveBeenCalledWith("a1");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Success" }),
    );
  });
});
