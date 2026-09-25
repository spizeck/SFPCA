// Unit tests for the canonical registration vocabulary (#169) — period
// semantics, status labels, and the derived payment-state function. The
// DB invariants live in tests/db/registrations.test.ts.
import { describe, test, expect } from "vitest";
import {
  currentRegistrationYear,
  derivePaymentState,
  isRegistrationRecordStatus,
  isRegistrationResolution,
  isRegistrationYear,
  registrationPeriodLabel,
} from "@/lib/registrations";

describe("registration period", () => {
  test("calendar-year periods — the period IS the year", () => {
    expect(currentRegistrationYear("2026-01-01")).toBe(2026);
    expect(currentRegistrationYear("2026-12-31")).toBe(2026);
    expect(currentRegistrationYear(new Date("2026-06-15T12:00:00Z"))).toBe(
      2026,
    );
  });

  test("period boundaries are deterministic — no calendar rollover flakes", () => {
    // Last instant of one year vs first instant of the next.
    expect(currentRegistrationYear("2026-12-31")).toBe(2026);
    expect(currentRegistrationYear("2027-01-01")).toBe(2027);
  });

  test("year validation bounds", () => {
    expect(isRegistrationYear(2026)).toBe(true);
    expect(isRegistrationYear(1999)).toBe(false);
    expect(isRegistrationYear(2201)).toBe(false);
    expect(isRegistrationYear(2026.5)).toBe(false);
    expect(isRegistrationYear("2026")).toBe(false);
  });

  test("period label", () => {
    expect(registrationPeriodLabel(2026)).toBe("2026 registration");
  });
});

describe("registration status vocabulary", () => {
  test("statuses are exactly active/cancelled — payment is never a status", () => {
    expect(isRegistrationRecordStatus("active")).toBe(true);
    expect(isRegistrationRecordStatus("cancelled")).toBe(true);
    // Deliberately absent — these belong to submissions or derivation.
    expect(isRegistrationRecordStatus("pending")).toBe(false);
    expect(isRegistrationRecordStatus("paid")).toBe(false);
    expect(isRegistrationRecordStatus("approved")).toBe(false);
    expect(isRegistrationRecordStatus("unpaid")).toBe(false);
  });

  test("resolutions are exactly waived/complimentary", () => {
    expect(isRegistrationResolution("waived")).toBe(true);
    expect(isRegistrationResolution("complimentary")).toBe(true);
    expect(isRegistrationResolution("paid")).toBe(false);
    expect(isRegistrationResolution(null)).toBe(false);
  });
});

describe("derivePaymentState", () => {
  test("resolution beats the ledger — waived/complimentary never reads as unpaid", () => {
    expect(derivePaymentState(10000, 0, "waived")).toBe("waived");
    expect(derivePaymentState(10000, 0, "complimentary")).toBe(
      "complimentary",
    );
    // Even if money also arrived, the deliberate resolution is the truth.
    expect(derivePaymentState(10000, 10000, "waived")).toBe("waived");
  });

  test("no assessment is 'no-fee', not 'paid'", () => {
    expect(derivePaymentState(0, 0, null)).toBe("no-fee");
    // Even with money recorded, a zero assessment had no obligation —
    // 'no-fee' describes the assessment, the ledger keeps the payment.
    expect(derivePaymentState(0, 500, null)).toBe("no-fee");
  });

  test("partial coverage is 'partial', full coverage 'paid'", () => {
    expect(derivePaymentState(10000, 0, null)).toBe("unpaid");
    expect(derivePaymentState(10000, 5000, null)).toBe("partial");
    expect(derivePaymentState(10000, 10000, null)).toBe("paid");
    // Overpayment reports paid — the ledger keeps the overage detail.
    expect(derivePaymentState(10000, 15000, null)).toBe("paid");
  });
});
