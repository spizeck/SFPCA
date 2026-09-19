// Unit tests for the canonical animal-registration module. These pin
// down the submission lifecycle contract (all data private, fixed
// initial status, no terminal state) and the validation rules that the
// public form and firestore.rules must agree on.
import { describe, expect, test } from "vitest";
import {
  REGISTRATION_STATUSES,
  REGISTRATION_STATUS_LABELS,
  REGISTRATION_INITIAL_STATUS,
  REGISTRATION_FIELD_LIMITS,
  REGISTRATION_FEE_FIXED,
  REGISTRATION_FEE_NOT_FIXED,
  RECEIPT_MAX_BYTES,
  calculateRegistrationFee,
  canTransitionRegistrationStatus,
  formatRegistrationTimestamp,
  getRegistrationStatusLabel,
  isReceiptFile,
  isRegistrationStatus,
  registrationTimestampMillis,
  validateRegistration,
} from "../src/lib/animal-registration";

describe("supported statuses", () => {
  test("the lifecycle is exactly pending/approved/rejected", () => {
    expect([...REGISTRATION_STATUSES]).toEqual([
      "pending",
      "approved",
      "rejected",
    ]);
  });

  test("the only initial status for public submissions is pending", () => {
    expect(REGISTRATION_INITIAL_STATUS).toBe("pending");
  });

  test("every supported status has a label; unknown values fail closed", () => {
    for (const status of REGISTRATION_STATUSES) {
      expect(getRegistrationStatusLabel(status)).toBe(
        REGISTRATION_STATUS_LABELS[status],
      );
    }
    expect(getRegistrationStatusLabel("archived")).toBe("Unknown");
    expect(getRegistrationStatusLabel(undefined)).toBe("Unknown");
  });

  test("isRegistrationStatus rejects malformed values", () => {
    expect(isRegistrationStatus("pending")).toBe(true);
    expect(isRegistrationStatus("approved")).toBe(true);
    expect(isRegistrationStatus("rejected")).toBe(true);
    expect(isRegistrationStatus("PENDING")).toBe(false);
    expect(isRegistrationStatus("")).toBe(false);
    expect(isRegistrationStatus(null)).toBe(false);
    expect(isRegistrationStatus(0)).toBe(false);
  });

  test("admin transitions between supported statuses; nothing is terminal", () => {
    for (const from of REGISTRATION_STATUSES) {
      for (const to of REGISTRATION_STATUSES) {
        expect(canTransitionRegistrationStatus(from, to)).toBe(true);
      }
    }
    expect(canTransitionRegistrationStatus("pending", "gone")).toBe(false);
    expect(canTransitionRegistrationStatus(undefined, "pending")).toBe(false);
  });
});

describe("fee calculation", () => {
  test("fixed animals cost the reduced fee, others the full fee", () => {
    expect(calculateRegistrationFee([])).toBe(0);
    expect(calculateRegistrationFee([{ isFixed: "yes" }])).toBe(
      REGISTRATION_FEE_FIXED,
    );
    expect(calculateRegistrationFee([{ isFixed: "no" }])).toBe(
      REGISTRATION_FEE_NOT_FIXED,
    );
    expect(
      calculateRegistrationFee([
        { isFixed: "yes" },
        { isFixed: "no" },
        { isFixed: "" },
      ]),
    ).toBe(REGISTRATION_FEE_FIXED + 2 * REGISTRATION_FEE_NOT_FIXED);
  });
});

describe("receipt file constraints", () => {
  const make = (type: string, size: number) => ({ type, size });

  test("images and PDFs under 5 MB are accepted", () => {
    expect(isReceiptFile(make("image/png", 1024))).toBe(true);
    expect(isReceiptFile(make("image/jpeg", RECEIPT_MAX_BYTES))).toBe(true);
    expect(isReceiptFile(make("application/pdf", 2048))).toBe(true);
  });

  test("other types, empty, and oversized files are rejected", () => {
    expect(isReceiptFile(make("text/html", 100))).toBe(false);
    expect(isReceiptFile(make("application/zip", 100))).toBe(false);
    expect(isReceiptFile(make("image/png", 0))).toBe(false);
    expect(isReceiptFile(make("image/png", RECEIPT_MAX_BYTES + 1))).toBe(
      false,
    );
  });
});

describe("submission validation", () => {
  const valid = {
    ownerName: "Jane Doe",
    ownerAddress: "Windwardside, Saba",
    ownerPhone: "+599 416 0000",
    ownerEmail: "jane@example.com",
    animals: [{ name: "Rex", type: "dog", sex: "male", isFixed: "yes" }],
  };

  test("a complete submission passes", () => {
    expect(validateRegistration(valid)).toEqual({});
  });

  test("blank owner fields are flagged", () => {
    expect(validateRegistration({ ...valid, ownerName: "  " }).owner).toBeTruthy();
    expect(validateRegistration({ ...valid, ownerEmail: "" }).owner).toBeTruthy();
  });

  test("over-limit owner fields are flagged", () => {
    expect(
      validateRegistration({
        ...valid,
        ownerName: "n".repeat(REGISTRATION_FIELD_LIMITS.ownerName + 1),
      }).owner,
    ).toBeTruthy();
  });

  test("empty or oversized animal lists are flagged", () => {
    expect(validateRegistration({ ...valid, animals: [] }).animals).toBeTruthy();
    expect(
      validateRegistration({
        ...valid,
        animals: Array(REGISTRATION_FIELD_LIMITS.maxAnimals + 1).fill(
          valid.animals[0],
        ),
      }).animals,
    ).toBeTruthy();
  });

  test("animals with missing fields or bad enum values are flagged", () => {
    const cases = [
      { name: " ", type: "dog", sex: "male", isFixed: "yes" },
      { name: "Rex", type: "", sex: "male", isFixed: "yes" },
      { name: "Rex", type: "dog", sex: "", isFixed: "yes" },
      { name: "Rex", type: "dog", sex: "other", isFixed: "yes" },
      { name: "Rex", type: "dog", sex: "male", isFixed: "maybe" },
    ];
    for (const animal of cases) {
      expect(
        validateRegistration({ ...valid, animals: [animal] }).animals,
      ).toBeTruthy();
    }
  });
});

describe("timestamp normalization", () => {
  test("Firestore Timestamp-like values resolve", () => {
    const ts = { toDate: () => new Date("2024-06-01T12:00:00Z") };
    expect(registrationTimestampMillis(ts)).toBe(
      new Date("2024-06-01T12:00:00Z").getTime(),
    );
    expect(formatRegistrationTimestamp(ts)).not.toBe("—");
  });

  test("ISO strings resolve; missing and garbage values sort last", () => {
    expect(registrationTimestampMillis("2024-06-01T12:00:00Z")).toBe(
      new Date("2024-06-01T12:00:00Z").getTime(),
    );
    expect(registrationTimestampMillis(undefined)).toBe(0);
    expect(registrationTimestampMillis("not a date")).toBe(0);
    expect(formatRegistrationTimestamp(undefined)).toBe("—");
  });
});
