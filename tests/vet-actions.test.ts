// Authorization tests for the veterinary work queue actions (#175).
// A "use server" export is callable by direct HTTP request — not only
// through the admin UI — so each action must self-authorize via
// requireAdmin() before touching the registry. The registry services
// are mocked; the authorization gate under test is real.
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockRequireAdmin,
  mockListVetQueue,
  mockVetQueueSummary,
  mockCreateFollowUp,
  mockUpdateFollowUp,
  mockCompleteFollowUp,
  mockCancelFollowUp,
  mockCreateExpectation,
  mockUpdateExpectation,
  mockMarkSeen,
  mockMarkNoShow,
  mockCancelExpectation,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockListVetQueue: vi.fn(),
  mockVetQueueSummary: vi.fn(),
  mockCreateFollowUp: vi.fn(),
  mockUpdateFollowUp: vi.fn(),
  mockCompleteFollowUp: vi.fn(),
  mockCancelFollowUp: vi.fn(),
  mockCreateExpectation: vi.fn(),
  mockUpdateExpectation: vi.fn(),
  mockMarkSeen: vi.fn(),
  mockMarkNoShow: vi.fn(),
  mockCancelExpectation: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/lib/registry/vet-queue", () => ({
  listVetQueue: mockListVetQueue,
  vetQueueSummary: mockVetQueueSummary,
  VET_QUEUE_WINDOW_DAYS: 30,
}));

vi.mock("@/lib/registry/medical", () => ({
  createFollowUp: mockCreateFollowUp,
  updateFollowUp: mockUpdateFollowUp,
  completeFollowUp: mockCompleteFollowUp,
  cancelFollowUp: mockCancelFollowUp,
  createClinicExpectation: mockCreateExpectation,
  updateClinicExpectation: mockUpdateExpectation,
  markClinicExpectationSeen: mockMarkSeen,
  markClinicExpectationNoShow: mockMarkNoShow,
  cancelClinicExpectation: mockCancelExpectation,
}));

import {
  cancelClinicExpectationAction,
  cancelFollowUpAction,
  completeFollowUpAction,
  getVetQueueAction,
  getVetQueueSummaryAction,
  markClinicNoShowAction,
  markClinicSeenAction,
  saveClinicExpectationAction,
  saveFollowUpAction,
} from "@/app/admin/vet/actions";

const UNAUTHORIZED = { authorized: false, user: null, role: null };
const ADMIN = {
  authorized: true,
  user: { email: "vet@example.com" },
  role: "admin",
};

const INPUT = {
  animalId: "00000000-0000-4000-8000-000000000001",
  dueOn: "2026-11-01",
  reason: "Recheck limp",
};

const CLINIC_INPUT = {
  animalId: "00000000-0000-4000-8000-000000000001",
  expectedOn: "2026-11-01",
  reason: "Vaccination visit",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListVetQueue.mockResolvedValue([]);
  mockVetQueueSummary.mockResolvedValue({ total: 0 });
  mockCreateFollowUp.mockResolvedValue({ ok: true, record: {} });
  mockUpdateFollowUp.mockResolvedValue({ ok: true, record: {} });
  mockCompleteFollowUp.mockResolvedValue({ ok: true, record: {} });
  mockCancelFollowUp.mockResolvedValue({ ok: true, record: {} });
  mockCreateExpectation.mockResolvedValue({ ok: true, record: {} });
  mockUpdateExpectation.mockResolvedValue({ ok: true, record: {} });
  mockMarkSeen.mockResolvedValue({ ok: true, record: {} });
  mockMarkNoShow.mockResolvedValue({ ok: true, record: {} });
  mockCancelExpectation.mockResolvedValue({ ok: true, record: {} });
});

describe("unauthorized calls never reach the registry", () => {
  beforeEach(() => mockRequireAdmin.mockResolvedValue(UNAUTHORIZED));

  test.each([
    ["getVetQueueAction", () => getVetQueueAction()],
    ["getVetQueueSummaryAction", () => getVetQueueSummaryAction()],
    ["saveFollowUpAction (create)", () => saveFollowUpAction(INPUT, null)],
    [
      "saveFollowUpAction (update)",
      () => saveFollowUpAction(INPUT, "fu-id", "2026-01-01T00:00:00Z"),
    ],
    ["completeFollowUpAction", () => completeFollowUpAction("fu-id", "ts")],
    ["cancelFollowUpAction", () => cancelFollowUpAction("fu-id", "ts")],
    [
      "saveClinicExpectationAction (create)",
      () => saveClinicExpectationAction(CLINIC_INPUT, null),
    ],
    [
      "saveClinicExpectationAction (update)",
      () => saveClinicExpectationAction(CLINIC_INPUT, "ex-id", "ts"),
    ],
    ["markClinicSeenAction", () => markClinicSeenAction("ex-id", "ts")],
    ["markClinicNoShowAction", () => markClinicNoShowAction("ex-id", "ts")],
    [
      "cancelClinicExpectationAction",
      () => cancelClinicExpectationAction("ex-id", "ts"),
    ],
  ])("%s throws Unauthorized", async (_name, call) => {
    await expect(call()).rejects.toThrow("Unauthorized");
  });

  test("no registry function ran", () => {
    expect(mockListVetQueue).not.toHaveBeenCalled();
    expect(mockVetQueueSummary).not.toHaveBeenCalled();
    expect(mockCreateFollowUp).not.toHaveBeenCalled();
    expect(mockUpdateFollowUp).not.toHaveBeenCalled();
    expect(mockCompleteFollowUp).not.toHaveBeenCalled();
    expect(mockCancelFollowUp).not.toHaveBeenCalled();
    expect(mockCreateExpectation).not.toHaveBeenCalled();
    expect(mockUpdateExpectation).not.toHaveBeenCalled();
    expect(mockMarkSeen).not.toHaveBeenCalled();
    expect(mockMarkNoShow).not.toHaveBeenCalled();
    expect(mockCancelExpectation).not.toHaveBeenCalled();
  });
});

describe("authorized calls", () => {
  beforeEach(() => mockRequireAdmin.mockResolvedValue(ADMIN));

  test("the queue reads through with the clamped window", async () => {
    await expect(getVetQueueAction(7)).resolves.toEqual([]);
    expect(mockListVetQueue).toHaveBeenCalledWith({ withinDays: 7 });
    // A nonsense window clamps to the default, a huge one to the cap.
    await getVetQueueAction(0);
    expect(mockListVetQueue).toHaveBeenLastCalledWith({ withinDays: 30 });
    await getVetQueueAction(99999);
    expect(mockListVetQueue).toHaveBeenLastCalledWith({ withinDays: 366 });
  });

  test("create routes to createFollowUp, update to updateFollowUp", async () => {
    await saveFollowUpAction(INPUT, null);
    expect(mockCreateFollowUp).toHaveBeenCalledWith(
      INPUT,
      "vet@example.com",
    );

    await saveFollowUpAction(INPUT, "fu-1", "2026-01-01T00:00:00Z");
    expect(mockUpdateFollowUp).toHaveBeenCalledWith(
      "fu-1",
      INPUT,
      "2026-01-01T00:00:00Z",
      "vet@example.com",
    );
  });

  test("terminal transitions pass the concurrency token and actor", async () => {
    await completeFollowUpAction("fu-1", "2026-01-01T00:00:00Z");
    expect(mockCompleteFollowUp).toHaveBeenCalledWith(
      "fu-1",
      "2026-01-01T00:00:00Z",
      "vet@example.com",
    );
    await cancelFollowUpAction("fu-1", "2026-01-01T00:00:00Z");
    expect(mockCancelFollowUp).toHaveBeenCalledWith(
      "fu-1",
      "2026-01-01T00:00:00Z",
      "vet@example.com",
    );
  });

  test("clinic expectation actions route correctly with token and actor", async () => {
    await saveClinicExpectationAction(CLINIC_INPUT, null);
    expect(mockCreateExpectation).toHaveBeenCalledWith(
      CLINIC_INPUT,
      "vet@example.com",
    );

    await saveClinicExpectationAction(CLINIC_INPUT, "ex-1", "ts-1");
    expect(mockUpdateExpectation).toHaveBeenCalledWith(
      "ex-1",
      CLINIC_INPUT,
      "ts-1",
      "vet@example.com",
    );

    await markClinicSeenAction("ex-1", "ts-1");
    expect(mockMarkSeen).toHaveBeenCalledWith(
      "ex-1",
      "ts-1",
      "vet@example.com",
      null,
    );
    await markClinicSeenAction("ex-1", "ts-1", "enc-9");
    expect(mockMarkSeen).toHaveBeenLastCalledWith(
      "ex-1",
      "ts-1",
      "vet@example.com",
      "enc-9",
    );

    await markClinicNoShowAction("ex-1", "ts-1");
    expect(mockMarkNoShow).toHaveBeenCalledWith(
      "ex-1",
      "ts-1",
      "vet@example.com",
    );
    await cancelClinicExpectationAction("ex-1", "ts-1");
    expect(mockCancelExpectation).toHaveBeenCalledWith(
      "ex-1",
      "ts-1",
      "vet@example.com",
    );
  });

  test("service failures map to SaveResult without leaking internals", async () => {
    mockCompleteFollowUp.mockResolvedValue({
      ok: false,
      reason: "conflict",
    });
    await expect(
      completeFollowUpAction("fu-1", "stale-ts"),
    ).resolves.toEqual({ ok: false, reason: "conflict" });

    mockCompleteFollowUp.mockRejectedValue(new Error("db down"));
    await expect(
      completeFollowUpAction("fu-1", "ts"),
    ).resolves.toEqual({ ok: false });
  });
});
