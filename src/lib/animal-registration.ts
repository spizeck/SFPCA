// Canonical definition of the animal-registration submission lifecycle
// and its field constraints. This module is the single authoritative
// source for registration status semantics, the field limits that the
// public form and the Firestore rules both enforce, the fee schedule
// the form advertises, and receipt-file constraints that mirror
// storage.rules. Keep the two rule files and this module in agreement.
//
// Submission lifecycle contract:
//
// | Status   | Meaning                                    | Visible to |
// |----------|--------------------------------------------|------------|
// | pending  | Submitted, awaiting staff verification     | admins only|
// | approved | Staff verified the registration/payment    | admins only|
// | rejected | Staff declined the submission              | admins only|
// | <unknown>| Malformed or unrecognized status value     | admins only|
// |          | (surfaced as needing attention)            |            |
//
// No registration data is ever publicly readable. Public clients may
// only CREATE submissions, and only with status "pending" — the rules
// layer rejects any other initial status. Admin status changes may move
// between any supported statuses so staff can correct mistakes; no
// state is terminal.
//
// Retention: the repository defines no automatic retention period.
// Registrations persist indefinitely unless an admin deletes a document
// through a privileged path; there is no UI delete today.

export const REGISTRATION_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  pending: "Pending",
  approved: "Verified",
  rejected: "Rejected",
};

// The only status a public submission may carry. Rules enforce this.
export const REGISTRATION_INITIAL_STATUS: RegistrationStatus = "pending";

export function isRegistrationStatus(
  value: unknown,
): value is RegistrationStatus {
  return (
    typeof value === "string" &&
    (REGISTRATION_STATUSES as readonly string[]).includes(value)
  );
}

export function getRegistrationStatusLabel(status: unknown): string {
  return isRegistrationStatus(status)
    ? REGISTRATION_STATUS_LABELS[status]
    : "Unknown";
}

// Admin transitions between supported statuses are unrestricted — the
// lifecycle is intentionally simple and nothing is terminal. Transitions
// to or from unrecognized values are rejected.
export function canTransitionRegistrationStatus(
  from: unknown,
  to: unknown,
): boolean {
  return isRegistrationStatus(from) && isRegistrationStatus(to);
}

// --- Field constraints (mirrored in firestore.rules) ------------------
// These bound what a public submission may carry. The public form sets
// matching maxLength attributes so browser validation agrees with the
// trusted boundary.

export const REGISTRATION_FIELD_LIMITS = {
  ownerName: 120,
  ownerAddress: 500,
  ownerPhone: 40,
  ownerEmail: 320,
  animalName: 100,
  animalType: 100,
  maxAnimals: 25,
  maxTotalFee: 25_000,
} as const;

// --- Fee schedule ------------------------------------------------------
// The public form quotes registration fees from these constants. Fees
// are business logic, not CMS content — the admin page-content editor
// (`animalRegistration/main`, src/lib/page-content.ts) deliberately has
// no fee fields, and staff verify actual payment during review, so a
// tampered client-computed totalFee grants nothing.

export const REGISTRATION_FEE_FIXED = 10;
export const REGISTRATION_FEE_NOT_FIXED = 100;

export interface RegistrationAnimalInput {
  name: string;
  type: string;
  sex: string;
  isFixed: string;
}

export function calculateRegistrationFee(
  animals: Pick<RegistrationAnimalInput, "isFixed">[],
): number {
  return animals.reduce(
    (total, animal) =>
      total +
      (animal.isFixed === "yes"
        ? REGISTRATION_FEE_FIXED
        : REGISTRATION_FEE_NOT_FIXED),
    0,
  );
}

// --- Receipt file constraints (mirrored in storage.rules) --------------

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_CONTENT_TYPES = ["image/", "application/pdf"] as const;

// Client-side mirror of the storage-rule receipt check so a bad file is
// caught before any upload is attempted.
export function isReceiptFile(file: { type: string; size: number }): boolean {
  if (file.size > RECEIPT_MAX_BYTES || file.size <= 0) return false;
  return RECEIPT_CONTENT_TYPES.some(
    (type) => file.type === type || file.type.startsWith(type),
  );
}

// --- Submission shape validation ----------------------------------------
// Client-side validation for the public form. Firestore rules repeat the
// security-relevant checks; this exists to give users immediate,
// field-level feedback rather than a round-trip failure.

export interface RegistrationFormInput {
  ownerName: string;
  ownerAddress: string;
  ownerPhone: string;
  ownerEmail: string;
  animals: RegistrationAnimalInput[];
}

export type RegistrationFieldErrors = Partial<
  Record<"owner" | "animals", string>
>;

// --- Timestamp handling --------------------------------------------------
// Submissions store Firestore server timestamps; some historical code
// paths wrote ISO strings. These helpers normalize both shapes so the
// admin view can display and sort defensively instead of crashing on a
// Timestamp object or dropping records that lack the field entirely.

interface TimestampLike {
  toDate: () => Date;
}

function isTimestampLike(value: unknown): value is TimestampLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TimestampLike).toDate === "function"
  );
}

// Milliseconds since epoch; returns 0 for missing/unparseable values so
// malformed records sort last rather than disappearing from admin views.
export function registrationTimestampMillis(value: unknown): number {
  if (isTimestampLike(value)) return value.toDate().getTime();
  const parsed = new Date(String(value ?? "")).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatRegistrationTimestamp(value: unknown): string {
  const millis = registrationTimestampMillis(value);
  return millis === 0 ? "—" : new Date(millis).toLocaleString();
}

// Returns an error map; empty means the submission is well-formed. Checks
// only structural constraints — semantics (real email deliverability,
// real phone numbers) are staff's job during verification.
export function validateRegistration(
  input: RegistrationFormInput,
): RegistrationFieldErrors {
  const errors: RegistrationFieldErrors = {};
  const limits = REGISTRATION_FIELD_LIMITS;

  const ownerInvalid =
    !input.ownerName.trim() ||
    input.ownerName.length > limits.ownerName ||
    !input.ownerAddress.trim() ||
    input.ownerAddress.length > limits.ownerAddress ||
    !input.ownerPhone.trim() ||
    input.ownerPhone.length > limits.ownerPhone ||
    !input.ownerEmail.trim() ||
    input.ownerEmail.length > limits.ownerEmail;
  if (ownerInvalid) {
    errors.owner = "Check the owner name, address, phone, and email fields.";
  }

  const animalsInvalid =
    input.animals.length === 0 ||
    input.animals.length > limits.maxAnimals ||
    input.animals.some(
      (a) =>
        !a.name.trim() ||
        a.name.length > limits.animalName ||
        !a.type.trim() ||
        a.type.length > limits.animalType ||
        !["male", "female"].includes(a.sex) ||
        !["yes", "no"].includes(a.isFixed),
    );
  if (animalsInvalid) {
    errors.animals =
      "Each animal needs a name, type, sex, and spay/neuter answer.";
  }

  return errors;
}
