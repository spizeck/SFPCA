// Component tests for the public animal-registration form. Firebase is
// mocked at the module boundary — these tests pin down the submitted
// payload shape, the re-entrancy guard (double-submit protection),
// receipt upload behavior, and that entered data survives a failed
// write. Rules-level enforcement is covered by security-rules.test.mjs.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockAddDoc, mockUploadBytes, mockToast } = vi.hoisted(() => ({
  mockAddDoc: vi.fn(),
  mockUploadBytes: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  addDoc: mockAddDoc,
  serverTimestamp: () => "SERVER_TS",
}));

vi.mock("firebase/storage", () => ({
  ref: vi.fn((_storage: unknown, path: string) => ({ path })),
  uploadBytes: mockUploadBytes,
}));

vi.mock("@/lib/firebase", () => ({ db: {}, storage: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { AnimalRegistration } from "@/components/animal-registration/animal-registration-page";

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

function submit() {
  fireEvent.click(
    screen.getByRole("button", { name: /Submit Registration/ }),
  );
}

beforeEach(() => {
  mockAddDoc.mockReset().mockResolvedValue({ id: "reg-1" });
  mockUploadBytes.mockReset().mockResolvedValue({});
  mockToast.mockReset();
});

describe("AnimalRegistration form", () => {
  test("submits a pending registration with trimmed owner data", async () => {
    render(<AnimalRegistration />);
    await fillValidForm();
    submit();

    await waitFor(() => expect(mockAddDoc).toHaveBeenCalledTimes(1));
    const [, payload] = mockAddDoc.mock.calls[0];
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
    let resolveWrite!: (value: { id: string }) => void;
    mockAddDoc.mockReturnValue(
      new Promise((resolve) => {
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

    resolveWrite({ id: "reg-1" });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Registration Submitted" }),
      ),
    );
    expect(mockAddDoc).toHaveBeenCalledTimes(1);
  });

  test("failed writes show an error and preserve entered data", async () => {
    mockAddDoc.mockRejectedValue(new Error("permission-denied"));
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

  test("an attached receipt is uploaded and its path stored", async () => {
    render(<AnimalRegistration />);
    await fillValidForm();

    const receipt = new File(["%PDF-1.4"], "receipt.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByLabelText(/Upload Payment Receipt/), {
      target: { files: [receipt] },
    });
    submit();

    await waitFor(() => expect(mockAddDoc).toHaveBeenCalledTimes(1));
    expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    const [, payload] = mockAddDoc.mock.calls[0];
    expect(payload.paymentReceipt).toMatch(/^receipts\//);
  });

  test("a failed receipt upload still submits the registration", async () => {
    mockUploadBytes.mockRejectedValue(new Error("storage/unauthorized"));
    render(<AnimalRegistration />);
    await fillValidForm();

    const receipt = new File(["img"], "receipt.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Upload Payment Receipt/), {
      target: { files: [receipt] },
    });
    submit();

    await waitFor(() => expect(mockAddDoc).toHaveBeenCalledTimes(1));
    const [, payload] = mockAddDoc.mock.calls[0];
    expect(payload.paymentReceipt).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Registration Submitted",
        description: expect.stringContaining("receipt could not be uploaded"),
      }),
    );
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
    await waitFor(() => expect(mockAddDoc).toHaveBeenCalledTimes(1));
    expect(mockUploadBytes).not.toHaveBeenCalled();
  });
});
