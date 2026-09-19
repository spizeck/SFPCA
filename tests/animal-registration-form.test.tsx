// Component tests for the public animal-registration form. Firebase is
// mocked at the module boundary — these tests pin down the submitted
// payload shape, the re-entrancy guard (double-submit protection),
// receipt upload/orphan-cleanup behavior, and that entered data
// survives a failed write. Rules-level enforcement is covered by
// security-rules.test.mjs.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  mockDoc,
  mockSetDoc,
  mockUploadBytes,
  mockDeleteObject,
  mockToast,
} = vi.hoisted(() => ({
  mockDoc: vi.fn(),
  mockSetDoc: vi.fn(),
  mockUploadBytes: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  doc: mockDoc,
  setDoc: mockSetDoc,
  serverTimestamp: () => "SERVER_TS",
}));

vi.mock("firebase/storage", () => ({
  ref: vi.fn((_storage: unknown, path: string) => ({ path })),
  uploadBytes: mockUploadBytes,
  deleteObject: mockDeleteObject,
}));

vi.mock("@/lib/firebase", () => ({ db: {}, storage: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { AnimalRegistration } from "@/components/animal-registration/animal-registration-page";

let nextDocId = 0;

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
  nextDocId = 0;
  // doc() allocates a fresh registration ID per submission — the bound
  // receipts/<id> path differs on every attempt, which the retry test
  // relies on.
  mockDoc.mockReset().mockImplementation(() => ({
    id: `reg-${++nextDocId}`,
  }));
  mockSetDoc.mockReset().mockResolvedValue(undefined);
  mockUploadBytes.mockReset().mockResolvedValue({});
  mockDeleteObject.mockReset().mockResolvedValue(undefined);
  mockToast.mockReset();
});

describe("AnimalRegistration form", () => {
  test("submits a pending registration with trimmed owner data", async () => {
    render(<AnimalRegistration />);
    await fillValidForm();
    submit();

    await waitFor(() => expect(mockSetDoc).toHaveBeenCalledTimes(1));
    const [, payload] = mockSetDoc.mock.calls[0];
    expect(payload.status).toBe("pending");
    expect(payload.paymentReceipt).toBeNull();
    expect(payload.totalFee).toBe(10);
    expect(payload.ownerInfo).toEqual({
      name: "Jane Doe",
      address: "Windwardside, Saba",
      phone: "+599 416 0000",
      email: "jane@example.com",
    });
    expect(payload.animals).toEqual([
      { name: "Rex", type: "Dog", sex: "male", isFixed: "yes" },
    ]);

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Registration Submitted" }),
    );
  });

  test("a second submit during the write cannot create a duplicate", async () => {
    let resolveWrite!: () => void;
    mockSetDoc.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
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
    expect(mockSetDoc).toHaveBeenCalledTimes(1);
  });

  test("failed writes show an error and preserve entered data", async () => {
    mockSetDoc.mockRejectedValue(new Error("permission-denied"));
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
    // No receipt was attached, so no cleanup is attempted.
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  test("an attached receipt uploads to the path bound to the doc id", async () => {
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() => expect(mockSetDoc).toHaveBeenCalledTimes(1));
    expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    // The upload target and the stored reference must both be
    // receipts/<registration doc id> — the binding that authorizes
    // orphan cleanup and blocks arbitrary receipt references.
    expect(mockUploadBytes.mock.calls[0][0]).toEqual({
      path: "receipts/reg-1",
    });
    const [docRef, payload] = mockSetDoc.mock.calls[0];
    expect(docRef).toEqual({ id: "reg-1" });
    expect(payload.paymentReceipt).toBe("receipts/reg-1");
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  test("a failed receipt upload still submits the registration", async () => {
    mockUploadBytes.mockRejectedValue(new Error("storage/unauthorized"));
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() => expect(mockSetDoc).toHaveBeenCalledTimes(1));
    const [, payload] = mockSetDoc.mock.calls[0];
    expect(payload.paymentReceipt).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Registration Submitted",
        description: expect.stringContaining("receipt could not be uploaded"),
      }),
    );
  });

  test("a failed write after a successful upload removes the orphan receipt", async () => {
    mockSetDoc.mockRejectedValue(new Error("permission-denied"));
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() => expect(mockDeleteObject).toHaveBeenCalledTimes(1));
    // Cleanup targets exactly the just-uploaded object.
    expect(mockDeleteObject.mock.calls[0][0]).toEqual({
      path: "receipts/reg-1",
    });
    // The failure is still reported honestly and data is preserved.
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Error", variant: "destructive" }),
      ),
    );
    expect(screen.getByLabelText(/^Full Name/)).toHaveValue("  Jane Doe  ");
  });

  test("a denied cleanup means the write landed — report success, keep the receipt", async () => {
    // Simulates a lost setDoc response: the document exists, so the
    // rules deny anonymous deletion of its now-referenced receipt.
    mockSetDoc.mockRejectedValue(new Error("network-request-failed"));
    mockDeleteObject.mockRejectedValue(
      Object.assign(new Error("denied"), { code: "storage/unauthorized" }),
    );
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Registration Submitted" }),
      ),
    );
  });

  test("a failed cleanup still reports the write failure honestly", async () => {
    // Cleanup fails for a non-authorization reason (e.g. offline). The
    // orphan is left for the scheduled sweeper — the user must NOT see
    // a false success.
    mockSetDoc.mockRejectedValue(new Error("permission-denied"));
    mockDeleteObject.mockRejectedValue(
      Object.assign(new Error("gone"), { code: "storage/retry-limit-exceeded" }),
    );
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

  test("a retry after failure uses a fresh doc id and receipt path", async () => {
    // First attempt: upload succeeds, write fails, cleanup succeeds.
    mockSetDoc.mockRejectedValueOnce(new Error("permission-denied"));
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

    expect(mockSetDoc).toHaveBeenCalledTimes(2);
    expect(mockUploadBytes).toHaveBeenCalledTimes(2);
    // The retry uploaded to a new bound path — no stale reference reuse,
    // and the cleaned-up first upload is never pointed at again.
    expect(mockUploadBytes.mock.calls[1][0]).toEqual({
      path: "receipts/reg-2",
    });
    const [, retryPayload] = mockSetDoc.mock.calls[1];
    expect(retryPayload.paymentReceipt).toBe("receipts/reg-2");
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
    await waitFor(() => expect(mockSetDoc).toHaveBeenCalledTimes(1));
    expect(mockUploadBytes).not.toHaveBeenCalled();
  });
});
