// Component tests for /admin/animals/[id] — the per-animal medical
// record (#173). Server actions are mocked at the module boundary; the
// tests pin down load states, chronological display with derived status
// badges, dialog validation preserving data, and the conflict path.
// Postgres behavior itself is covered by tests/db/vaccinations.test.ts.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockGetAnimalMedical,
  mockSaveVaccination,
  mockToast,
} = vi.hoisted(() => ({
  mockGetAnimalMedical: vi.fn(),
  mockSaveVaccination: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/admin/animals/[id]/actions", () => ({
  getAnimalMedicalAction: mockGetAnimalMedical,
  saveVaccinationAction: mockSaveVaccination,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "animal-uuid-1" }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import AnimalMedicalPage from "@/app/admin/animals/[id]/page";

const ANIMAL = {
  id: "animal-uuid-1",
  legacyId: null,
  name: "Rex",
  species: "dog",
  sex: "male",
  approxAge: "2 years",
  description: "",
  lifecycleStatus: "adopted",
  photoUrls: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function vaxRow(data: Record<string, unknown>) {
  return {
    id: "vax-1",
    animalId: "animal-uuid-1",
    vaccineName: "Rabies",
    seriesKey: "rabies",
    administeredOn: "2025-10-01",
    dueOn: "2026-10-01",
    validUntil: null,
    productName: null,
    manufacturer: null,
    lotNumber: null,
    administeredBy: null,
    notes: null,
    documentPath: null,
    createdAt: "2025-10-01T00:00:00.000Z",
    updatedAt: "2025-10-01T00:00:00.000Z",
    ...data,
  };
}

function record(vaccinations: unknown[] = []) {
  return { animal: ANIMAL, vaccinations };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAnimalMedical.mockResolvedValue(record());
  mockSaveVaccination.mockResolvedValue({ ok: true });
});

describe("admin animal medical record", () => {
  test("shows a retryable error state when the record fails to load", async () => {
    mockGetAnimalMedical
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(record());

    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Couldn.t load medical record/,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Rex")).toBeInTheDocument());
    expect(mockGetAnimalMedical).toHaveBeenLastCalledWith("animal-uuid-1");
  });

  test("renders a not-found state instead of an error for a missing animal", async () => {
    mockGetAnimalMedical.mockResolvedValue(null);
    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(screen.getByText(/Animal not found/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("lists vaccination history with derived status and next date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockGetAnimalMedical.mockResolvedValue(
      record([
        vaxRow({
          id: "vax-overdue",
          vaccineName: "DHPP",
          administeredOn: "2024-01-01",
          dueOn: "2025-01-01",
          administeredBy: "Dr. A",
        }),
        vaxRow({
          id: "vax-current",
          vaccineName: "Rabies",
          administeredOn: "2026-01-01",
          dueOn: "2099-01-01",
        }),
        vaxRow({
          id: "vax-none",
          vaccineName: "Bordetella",
          administeredOn: today,
          dueOn: null,
        }),
      ]),
    );

    render(<AnimalMedicalPage />);
    await waitFor(() => expect(screen.getByText("DHPP")).toBeInTheDocument());

    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("No date set")).toBeInTheDocument();
    // Next relevant date is shown directly — no mental math.
    const rabiesRow = screen.getByText("Rabies").closest("tr")!;
    expect(within(rabiesRow).getByText("2099-01-01")).toBeInTheDocument();
  });

  test("add dialog validates required fields without calling the action", async () => {
    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(screen.getByText(/No vaccinations recorded/)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add vaccination/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add vaccination" }),
    );

    await waitFor(() =>
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
    );
    expect(mockSaveVaccination).not.toHaveBeenCalled();
  });

  test("submitting sends the registry id and reloads the record", async () => {
    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(screen.getByText(/No vaccinations recorded/)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add vaccination/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Vaccine"), {
      target: { value: "Rabies" },
    });
    fireEvent.change(within(dialog).getByLabelText("Date given"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add vaccination" }),
    );

    await waitFor(() =>
      expect(mockSaveVaccination).toHaveBeenCalledWith(
        expect.objectContaining({
          animalId: "animal-uuid-1",
          vaccineName: "Rabies",
          administeredOn: "2026-09-01",
        }),
        null,
        undefined,
      ),
    );
    // The list reloads after a successful save.
    await waitFor(() =>
      expect(mockGetAnimalMedical).toHaveBeenCalledTimes(2),
    );
  });

  test("editing prefills the form and passes the optimistic-concurrency token", async () => {
    mockGetAnimalMedical.mockResolvedValue(record([vaxRow({})]));
    render(<AnimalMedicalPage />);
    await waitFor(() => expect(screen.getByText("Rabies")).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Rabies vaccination" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Vaccine")).toHaveValue("Rabies");
    expect(within(dialog).getByLabelText("Date given")).toHaveValue(
      "2025-10-01",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Update vaccination" }),
    );
    await waitFor(() =>
      expect(mockSaveVaccination).toHaveBeenCalledWith(
        expect.objectContaining({ vaccineName: "Rabies" }),
        "vax-1",
        "2025-10-01T00:00:00.000Z",
      ),
    );
  });

  test("a concurrency conflict tells staff to reopen the record", async () => {
    mockGetAnimalMedical.mockResolvedValue(record([vaxRow({})]));
    mockSaveVaccination.mockResolvedValue({ ok: false, reason: "conflict" });
    render(<AnimalMedicalPage />);
    await waitFor(() => expect(screen.getByText("Rabies")).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Rabies vaccination" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Update vaccination" }),
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

  test("a server-side field error is shown inline and data is kept", async () => {
    mockSaveVaccination.mockResolvedValue({
      ok: false,
      reason: "invalid",
      field: "dueOn",
    });
    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(screen.getByText(/No vaccinations recorded/)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add vaccination/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Vaccine"), {
      target: { value: "Rabies" },
    });
    fireEvent.change(within(dialog).getByLabelText("Date given"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add vaccination" }),
    );

    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        /Next-due date/,
      ),
    );
    expect(within(dialog).getByLabelText("Vaccine")).toHaveValue("Rabies");
  });
});
