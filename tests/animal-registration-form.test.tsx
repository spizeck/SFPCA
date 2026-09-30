// Component tests for the public animal-registration form. The server
// actions are mocked at the module boundary — these tests pin down the
// submitted payload shape, the re-entrancy guard (double-submit
// protection), the post-submit receipt-entitlement flow (#219), the
// honeypot field, and that entered data survives a failed write.
// Server-side validation and idempotency are covered by tests/db
// (PGlite) and the domain service.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockSubmitAction, mockFinalizeAction, mockToast, mockFetch } =
  vi.hoisted(() => ({
    mockSubmitAction: vi.fn(),
    mockFinalizeAction: vi.fn(),
    mockToast: vi.fn(),
    mockFetch: vi.fn(),
  }));

vi.mock("@/app/animal-registration/actions", () => ({
  submitRegistrationAction: mockSubmitAction,
  finalizeReceiptAction: mockFinalizeAction,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.stubGlobal("fetch", mockFetch);

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
  mockSubmitAction
    .mockReset()
    .mockImplementation((input: { submissionId: string; wantsReceipt?: boolean }) =>
      Promise.resolve({
        ok: true,
        submissionId: input.submissionId,
        receiptUpload: input.wantsReceipt ? { mode: "server-save" } : null,
      }),
    );
  mockFinalizeAction.mockReset().mockResolvedValue({ ok: true });
  mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
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
    expect(input.website).toBe(""); // honeypot always present, always empty
    expect(input.wantsReceipt).toBe(false);
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

  test("the honeypot field is invisible and unreachable by keyboard", () => {
    render(<AnimalRegistration />);
    const field = document.querySelector<HTMLInputElement>(
      'input[name="website"]',
    );
    expect(field).not.toBeNull();
    expect(field!.tabIndex).toBe(-1);
    expect(field!.closest("[aria-hidden]")).not.toBeNull();
    // Filling it posts the value verbatim — the server decides.
    fireEvent.change(field!, { target: { value: "spam.example" } });
  });

  test("a second submit during the write cannot create a duplicate", async () => {
    let resolveWrite!: () => void;
    mockSubmitAction.mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveWrite = () =>
          resolve({
            ok: true,
            submissionId: "11111111-2222-4333-8444-555555555555",
            receiptUpload: null,
          });
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

  test("a throttled submission gets a calm message and keeps the form", async () => {
    mockSubmitAction.mockResolvedValue({ ok: false, reason: "throttled" });
    render(<AnimalRegistration />);
    await fillValidForm();
    submit();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Please wait a moment",
          description: expect.stringContaining("entries are preserved"),
        }),
      ),
    );
    // Nothing was framed as a crash and nothing was cleared.
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Error" }),
    );
    expect(screen.getByLabelText(/^Full Name/)).toHaveValue("  Jane Doe  ");
    // No entitlement or receipt work should follow a throttle.
    expect(mockFinalizeAction).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("receipt upload follows the server grant — server-save mode", async () => {
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() => expect(mockSubmitAction).toHaveBeenCalledTimes(1));
    const [input] = mockSubmitAction.mock.calls[0];
    expect(input.wantsReceipt).toBe(true);

    // The file goes to finalizeReceiptAction bound to the same
    // client-generated submission id — the object path is derived
    // server-side (receipts/<submissionId>), never client-supplied.
    await waitFor(() =>
      expect(mockFinalizeAction).toHaveBeenCalledWith({
        submissionId: input.submissionId,
        file: expect.any(File),
      }),
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Registration Submitted" }),
    );
  });

  test("receipt upload follows the server grant — signed-url mode", async () => {
    mockSubmitAction.mockImplementation((input) =>
      Promise.resolve({
        ok: true,
        submissionId: input.submissionId,
        receiptUpload: {
          mode: "signed-url",
          url: "https://storage.example/signed-put",
        },
      }),
    );
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    const [input] = await waitFor(() => {
      expect(mockSubmitAction).toHaveBeenCalledTimes(1);
      return mockSubmitAction.mock.calls[0];
    });
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "https://storage.example/signed-put",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    // After the PUT lands, finalize binds the path — no file payload.
    await waitFor(() =>
      expect(mockFinalizeAction).toHaveBeenCalledWith({
        submissionId: input.submissionId,
        file: null,
      }),
    );
  });

  test("a failed receipt upload still submits the registration", async () => {
    mockFinalizeAction.mockResolvedValue({ ok: false, reason: "error" });
    render(<AnimalRegistration />);
    await fillValidForm();
    attachReceipt();
    submit();

    await waitFor(() => expect(mockSubmitAction).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Registration Submitted",
        description: expect.stringContaining("receipt could not be uploaded"),
      }),
    );
  });

  test("a failed submission reports the error honestly — no receipt work", async () => {
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
    expect(mockFinalizeAction).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Full Name/)).toHaveValue("  Jane Doe  ");
  });

  test("a retry after failure uses a fresh submission id", async () => {
    mockSubmitAction
      .mockResolvedValueOnce({ ok: false, reason: "error" })
      .mockImplementation((input) =>
        Promise.resolve({
          ok: true,
          submissionId: input.submissionId,
          receiptUpload: { mode: "server-save" },
        }),
      );
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
    // The failed first attempt performs no receipt work at all — the
    // entitlement only exists after a successful submission, which is
    // what prevents orphaned receipt objects on write failure.
    expect(mockFinalizeAction).toHaveBeenCalledTimes(1);
    const [first, second] = mockSubmitAction.mock.calls.map((c) => c[0]);
    expect(second.submissionId).not.toBe(first.submissionId);
  });

  test("a disallowed receipt file is rejected before any upload", async () => {
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
    const [input] = mockSubmitAction.mock.calls[0];
    expect(input.wantsReceipt).toBe(false);
    expect(mockFinalizeAction).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
