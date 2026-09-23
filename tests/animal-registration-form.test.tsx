// Component tests for the public animal-registration form. The server
// action and Storage are mocked at the module boundary — these tests pin
// down the submitted payload shape, the re-entrancy guard (double-submit
// protection), receipt upload binding, and that entered data survives a
// failed write. Server-side validation and idempotency are covered by
// tests/db (PGlite) and the domain service.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockSubmitAction, mockUploadBytes, mockToast } = vi.hoisted(() => ({
  mockSubmitAction: vi.fn(),
  mockUploadBytes: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/animal-registration/actions", () => ({
  submitRegistrationAction: mockSubmitAction,
}));

vi.mock("firebase/storage", () => ({
  ref: vi.fn((_storage: unknown, path: string) => ({ path })),
  uploadBytes: mockUploadBytes,
}));

vi.mock("@/lib/firebase", () => ({ storage: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { AnimalRegistration } from "@/components/animal-registration/animal-registration-page";

const UUID_PATH = /^receipts\/[0-9a-f-]{36}$/i;

async function fillValidForm() {
  fireEvent.change(screen.getByLabelText(/^Full Name/), {
    target: { value: "  Jane Doe  " },
  });
  fireEvent.change(screen.getByLabelText(/^Address/), {
    target: { value: "Windwardside, Saba" },
  });
  fireEvent.change(screen.getByLabelText(/^Phone Number/), {
    target: { value: "+599 416 0000" },
  });
  fireEvent.change(screen.getByLabelText(/^Email Address/), {
    target: { value: "jane@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/Animal's Name/), {
    target: { value: "Rex" },
  });
  fireEvent.change(screen.getByLabelText(/Type of Animal/), {
    target: { value: "Dog" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Male" }));
  fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I certify/ }));
}

function attachReceipt() {
  const receipt = new File(["img"], "receipt.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText(/Upload Payment Receipt/), {
    target: { files: [receipt] },
  });
}

function submit() {
  fireEvent.click(
    screen.getByRole("button", { name: /Submit Registration/ }),
  );
}

beforeEach(() => {
  mockSubmitAction.mockReset().mockResolvedValue({ ok: true });
  mockUploadBytes.mockReset().mockResolvedValue({});
  mockToast.mockReset();
});

describe("AnimalRegistration form", () => {
  test("submits a registration with trimmed owner data", async () => {
    render(<AnimalRegistration />);
    await fillValidForm();
    submit();

    await waitFor(() => expect(mockSubmitAction).toHaveBeenCalledTimes(1));
    const [input] = mockSubmitAction.mock.calls[0];
    expect(input.receiptPath).toBeNull();
    expect(input.submissionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(input).toMatchObject({
      ownerName: "Jane Doe",
      ownerAddress: "Windwardside, Saba",
      ownerPhone: "+599 416 0000",
      ownerEmail: "jane@example.com",
    });
    expect(input.animals).toEqual([
      { name: "Rex", type: "Dog", sex: "male", isFixed: "yes" },
    ]);

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Registration Submitted" }),
    );
  });

  test("a second submit during the write cannot create a duplicate", async () => {
    let resolveWrite!: () => void;
    mockSubmitAction.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        resolveWrite = () => resolve({ ok: true });
      }),
    );
    render(<AnimalRegistration />);
    await fillValidForm();

    // The button disables and relabels while submitting, so grab it once
    // and click repeatedly — later clicks hit the disabled button and
    // the re-entrancy guard.
    const button = screen.getByRole("button", {
      name: /Submit Registration/,
    });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    resolveWrite();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Registration Submitted" }),
      ),
    );
    expect(mockSubmitAction).toHaveBeenCalledTimes(1);
  });

  test("a failed submission shows an error and preserves entered data", async () => {
    mockSubmitAction.mockResolvedValue({ ok: false, reason: "error" });
    render(<AnimalRegistration />);
    await fillValidForm();
    submit();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Error",
          variant: "destructive",
        }),
      ),
    );
    // Entered data is preserved for retry — no false success, no reset.
    expect(screen.getByLabelText(/^Full Name/)).toHaveValue("  Jane Doe  ");
    expect(screen.getByLabelText(/Animal's Name/)).toHaveValue("Rex");
  });

  test("an attached receipt uploads to the path bound to the submission id", async () => {
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() => expect(mockSubmitAction).toHaveBeenCalledTimes(1));
    expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    // The upload target and the stored reference must both be
    // receipts/<submissionId> — the binding the sweep uses to classify
    // orphans.
    const uploadRef = mockUploadBytes.mock.calls[0][0] as { path: string };
    const [input] = mockSubmitAction.mock.calls[0];
    expect(uploadRef.path).toBe(`receipts/${input.submissionId}`);
    expect(input.receiptPath).toBe(`receipts/${input.submissionId}`);
    expect(uploadRef.path).toMatch(UUID_PATH);
  });

  test("a failed receipt upload still submits the registration", async () => {
    mockUploadBytes.mockRejectedValue(new Error("storage/unauthorized"));
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() => expect(mockSubmitAction).toHaveBeenCalledTimes(1));
    const [input] = mockSubmitAction.mock.calls[0];
    expect(input.receiptPath).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Registration Submitted",
        description: expect.stringContaining("receipt could not be uploaded"),
      }),
    );
  });

  test("a failed submission after a successful upload reports the error honestly", async () => {
    // The orphan receipt is left for the scheduled sweep — the form must
    // NOT report a false success.
    mockSubmitAction.mockResolvedValue({ ok: false, reason: "error" });
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Error", variant: "destructive" }),
      ),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Registration Submitted" }),
    );
    expect(screen.getByLabelText(/^Full Name/)).toHaveValue("  Jane Doe  ");
  });

  test("a retry after failure uses a fresh submission id and receipt path", async () => {
    mockSubmitAction.mockResolvedValueOnce({ ok: false, reason: "error" });
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Error" }),
      ),
    );

    // Retry — the form data is still there, including the file input's
    // File object in state.
    submit();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Registration Submitted" }),
      ),
    );

    expect(mockSubmitAction).toHaveBeenCalledTimes(2);
    expect(mockUploadBytes).toHaveBeenCalledTimes(2);
    const [first, second] = mockSubmitAction.mock.calls.map((c) => c[0]);
    expect(second.submissionId).not.toBe(first.submissionId);
    expect(second.receiptPath).toBe(`receipts/${second.submissionId}`);
  });

  test("a disallowed receipt file is rejected before upload", async () => {
    render(<AnimalRegistration />);
    const bad = new File(["<html>"], "page.html", { type: "text/html" });
    fireEvent.change(screen.getByLabelText(/Upload Payment Receipt/), {
      target: { files: [bad] },
    });
    expect(
      await screen.findByText(/must be an image or PDF/),
    ).toBeInTheDocument();

    await fillValidForm();
    submit();
    await waitFor(() => expect(mockSubmitAction).toHaveBeenCalledTimes(1));
    expect(mockUploadBytes).not.toHaveBeenCalled();
  });
});
