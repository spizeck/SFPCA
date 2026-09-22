// Component tests for /admin/registrations (#91): per-row pending
// guards on status changes and receipt lookups, a retryable load-error
// state, and feedback that never includes private owner data.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockGetDocs,
  mockUpdateDoc,
  mockGetDownloadURL,
  mockToast,
} = vi.hoisted(() => ({
  mockGetDocs: vi.fn(),
  mockUpdateDoc: vi.fn(),
  mockGetDownloadURL: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  getDocs: mockGetDocs,
  doc: vi.fn((_db: unknown, _col: string, id: string) => ({ id })),
  updateDoc: mockUpdateDoc,
  serverTimestamp: () => "SERVER_TS",
}));

vi.mock("firebase/storage", () => ({
  ref: vi.fn((_storage: unknown, path: string) => ({ path })),
  getDownloadURL: mockGetDownloadURL,
}));

vi.mock("@/lib/firebase", () => ({ db: {}, storage: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import RegistrationsPage from "@/app/admin/registrations/page";

const REG_PENDING = {
  id: "r1",
  data: () => ({
    ownerInfo: {
      name: "Jane Doe",
      address: "Windwardside",
      phone: "+599 416 0000",
      email: "jane@example.com",
    },
    animals: [
      { name: "Rex", type: "Dog", sex: "Male", isFixed: "yes" },
    ],
    totalFee: 10,
    status: "pending",
    paymentReceipt: "receipts/r1",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  }),
};

// The page iterates the snapshot with forEach — mirror that shape.
function snapshot(docs: { id: string; data: () => Record<string, unknown> }[]) {
  return { docs, forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDocs.mockResolvedValue(snapshot([]));
});

describe("admin registrations", () => {
  test("load failure shows a retryable error, not an empty list", async () => {
    mockGetDocs
      .mockRejectedValueOnce(new Error("deadline-exceeded"))
      .mockResolvedValueOnce(snapshot([REG_PENDING]));

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
    mockUpdateDoc.mockImplementation(
      () => new Promise((r) => { resolveUpdate = () => r(undefined); }),
    );
    mockGetDocs.mockResolvedValue(snapshot([REG_PENDING]));
    render(<RegistrationsPage />);
    await waitFor(() => screen.getByText("Jane Doe"));

    const approve = screen.getByRole("button", {
      name: "Verify registration",
    });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);

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
    mockUpdateDoc.mockRejectedValue(new Error("unavailable"));
    mockGetDocs.mockResolvedValue(snapshot([REG_PENDING]));
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
    mockGetDownloadURL.mockResolvedValue("https://example.com/receipt.png");
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);
    mockGetDocs.mockResolvedValue(snapshot([REG_PENDING]));
    render(<RegistrationsPage />);
    await waitFor(() => screen.getByText("Jane Doe"));

    const receiptButton = screen.getByRole("button", {
      name: "View payment receipt",
    });
    fireEvent.click(receiptButton);
    fireEvent.click(receiptButton);
    await waitFor(() =>
      expect(mockGetDownloadURL).toHaveBeenCalledTimes(1),
    );
    openSpy.mockRestore();
  });
});
