// Component tests for /admin/faq (#91): field-level validation that
// preserves entered data, safe failure feedback (no raw Firebase
// messages), named destructive confirmation, and a retryable load
// failure distinct from the empty state.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetDocs, mockAddDoc, mockUpdateDoc, mockDeleteDoc, mockToast } =
  vi.hoisted(() => ({
    mockGetDocs: vi.fn(),
    mockAddDoc: vi.fn(),
    mockUpdateDoc: vi.fn(),
    mockDeleteDoc: vi.fn(),
    mockToast: vi.fn(),
  }));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  getDocs: mockGetDocs,
  addDoc: mockAddDoc,
  updateDoc: mockUpdateDoc,
  deleteDoc: mockDeleteDoc,
  doc: vi.fn((_db: unknown, _col: string, id: string) => ({ id })),
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import FAQManager from "@/app/admin/faq/page";

function faqDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

// Firestore snapshots expose both .docs and .forEach — the page uses
// forEach, so the mock must too.
function snapshot(docs: { id: string; data: () => Record<string, unknown> }[]) {
  return { docs, forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb) };
}

const FAQ_A = {
  category: "General",
  question: "How do I register my dog?",
  answer: "Fill in the registration form.",
  order: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDocs.mockResolvedValue(snapshot([]));
});

describe("admin FAQs", () => {
  test("load failure shows a retryable error, not the empty state", async () => {
    mockGetDocs
      .mockRejectedValueOnce(new Error("internal backend detail"))
      .mockResolvedValueOnce(snapshot([faqDoc("f1", FAQ_A)]));

    render(<FAQManager />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Couldn.t load FAQs/,
      ),
    );
    expect(screen.queryByText(/No FAQs yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByText("How do I register my dog?"),
      ).toBeInTheDocument(),
    );
  });

  test("validation names missing fields and preserves entered data", async () => {
    render(<FAQManager />);
    await waitFor(() => screen.getByText(/No FAQs yet/));

    fireEvent.click(screen.getByRole("button", { name: /Add FAQ/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Draft question" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add FAQ" }));

    await waitFor(() => {
      expect(screen.getByText("Choose a category.")).toBeInTheDocument();
      expect(screen.getByText("Enter an answer.")).toBeInTheDocument();
    });
    expect(mockAddDoc).not.toHaveBeenCalled();
    // Validation failures are field-level, not toasts.
    expect(mockToast).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Question")).toHaveValue("Draft question");
    // Invalid fields are announced via aria-invalid/describedby.
    expect(screen.getByLabelText("Question")).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Answer")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  }, 15000);

  test("save failure keeps data and never leaks raw error text", async () => {
    mockUpdateDoc.mockRejectedValue(new Error("firestore internal 9"));
    mockGetDocs.mockResolvedValue(snapshot([faqDoc("f1", FAQ_A)]));
    render(<FAQManager />);
    await waitFor(() =>
      screen.getByText("How do I register my dog?"),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit FAQ: How do I register my dog?",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Update FAQ" }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      ),
    );
    expect(mockToast.mock.calls.map((c) => c[0].description).join(" ")).not.toContain(
      "firestore internal 9",
    );
    expect(screen.getByLabelText("Question")).toHaveValue(FAQ_A.question);
  });

  test("delete confirms by naming the question; cancel is a no-op", async () => {
    mockGetDocs.mockResolvedValue(snapshot([faqDoc("f1", FAQ_A)]));
    render(<FAQManager />);
    await waitFor(() =>
      screen.getByText("How do I register my dog?"),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete FAQ: How do I register my dog?",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/How do I register my dog\?/);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mockDeleteDoc).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete FAQ: How do I register my dog?",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete" }),
    );
    await waitFor(() => expect(mockDeleteDoc).toHaveBeenCalledTimes(1));
  });
});
