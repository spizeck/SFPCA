// Pure vaccination domain rules (#173): ISO date validation, the
// effective next-relevant date, and the derived due-state. No DB — the
// rules in src/lib/vaccinations.ts are shared by the service, the admin
// UI, and these tests.

import { describe, test, expect } from "vitest";
import {
  addDaysToIsoDate,
  effectiveVaccinationDate,
  isIsoDateString,
  todayIsoDate,
  vaccinationDueState,
  VACCINATION_DUE_SOON_DAYS,
} from "@/lib/vaccinations";
import {
  validateVaccinationInput,
  vaccinationReminderKey,
} from "@/lib/registry/vaccinations";

const TODAY = "2026-09-23";

const VALID_INPUT = {
  animalId: "11111111-2222-4333-8444-555555555555",
  vaccineName: "Rabies",
  administeredOn: "2026-09-01",
};

describe("isIsoDateString", () => {
  test("accepts real dates and rejects impossible/malformed ones", () => {
    expect(isIsoDateString("2026-02-28")).toBe(true);
    expect(isIsoDateString("2024-02-29")).toBe(true); // leap year
    expect(isIsoDateString("2026-02-29")).toBe(false); // not a leap year
    expect(isIsoDateString("2026-02-30")).toBe(false);
    expect(isIsoDateString("2026-13-01")).toBe(false);
    expect(isIsoDateString("09/23/2026")).toBe(false);
    expect(isIsoDateString("2026-9-3")).toBe(false);
    expect(isIsoDateString("")).toBe(false);
  });
});

describe("effectiveVaccinationDate", () => {
  test("is the earliest of due_on and valid_until", () => {
    expect(effectiveVaccinationDate("2026-10-01", "2027-01-01")).toBe(
      "2026-10-01",
    );
    // Expiry earlier than the recommended booster still wins — whichever
    // date comes first is what needs attention.
    expect(effectiveVaccinationDate("2027-01-01", "2026-10-01")).toBe(
      "2026-10-01",
    );
    expect(effectiveVaccinationDate("2026-10-01", null)).toBe("2026-10-01");
    expect(effectiveVaccinationDate(null, "2026-10-01")).toBe("2026-10-01");
    expect(effectiveVaccinationDate(null, null)).toBeNull();
  });
});

describe("vaccinationDueState", () => {
  test("derives state from the effective date relative to today", () => {
    expect(vaccinationDueState(null, TODAY)).toBe("unscheduled");
    expect(vaccinationDueState("2026-09-22", TODAY)).toBe("overdue");
    // Due today is actionable now, not overdue.
    expect(vaccinationDueState(TODAY, TODAY)).toBe("due-soon");
    // The window edge is inclusive.
    expect(
      vaccinationDueState(
        addDaysToIsoDate(TODAY, VACCINATION_DUE_SOON_DAYS),
        TODAY,
      ),
    ).toBe("due-soon");
    expect(
      vaccinationDueState(
        addDaysToIsoDate(TODAY, VACCINATION_DUE_SOON_DAYS + 1),
        TODAY,
      ),
    ).toBe("current");
  });
});

describe("validateVaccinationInput", () => {
  const at = (input: Record<string, unknown>, today = TODAY) =>
    validateVaccinationInput(
      { ...VALID_INPUT, ...input } as never,
      today,
    );

  test("accepts a minimal and a complete record", () => {
    expect(at({})).toBeNull();
    expect(
      at({
        dueOn: "2027-09-01",
        validUntil: "2027-09-01",
        productName: "Nobivac Rabies",
        manufacturer: "MSD",
        lotNumber: "A123B",
        administeredBy: "Dr. Smith",
        notes: "no reaction",
        documentPath:
          "vet-docs/11111111-2222-4333-8444-555555555555.pdf",
      }),
    ).toBeNull();
  });

  test("requires a real animal, vaccine name, and administered date", () => {
    expect(at({ animalId: "not-a-uuid" })).toBe("animalId");
    expect(at({ vaccineName: "  " })).toBe("vaccineName");
    expect(at({ administeredOn: "" })).toBe("administeredOn");
    expect(at({ administeredOn: "Sept 1" })).toBe("administeredOn");
  });

  test("a future administered date is rejected as a likely typo", () => {
    expect(at({ administeredOn: "2999-01-01" })).toBe("administeredOn");
    // Administered today is fine.
    expect(at({ administeredOn: TODAY })).toBeNull();
  });

  test("due/valid dates must be on or after the administered date", () => {
    expect(at({ dueOn: "2026-08-31" })).toBe("dueOn");
    expect(at({ validUntil: "2026-08-31" })).toBe("validUntil");
    expect(at({ dueOn: "2026-09-01" })).toBeNull(); // same-day allowed
    expect(at({ dueOn: "not-a-date" })).toBe("dueOn");
  });

  test("caps free-text fields and constrains document paths", () => {
    expect(at({ notes: "x".repeat(2001) })).toBe("notes");
    expect(at({ administeredBy: "x".repeat(201) })).toBe("administeredBy");
    expect(at({ documentPath: "../../etc/passwd" })).toBe("documentPath");
    expect(at({ documentPath: "receipts/abc" })).toBe("documentPath");
  });
});

describe("vaccinationReminderKey", () => {
  test("is deterministic per vaccination + due date + touch", () => {
    const k1 = vaccinationReminderKey("vax-1", "2026-10-01", "due-30d");
    const k2 = vaccinationReminderKey("vax-1", "2026-10-01", "due-30d");
    expect(k1).toBe(k2);
    // A different touch (second notice) is a different key.
    expect(vaccinationReminderKey("vax-1", "2026-10-01", "due-7d")).not.toBe(
      k1,
    );
    // A new due date (next booster cycle) is a different key.
    expect(vaccinationReminderKey("vax-1", "2027-10-01", "due-30d")).not.toBe(
      k1,
    );
    expect(k1).toContain("vax-1");
  });
});
