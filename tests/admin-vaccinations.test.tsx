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
  mockSaveEncounter,
  mockSaveProcedure,
  mockSaveMedication,
  mockSaveAlert,
  mockSaveWeight,
  mockSaveFollowUp,
  mockCompleteFollowUp,
  mockCancelFollowUp,
  mockSaveExpectation,
  mockMarkSeen,
  mockMarkNoShow,
  mockCancelExpectation,
  mockToast,
} = vi.hoisted(() => ({
  mockGetAnimalMedical: vi.fn(),
  mockSaveVaccination: vi.fn(),
  mockSaveEncounter: vi.fn(),
  mockSaveProcedure: vi.fn(),
  mockSaveMedication: vi.fn(),
  mockSaveAlert: vi.fn(),
  mockSaveWeight: vi.fn(),
  mockSaveFollowUp: vi.fn(),
  mockCompleteFollowUp: vi.fn(),
  mockCancelFollowUp: vi.fn(),
  mockSaveExpectation: vi.fn(),
  mockMarkSeen: vi.fn(),
  mockMarkNoShow: vi.fn(),
  mockCancelExpectation: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/admin/animals/[id]/actions", () => ({
  getAnimalMedicalAction: mockGetAnimalMedical,
  saveVaccinationAction: mockSaveVaccination,
  saveEncounterAction: mockSaveEncounter,
  saveProcedureAction: mockSaveProcedure,
  saveMedicationAction: mockSaveMedication,
  saveAlertAction: mockSaveAlert,
  saveWeightAction: mockSaveWeight,
}));

// The follow-up and clinic-expectation panels/dialogs call the shared
// work-queue actions (#175/#194).
vi.mock("@/app/admin/vet/actions", () => ({
  saveFollowUpAction: mockSaveFollowUp,
  completeFollowUpAction: mockCompleteFollowUp,
  cancelFollowUpAction: mockCancelFollowUp,
  saveClinicExpectationAction: mockSaveExpectation,
  markClinicSeenAction: mockMarkSeen,
  markClinicNoShowAction: mockMarkNoShow,
  cancelClinicExpectationAction: mockCancelExpectation,
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
    encounterId: null,
    createdAt: "2025-10-01T00:00:00.000Z",
    updatedAt: "2025-10-01T00:00:00.000Z",
    ...data,
  };
}

// Wrap a record DTO in its timeline-item envelope (the service orders;
// tests pass items already newest-first).
function vaxItem(data: Record<string, unknown>) {
  const vax = vaxRow(data);
  return {
    kind: "vaccination" as const,
    date: vax.administeredOn,
    createdAt: vax.createdAt,
    record: vax,
  };
}

function record(
  timeline: unknown[] = [],
  followUps: unknown[] = [],
  clinicExpectations: unknown[] = [],
) {
  return {
    animal: ANIMAL,
    timeline,
    followUps,
    clinicExpectations,
    communications: [],
  };
}

function expectationRow(data: Record<string, unknown> = {}) {
  return {
    id: "ex-1",
    animalId: "animal-uuid-1",
    personId: null,
    encounterId: null,
    expectedOn: "2026-12-01",
    sessionLabel: null,
    reason: "Vaccination visit",
    status: "expected",
    notes: null,
    resolvedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...data,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAnimalMedical.mockResolvedValue(record());
  mockSaveVaccination.mockResolvedValue({ ok: true });
  mockSaveEncounter.mockResolvedValue({ ok: true });
  mockSaveProcedure.mockResolvedValue({ ok: true });
  mockSaveMedication.mockResolvedValue({ ok: true });
  mockSaveAlert.mockResolvedValue({ ok: true });
  mockSaveWeight.mockResolvedValue({ ok: true });
  mockSaveFollowUp.mockResolvedValue({ ok: true });
  mockCompleteFollowUp.mockResolvedValue({ ok: true });
  mockCancelFollowUp.mockResolvedValue({ ok: true });
  mockSaveExpectation.mockResolvedValue({ ok: true });
  mockMarkSeen.mockResolvedValue({ ok: true });
  mockMarkNoShow.mockResolvedValue({ ok: true });
  mockCancelExpectation.mockResolvedValue({ ok: true });
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
        vaxItem({
          id: "vax-overdue",
          vaccineName: "DHPP",
          administeredOn: "2024-01-01",
          dueOn: "2025-01-01",
          administeredBy: "Dr. A",
        }),
        vaxItem({
          id: "vax-current",
          vaccineName: "Rabies",
          administeredOn: "2026-01-01",
          dueOn: "2099-01-01",
        }),
        vaxItem({
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
      expect(screen.getByText(/No medical history recorded/)).toBeInTheDocument(),
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
      expect(screen.getByText(/No medical history recorded/)).toBeInTheDocument(),
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
    mockGetAnimalMedical.mockResolvedValue(record([vaxItem({})]));
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
    mockGetAnimalMedical.mockResolvedValue(record([vaxItem({})]));
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
      expect(screen.getByText(/No medical history recorded/)).toBeInTheDocument(),
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

  test("active alerts render as a prominent banner, resolved ones do not", async () => {
    mockGetAnimalMedical.mockResolvedValue(
      record([
        {
          kind: "alert",
          date: "2026-01-01",
          createdAt: "2026-01-01T00:00:00.000Z",
          record: {
            id: "alert-1",
            animalId: "animal-uuid-1",
            encounterId: null,
            kind: "allergy",
            severity: "critical",
            summary: "Penicillin allergy",
            details: "Anaphylaxis on prior course",
            status: "active",
            recordedOn: "2026-01-01",
            resolvedOn: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          kind: "alert",
          date: "2025-06-01",
          createdAt: "2025-06-01T00:00:00.000Z",
          record: {
            id: "alert-2",
            animalId: "animal-uuid-1",
            encounterId: null,
            kind: "condition",
            severity: "info",
            summary: "Resolved ear infection",
            details: null,
            status: "resolved",
            recordedOn: "2025-06-01",
            resolvedOn: "2025-07-01",
            createdAt: "2025-06-01T00:00:00.000Z",
            updatedAt: "2025-07-01T00:00:00.000Z",
          },
        },
      ]),
    );
    render(<AnimalMedicalPage />);

    const banner = await screen.findByLabelText("Active medical alerts");
    expect(
      within(banner).getByText("Penicillin allergy"),
    ).toBeInTheDocument();
    // Resolved alerts stay in the timeline but leave the banner.
    expect(
      within(banner).queryByText(/Resolved ear infection/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Resolved ear infection/),
    ).toBeInTheDocument();
  });

  test("open follow-ups surface as actionable items, resolved ones as history", async () => {
    mockGetAnimalMedical.mockResolvedValue(
      record([], [
        {
          id: "fu-1",
          animalId: "animal-uuid-1",
          personId: null,
          encounterId: null,
          kind: "recheck",
          dueOn: "2020-01-01", // safely overdue regardless of today
          status: "open",
          reason: "Recheck limp",
          notes: null,
          resolvedAt: null,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
        {
          id: "fu-2",
          animalId: "animal-uuid-1",
          personId: null,
          encounterId: null,
          kind: "recheck",
          dueOn: "2020-02-01",
          status: "completed",
          reason: "Suture removal",
          notes: null,
          resolvedAt: "2020-02-01T10:00:00.000Z",
          createdAt: "2020-01-15T00:00:00.000Z",
          updatedAt: "2020-02-01T10:00:00.000Z",
        },
      ]),
    );
    render(<AnimalMedicalPage />);

    // The open item is actionable: state badge + resolve controls.
    expect(await screen.findByText("Recheck limp")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Complete Recheck limp" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel Recheck limp" }),
    ).toBeInTheDocument();

    // The completed item is history — inside the collapsed details
    // (DOM-present but closed), with no action buttons.
    const summary = screen.getByText(/Resolved history/);
    const details = summary.closest("details") as HTMLElement;
    expect(details).not.toHaveAttribute("open");
    expect(
      within(details).getByText("Suture removal"),
    ).toBeInTheDocument();
    // Only one occurrence — the open list doesn't carry it.
    expect(screen.getAllByText("Suture removal")).toHaveLength(1);
    expect(
      within(details).queryByRole("button", {
        name: "Complete Suture removal",
      }),
    ).toBeNull();
  });

  test("completing a follow-up calls the action with the concurrency token and reloads", async () => {
    mockGetAnimalMedical.mockResolvedValue(
      record([], [
        {
          id: "fu-9",
          animalId: "animal-uuid-1",
          personId: null,
          encounterId: null,
          kind: "recheck",
          dueOn: "2099-01-01",
          status: "open",
          reason: "Recheck limp",
          notes: null,
          resolvedAt: null,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    render(<AnimalMedicalPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Complete Recheck limp" }),
    );
    await waitFor(() =>
      expect(mockCompleteFollowUp).toHaveBeenCalledWith(
        "fu-9",
        "2026-01-01T00:00:00.000Z",
      ),
    );
    // The record reloads so the item leaves the open list.
    await waitFor(() =>
      expect(mockGetAnimalMedical).toHaveBeenCalledTimes(2),
    );
  });

  test("cancelling a follow-up confirms before acting", async () => {
    mockGetAnimalMedical.mockResolvedValue(
      record([], [
        {
          id: "fu-9",
          animalId: "animal-uuid-1",
          personId: null,
          encounterId: null,
          kind: "recheck",
          dueOn: "2099-01-01",
          status: "open",
          reason: "Recheck limp",
          notes: null,
          resolvedAt: null,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    render(<AnimalMedicalPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel Recheck limp" }),
    );
    // Nothing happens until the destructive-style confirm.
    expect(mockCancelFollowUp).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel follow-up" }),
    );
    await waitFor(() =>
      expect(mockCancelFollowUp).toHaveBeenCalledWith(
        "fu-9",
        "2026-01-01T00:00:00.000Z",
      ),
    );
  });

  test("logging a visit can schedule a recheck in one flow", async () => {
    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/No medical history recorded/),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Annual check" },
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /Schedule a recheck/ }),
    );
    fireEvent.change(within(dialog).getByLabelText("Recheck date"), {
      target: { value: "2027-01-15" },
    });
    fireEvent.change(within(dialog).getByLabelText("Recheck for"), {
      target: { value: "Booster check" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save entry" }),
    );

    await waitFor(() =>
      expect(mockSaveEncounter).toHaveBeenCalledWith(
        expect.objectContaining({
          animalId: "animal-uuid-1",
          kind: "visit",
          reason: "Annual check",
          followUp: { dueOn: "2027-01-15", reason: "Booster check" },
        }),
        null,
        undefined,
      ),
    );
  });

  test("a visit without a reason shows a field error, not a save", async () => {
    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/No medical history recorded/),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save entry" }),
    );

    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toBeInTheDocument(),
    );
    expect(mockSaveEncounter).not.toHaveBeenCalled();
  });

  test("clinic expectations surface as actionable items, resolved ones as history", async () => {
    mockGetAnimalMedical.mockResolvedValue(
      record([], [], [
        expectationRow({ id: "ex-live", expectedOn: "2020-01-01" }),
        expectationRow({
          id: "ex-done",
          reason: "Old checkup",
          status: "seen",
          resolvedAt: "2020-02-01T10:00:00.000Z",
          updatedAt: "2020-02-01T10:00:00.000Z",
        }),
      ]),
    );
    render(<AnimalMedicalPage />);

    expect(await screen.findByText("Vaccination visit")).toBeInTheDocument();
    expect(screen.getByText("Past due")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mark Vaccination visit seen" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Mark Vaccination visit no-show",
      }),
    ).toBeInTheDocument();

    const summary = screen.getByText(/Resolved history/);
    const details = summary.closest("details") as HTMLElement;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Old checkup")).toBeInTheDocument();
    expect(within(details).getByText("Seen")).toBeInTheDocument();
    expect(
      within(details).queryByRole("button", { name: /Mark Old checkup/ }),
    ).toBeNull();
  });

  test("mark seen opens the encounter-link dialog and resolves with the token", async () => {
    mockGetAnimalMedical.mockResolvedValue(
      record([], [], [expectationRow({ id: "ex-9" })]),
    );
    render(<AnimalMedicalPage />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Mark Vaccination visit seen",
      }),
    );
    // The dialog offers the optional encounter link — nothing fires yet.
    expect(mockMarkSeen).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/linked to a visit/i)).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Mark seen" }),
    );
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith(
        "ex-9",
        "2026-10-01T00:00:00.000Z",
        null,
      ),
    );
    await waitFor(() =>
      expect(mockGetAnimalMedical).toHaveBeenCalledTimes(2),
    );
  });

  test("the expectation dialog posts a new clinic expectation", async () => {
    render(<AnimalMedicalPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/No medical history recorded/),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expect at clinic" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Expected date"), {
      target: { value: "2027-02-01" },
    });
    fireEvent.change(
      within(dialog).getByLabelText(/Why they.re coming/),
      { target: { value: "Rabies booster" } },
    );
    fireEvent.change(within(dialog).getByLabelText(/Session/), {
      target: { value: "AM clinic" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Expect at clinic" }),
    );

    await waitFor(() =>
      expect(mockSaveExpectation).toHaveBeenCalledWith(
        {
          animalId: "animal-uuid-1",
          expectedOn: "2027-02-01",
          sessionLabel: "AM clinic",
          reason: "Rabies booster",
          notes: null,
        },
        null,
        undefined,
      ),
    );
  });
});
