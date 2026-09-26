// Component tests for /admin/registrations (#91, Postgres cutover in
// #183): per-row pending guards on status changes and receipt lookups,
// a retryable load-error state, and feedback that never includes
// private owner data. Server actions are mocked at the module boundary.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockListRegistrations,
  mockSetStatus,
  mockGetReceiptUrl,
  mockGetQueues,
  mockCreateFromSubmission,
  mockSearchAnimals,
  mockCreateRegistration,
  mockListPendingPayments,
  mockListConfirmationsDue,
  mockToast,
} = vi.hoisted(() => ({
  mockListRegistrations: vi.fn(),
  mockSetStatus: vi.fn(),
  mockGetReceiptUrl: vi.fn(),
  mockGetQueues: vi.fn(),
  mockCreateFromSubmission: vi.fn(),
  mockSearchAnimals: vi.fn(),
  mockCreateRegistration: vi.fn(),
  mockListPendingPayments: vi.fn(),
  mockListConfirmationsDue: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/admin/registrations/actions", () => ({
  listRegistrationsAction: mockListRegistrations,
  setRegistrationStatusAction: mockSetStatus,
  getReceiptUrlAction: mockGetReceiptUrl,
  getRegistrationQueuesAction: mockGetQueues,
  createRegistrationFromSubmissionAction: mockCreateFromSubmission,
  searchAnimalsForLinkAction: mockSearchAnimals,
  // #177 reconciliation/confirmation queue feeds.
  listPendingPaymentsAction: mockListPendingPayments,
  listConfirmationsDueAction: mockListConfirmationsDue,
}));

vi.mock("@/app/admin/animals/[id]/actions", () => ({
  createRegistrationAction: mockCreateRegistration,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import RegistrationsPage from "@/app/admin/registrations/page";

const REG_PENDING = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerInfo: {
    name: "Jane Doe",
    address: "Windwardside",
    phone: "+599 416 0000",
    email: "jane@example.com",
  },
  animals: [{ name: "Rex", type: "Dog", sex: "male", isFixed: "yes" }],
  totalFee: 10,
  status: "pending",
  paymentReceipt: "receipts/11111111-1111-4111-8111-111111111111",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListRegistrations.mockResolvedValue([]);
  mockSetStatus.mockResolvedValue({ ok: true });
  mockGetReceiptUrl.mockResolvedValue({
    ok: true,
    url: "https://example.com/signed",
  });
  mockGetQueues.mockResolvedValue({
    year: 2026,
    unregistered: [],
    pendingSubmissions: 0,
    outstanding: [],
    completed: [],
  });
  mockCreateFromSubmission.mockResolvedValue({ ok: true });
  mockSearchAnimals.mockResolvedValue([]);
  mockCreateRegistration.mockResolvedValue({ ok: true });
  mockListPendingPayments.mockResolvedValue([]);
  mockListConfirmationsDue.mockResolvedValue([]);
});

describe("admin registrations", () => {
  test("load failure shows a retryable error, not an empty list", async () => {
    mockListRegistrations
      .mockRejectedValueOnce(new Error("deadline-exceeded"))
      .mockResolvedValueOnce([REG_PENDING]);

    render(<RegistrationsPage />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Couldn.t load registrations/,
      ),
    );
    expect(
      screen.queryByText(/No registrations yet/),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByText("Jane Doe")).toBeInTheDocument(),
    );
  });

  test("double-clicking approve fires a single status write", async () => {
    let resolveUpdate: () => void = () => {};
    mockSetStatus.mockImplementation(
      () => new Promise((r) => { resolveUpdate = () => r({ ok: true }); }),
    );
    mockListRegistrations.mockResolvedValue([REG_PENDING]);
    render(<RegistrationsPage />);
    await waitFor(() => screen.getByText("Jane Doe"));

    const approve = screen.getByRole("button", {
      name: "Verify registration",
    });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
    expect(mockSetStatus).toHaveBeenCalledWith(REG_PENDING.id, "approved");

    // While the write is in flight the other row actions are disabled.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reject registration" }),
      ).toBeDisabled(),
    );

    resolveUpdate();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Registration Updated" }),
      ),
    );
    // The confirmation toast must not carry owner PII.
    const descriptions = mockToast.mock.calls
      .map((c) => `${c[0].title} ${c[0].description}`)
      .join(" ");
    expect(descriptions).not.toContain("Jane Doe");
    expect(descriptions).not.toContain("jane@example.com");
  });

  test("failed status change reports a retryable error toast", async () => {
    mockSetStatus.mockResolvedValue({ ok: false });
    mockListRegistrations.mockResolvedValue([REG_PENDING]);
    render(<RegistrationsPage />);
    await waitFor(() => screen.getByText("Jane Doe"));

    fireEvent.click(
      screen.getByRole("button", { name: "Verify registration" }),
    );
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
    expect(mockToast.mock.calls.map((c) => c[0].description).join(" ")).not.toContain(
      "unavailable",
    );
    // The row remains pending — nothing was silently updated.
    expect(
      screen.getByRole("button", { name: "Verify registration" }),
    ).toBeEnabled();
  });

  test("receipt lookup is guarded against double clicks", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);
    mockListRegistrations.mockResolvedValue([REG_PENDING]);
    render(<RegistrationsPage />);
    await waitFor(() => screen.getByText("Jane Doe"));

    const receiptButton = screen.getByRole("button", {
      name: "View payment receipt",
    });
    fireEvent.click(receiptButton);
    fireEvent.click(receiptButton);
    await waitFor(() =>
      expect(mockGetReceiptUrl).toHaveBeenCalledTimes(1),
    );
    expect(mockGetReceiptUrl).toHaveBeenCalledWith(
      REG_PENDING.paymentReceipt,
    );
    openSpy.mockRestore();
  });
});
