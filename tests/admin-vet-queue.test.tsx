// Component tests for /admin/vet — the staff veterinary work queue
// (#175). The queue arrives pre-sorted and pre-derived from
// listVetQueue; these tests pin down rendering, kind/window filters,
// and the inline complete/cancel controls. DB behavior is covered by
// tests/db/follow-ups.test.ts.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { addDaysToIsoDate, todayIsoDate } from "@/lib/vaccinations";

const {
  mockGetVetQueue,
  mockCompleteFollowUp,
  mockCancelFollowUp,
  mockSaveFollowUp,
  mockMarkSeen,
  mockMarkNoShow,
  mockCancelExpectation,
  mockToast,
} = vi.hoisted(() => ({
  mockGetVetQueue: vi.fn(),
  mockCompleteFollowUp: vi.fn(),
  mockCancelFollowUp: vi.fn(),
  mockSaveFollowUp: vi.fn(),
  mockMarkSeen: vi.fn(),
  mockMarkNoShow: vi.fn(),
  mockCancelExpectation: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/admin/vet/actions", () => ({
  getVetQueueAction: mockGetVetQueue,
  completeFollowUpAction: mockCompleteFollowUp,
  cancelFollowUpAction: mockCancelFollowUp,
  saveFollowUpAction: mockSaveFollowUp,
  markClinicSeenAction: mockMarkSeen,
  markClinicNoShowAction: mockMarkNoShow,
  cancelClinicExpectationAction: mockCancelExpectation,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import VetQueuePage from "@/app/admin/vet/page";

const TODAY = todayIsoDate();
const YESTERDAY = addDaysToIsoDate(TODAY, -1);
const IN_A_WEEK = addDaysToIsoDate(TODAY, 5);
const NEXT_MONTH = addDaysToIsoDate(TODAY, 25);

const animal = (id: string, name: string) => ({
  id,
  name,
  species: "dog",
});

const queue = () => [
  {
    kind: "follow-up" as const,
    id: "fu-overdue",
    dueOn: YESTERDAY,
    state: "overdue" as const,
    reason: "Suture removal",
    notes: "10 days post-spay",
    encounterId: "enc-1",
    encounterOn: "2026-10-01",
    animal: animal("a-1", "Rex"),
    currentOwnerName: "Jane Doe",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    kind: "follow-up" as const,
    id: "fu-today",
    dueOn: TODAY,
    state: "due" as const,
    reason: "Recheck limp",
    notes: null,
    encounterId: null,
    encounterOn: null,
    animal: animal("a-2", "Bella"),
    currentOwnerName: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    kind: "follow-up" as const,
    id: "fu-later",
    dueOn: NEXT_MONTH,
    state: "upcoming" as const,
    reason: "Annual dental",
    notes: null,
    encounterId: null,
    encounterOn: null,
    animal: animal("a-3", "Max"),
    currentOwnerName: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    kind: "clinic" as const,
    id: "ex-1",
    expectedOn: TODAY,
    state: "due" as const,
    reason: "Vaccination visit",
    sessionLabel: "AM clinic",
    notes: null,
    animal: animal("a-6", "Milo"),
    currentOwnerName: "Sam Rivera",
    updatedAt: "2026-10-02T00:00:00.000Z",
  },
  {
    kind: "clinic" as const,
    id: "ex-2",
    expectedOn: YESTERDAY,
    state: "overdue" as const,
    reason: "Post-op check",
    sessionLabel: null,
    notes: "didn't show yesterday",
    animal: animal("a-7", "Duke"),
    currentOwnerName: null,
    updatedAt: "2026-10-02T00:00:00.000Z",
  },
  {
    kind: "vaccination" as const,
    id: "vax-1",
    effectiveDate: IN_A_WEEK,
    state: "due-soon" as const,
    vaccineName: "Rabies",
    animal: animal("a-5", "Ziggy"),
    currentOwnerName: null,
  },
  {
    kind: "alert" as const,
    id: "alert-1",
    severity: "critical" as const,
    alertKind: "allergy",
    summary: "Penicillin allergy",
    recordedOn: "2026-01-01",
    animal: animal("a-4", "Luna"),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVetQueue.mockResolvedValue(queue());
  mockCompleteFollowUp.mockResolvedValue({ ok: true });
  mockCancelFollowUp.mockResolvedValue({ ok: true });
  mockMarkSeen.mockResolvedValue({ ok: true });
  mockMarkNoShow.mockResolvedValue({ ok: true });
  mockCancelExpectation.mockResolvedValue({ ok: true });
});

describe("veterinary work queue page", () => {
  test("renders all item kinds with their derived states", async () => {
    render(<VetQueuePage />);

    expect(await screen.findByText("Suture removal")).toBeInTheDocument();
    expect(screen.getByText("Recheck limp")).toBeInTheDocument();
    expect(screen.getByText("Annual dental")).toBeInTheDocument();
    expect(screen.getByText("Rabies")).toBeInTheDocument();
    expect(screen.getByText("Penicillin allergy")).toBeInTheDocument();

    // Derived-state badges — scoped to their rows because the window
    // filters reuse the same labels ("Overdue", "Due today").
    const row = (text: string) => screen.getByText(text).closest("tr")!;
    expect(within(row("Suture removal")).getByText("Overdue")).toBeInTheDocument();
    expect(within(row("Recheck limp")).getByText("Due today")).toBeInTheDocument();
    expect(within(row("Annual dental")).getByText("Upcoming")).toBeInTheDocument();
    expect(within(row("Rabies")).getByText("Due soon")).toBeInTheDocument();
    expect(
      within(row("Penicillin allergy")).getByText("Critical"),
    ).toBeInTheDocument();

    // Owner context for staff (name only — no contact details).
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    // Source-encounter context is surfaced.
    expect(screen.getByText(/From visit on 2026-10-01/)).toBeInTheDocument();
    // The overdue counter headlines the workload (recheck + missed
    // clinic expectation both count).
    expect(screen.getByText(/2 overdue/)).toBeInTheDocument();
  });

  test("clinic expectations render with session context and resolve controls", async () => {
    render(<VetQueuePage />);
    const today = await screen.findByText("Vaccination visit");
    const todayRow = today.closest("tr")!;
    expect(within(todayRow).getByText("Expected today")).toBeInTheDocument();
    expect(within(todayRow).getByText("Expected")).toBeInTheDocument(); // type badge
    expect(within(todayRow).getByText("AM clinic")).toBeInTheDocument();
    expect(within(todayRow).getByText("Sam Rivera")).toBeInTheDocument();
    expect(
      within(todayRow).getByRole("button", {
        name: "Mark Vaccination visit — Milo seen",
      }),
    ).toBeInTheDocument();

    const missedRow = screen.getByText("Post-op check").closest("tr")!;
    expect(within(missedRow).getByText("Past due")).toBeInTheDocument();
    expect(
      within(missedRow).getByText(/Expected date passed/),
    ).toBeInTheDocument();
  });

  test("animals link to their medical record", async () => {
    render(<VetQueuePage />);
    const link = await screen.findByRole("link", { name: "Rex" });
    expect(link).toHaveAttribute("href", "/admin/animals/a-1");
  });

  test("kind filter narrows the list without touching the others", async () => {
    render(<VetQueuePage />);
    await screen.findByText("Suture removal");

    fireEvent.click(screen.getByRole("button", { name: "Vaccinations" }));
    expect(screen.queryByText("Suture removal")).not.toBeInTheDocument();
    expect(screen.getByText("Rabies")).toBeInTheDocument();
    expect(screen.queryByText("Penicillin allergy")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(screen.queryByText("Rabies")).not.toBeInTheDocument();
    expect(screen.getByText("Penicillin allergy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rechecks" }));
    expect(screen.getByText("Suture removal")).toBeInTheDocument();
    expect(screen.queryByText("Rabies")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expected" }));
    expect(screen.getByText("Vaccination visit")).toBeInTheDocument();
    expect(screen.getByText("Post-op check")).toBeInTheDocument();
    expect(screen.queryByText("Suture removal")).not.toBeInTheDocument();
  });

  test("the overdue window keeps overdue + shows nothing future; alerts always stay", async () => {
    render(<VetQueuePage />);
    await screen.findByText("Suture removal");

    fireEvent.click(screen.getByRole("button", { name: "Overdue" }));
    expect(screen.getByText("Suture removal")).toBeInTheDocument();
    expect(screen.queryByText("Recheck limp")).not.toBeInTheDocument();
    expect(screen.queryByText("Annual dental")).not.toBeInTheDocument();
    expect(screen.queryByText("Rabies")).not.toBeInTheDocument();
    // Alerts are standing items — never filtered away by a date window.
    expect(screen.getByText("Penicillin allergy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Due today" }));
    expect(screen.getByText("Suture removal")).toBeInTheDocument();
    expect(screen.getByText("Recheck limp")).toBeInTheDocument();
    expect(screen.queryByText("Annual dental")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next 7 days" }));
    expect(screen.getByText("Rabies")).toBeInTheDocument();
    expect(screen.queryByText("Annual dental")).not.toBeInTheDocument();
  });

  test("completing a recheck from the queue calls the action and reloads", async () => {
    render(<VetQueuePage />);
    const row = (await screen.findByText("Suture removal")).closest("tr")!;

    fireEvent.click(
      within(row).getByRole("button", {
        name: "Complete Suture removal — Rex",
      }),
    );
    await waitFor(() =>
      expect(mockCompleteFollowUp).toHaveBeenCalledWith(
        "fu-overdue",
        "2026-10-01T00:00:00.000Z",
      ),
    );
    await waitFor(() => expect(mockGetVetQueue).toHaveBeenCalledTimes(2));
  });

  test("marking an expectation seen from the queue calls the action and reloads", async () => {
    render(<VetQueuePage />);
    const row = (await screen.findByText("Vaccination visit")).closest("tr")!;

    fireEvent.click(
      within(row).getByRole("button", {
        name: "Mark Vaccination visit — Milo seen",
      }),
    );
    await waitFor(() =>
      expect(mockMarkSeen).toHaveBeenCalledWith(
        "ex-1",
        "2026-10-02T00:00:00.000Z",
      ),
    );
    await waitFor(() => expect(mockGetVetQueue).toHaveBeenCalledTimes(2));
  });

  test("no-show asks for confirmation before resolving", async () => {
    render(<VetQueuePage />);
    const row = (await screen.findByText("Post-op check")).closest("tr")!;

    fireEvent.click(
      within(row).getByRole("button", {
        name: "Mark Post-op check — Duke no-show",
      }),
    );
    // The confirm dialog names the item — nothing fired yet.
    expect(mockMarkNoShow).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Post-op check — Duke/)).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Mark no-show" }),
    );
    await waitFor(() =>
      expect(mockMarkNoShow).toHaveBeenCalledWith(
        "ex-2",
        "2026-10-02T00:00:00.000Z",
      ),
    );
  });

  test("vaccination and alert rows have no complete/cancel controls", async () => {
    render(<VetQueuePage />);
    await screen.findByText("Rabies");
    const vaxRow = screen.getByText("Rabies").closest("tr")!;
    const alertRow = screen.getByText("Penicillin allergy").closest("tr")!;
    expect(within(vaxRow).queryByRole("button")).toBeNull();
    expect(within(alertRow).queryByRole("button")).toBeNull();
  });

  test("a failed load shows the retryable error state", async () => {
    mockGetVetQueue.mockRejectedValueOnce(new Error("db down"));
    render(<VetQueuePage />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Couldn.t load veterinary queue/,
      ),
    );
  });

  test("an empty queue says so plainly", async () => {
    mockGetVetQueue.mockResolvedValue([]);
    render(<VetQueuePage />);
    expect(
      await screen.findByText(/Nothing needs attention/),
    ).toBeInTheDocument();
  });
});
