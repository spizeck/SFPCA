// Component + rule tests for the clinical-document upload flow (#192).
// The server action and Storage SDK are mocked at the module boundary —
// these tests pin down client validation, the upload-then-register
// ordering, and the bound storage path shape. Server-side validation,
// the unique-path guarantee, and the link checks are covered by
// tests/db/vet-documents.test.ts (PGlite).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockRegister, mockUploadBytes, mockToast } = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockUploadBytes: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/app/admin/animals/[id]/actions", () => ({
  registerVetDocumentAction: mockRegister,
}));

vi.mock("firebase/storage", () => ({
  ref: vi.fn((_storage: unknown, path: string) => ({ path })),
  uploadBytes: mockUploadBytes,
}));

vi.mock("@/lib/firebase", () => ({ storage: {} }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { DocumentUploadDialog } from "@/components/admin/medical/document-dialog";
import {
  isVetDocumentFile,
  vetDocStoragePath,
  VET_DOC_PATH_RE,
} from "@/lib/medical";

const ENCOUNTERS = [
  {
    id: "enc-1",
    animalId: "animal-uuid-1",
    kind: "visit",
    occurredOn: "2026-06-01",
    provider: null,
    reason: "Limping",
    complaint: null,
    findings: null,
    assessment: null,
    plan: null,
    notes: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
];

const VACCINATIONS = [
  {
    id: "vax-1",
    animalId: "animal-uuid-1",
    encounterId: null,
    vaccineName: "Rabies",
    seriesKey: "rabies",
    administeredOn: "2025-10-01",
    dueOn: null,
    validUntil: null,
    productName: null,
    manufacturer: null,
    lotNumber: null,
    administeredBy: null,
    notes: null,
    documentPath: null,
    createdAt: "2025-10-01T00:00:00.000Z",
    updatedAt: "2025-10-01T00:00:00.000Z",
  },
];

function renderDialog(overrides: Partial<Parameters<typeof DocumentUploadDialog>[0]> = {}) {
  const props = {
    animalId: "animal-uuid-1",
    animalName: "Rex",
    encounters: ENCOUNTERS,
    vaccinations: VACCINATIONS,
    open: true,
    onOpenChange: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  render(<DocumentUploadDialog {...props} />);
  return props;
}

function attachFile(file: File) {
  fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });
}

const pdf = () => new File(["%PDF-1.4"], "lab.pdf", { type: "application/pdf" });

beforeEach(() => {
  vi.clearAllMocks();
  mockUploadBytes.mockResolvedValue({});
  mockRegister.mockResolvedValue({ ok: true });
});

describe("isVetDocumentFile / vetDocStoragePath", () => {
  test("accepts images and PDFs within the size bound only", () => {
    expect(isVetDocumentFile({ type: "image/png", size: 100 })).toBe(true);
    expect(isVetDocumentFile({ type: "application/pdf", size: 100 })).toBe(true);
    expect(isVetDocumentFile({ type: "text/html", size: 100 })).toBe(false);
    expect(isVetDocumentFile({ type: "image/png", size: 0 })).toBe(false);
    expect(
      isVetDocumentFile({ type: "image/png", size: 5 * 1024 * 1024 + 1 }),
    ).toBe(false);
  });

  test("rejects a file at exactly the limit — the Storage rule is strict (<)", () => {
    // The vet-docs rule rejects `size < 5 * 1024 * 1024`; the validator
    // must match or an exactly-5-MiB file passes the dialog, fails
    // uploadBytes, and surfaces as a generic "Upload failed".
    expect(
      isVetDocumentFile({ type: "image/png", size: 5 * 1024 * 1024 }),
    ).toBe(false);
    expect(
      isVetDocumentFile({ type: "image/png", size: 5 * 1024 * 1024 - 1 }),
    ).toBe(true);
  });

  test("built paths satisfy the shared path regex and carry the extension", () => {
    const path = vetDocStoragePath("Lab Report.PDF");
    expect(VET_DOC_PATH_RE.test(path)).toBe(true);
    expect(path).toMatch(/^vet-docs\/[0-9a-f-]{36}\.pdf$/i);
    expect(vetDocStoragePath("noext")).toMatch(/^vet-docs\/[0-9a-f-]{36}$/i);
  });
});

describe("DocumentUploadDialog", () => {
  test("requires a valid file and a label before uploading", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    expect(screen.getByText(/Choose an image or PDF/)).toBeInTheDocument();
    expect(screen.getByText(/Give the document a short label/)).toBeInTheDocument();
    expect(mockUploadBytes).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  test("rejects a wrong-type file without uploading", () => {
    renderDialog();
    attachFile(new File(["<html>"], "evil.html", { type: "text/html" }));
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Lab report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    expect(mockUploadBytes).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  test("uploads first, then registers the row bound to the storage path", async () => {
    const props = renderDialog();
    attachFile(pdf());
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Lab report" },
    });
    fireEvent.change(screen.getByLabelText(/Notes/), {
      target: { value: "CBC panel" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    const [refArg] = mockUploadBytes.mock.calls[0];
    expect(VET_DOC_PATH_RE.test(refArg.path)).toBe(true);
    expect(refArg.path).toMatch(/\.pdf$/);
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        animalId: "animal-uuid-1",
        storagePath: refArg.path,
        label: "Lab report",
        notes: "CBC panel",
        encounterId: null,
        vaccinationId: null,
      }),
    );
    expect(props.onSaved).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Success" }),
    );
  });

  test("a failed upload never calls the register action", async () => {
    mockUploadBytes.mockRejectedValue(new Error("storage/unauthorized"));
    renderDialog();
    attachFile(pdf());
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Lab report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Upload failed" }),
      ),
    );
    expect(mockRegister).not.toHaveBeenCalled();
  });

  test("server-side field errors surface on the form", async () => {
    mockRegister.mockResolvedValue({
      ok: false,
      reason: "invalid",
      field: "label",
    });
    renderDialog();
    attachFile(pdf());
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Give the document a short label/),
      ).toBeInTheDocument(),
    );
  });

  test("link selects offer this animal's encounters and vaccinations", async () => {
    renderDialog();
    expect(screen.getByLabelText(/Linked visit/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Linked vaccination/)).toBeInTheDocument();
  });
});
