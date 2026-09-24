"use server";

// Server actions for the per-animal medical record (#173, grown into
// the full continuity record in #174). Every action self-authorizes via
// requireAdmin — veterinary data is staff-only and must never leak into
// public surfaces.

import { requireAdmin } from "@/lib/auth";
import {
  getAdminAnimal,
  getAnimalRegistryContext,
  getAnimalSterilization,
  listLifecycleHistory,
  transitionAnimalLifecycle,
  type AdminAnimal,
  type AnimalLifecycleEventDto,
  type AnimalRegistryContext,
  type AnimalSterilization,
} from "@/lib/registry/animals";
import {
  createVaccination,
  updateVaccination,
  type VaccinationWriteInput,
} from "@/lib/registry/vaccinations";
import {
  createAlert,
  createEncounter,
  createMedication,
  createProcedure,
  createWeightRecord,
  listClinicExpectationsForAnimal,
  listFollowUpsForAnimal,
  listMedicalTimeline,
  updateAlert,
  updateEncounter,
  updateMedication,
  updateProcedure,
  updateWeightRecord,
  type AdminClinicExpectation,
  type AdminFollowUp,
  type AlertWriteInput,
  type EncounterWriteInput,
  type MedicalTimelineItem,
  type MedicationWriteInput,
  type ProcedureWriteInput,
  type WeightWriteInput,
} from "@/lib/registry/medical";
import {
  listCommunicationsForAnimal,
  type AdminCommunication,
} from "@/lib/registry/communications";
import {
  closeOwnership,
  correctOwnership,
  createOwnership,
  listConfirmationsForAnimal,
  listOwnershipHistory,
  recordOwnershipConfirmation,
  transferOwnership,
  type OwnershipConfirmation,
  type OwnershipRecord,
  type OwnershipWriteInput,
} from "@/lib/registry/ownership";
import {
  listHouseholds,
  listPersons,
  type HouseholdRecord,
  type PersonRecord,
} from "@/lib/registry/persons";
import { logError, type LogSubsystem } from "@/lib/logger";

export interface AnimalMedicalRecord {
  animal: AdminAnimal;
  // Unified chronological feed — encounters, vaccinations, procedures,
  // medications, weights, alert recordings (newest first).
  timeline: MedicalTimelineItem[];
  // All follow-ups for this animal — open items first, then resolved
  // history (#175). The page partitions them; resolved rows render as
  // completion history, never as actionable items.
  followUps: AdminFollowUp[];
  // Expected clinic attendances — live items first, then resolved
  // history (#194). Same partition rule as follow-ups.
  clinicExpectations: AdminClinicExpectation[];
  // Communication history about this animal (#172) — reminder sends,
  // skips, and failures, newest first.
  communications: AdminCommunication[];
  // Full ownership history (#166) — every interval, open and closed,
  // newest first. History is never rewritten; this is the audit view.
  ownerships: OwnershipRecord[];
  // Deliberate annual-confirmation events for this animal (#166).
  confirmations: OwnershipConfirmation[];
  // Lifecycle transition history (#167) — immutable domain history,
  // newest first (from_status NULL = "entered the registry").
  lifecycleHistory: AnimalLifecycleEventDto[];
  // Sterilization fact + the spay/neuter procedure evidence behind it.
  sterilization: AnimalSterilization;
  // Cross-domain registry context (#167): microchips, registrations,
  // payments, documents, audit trail — read-only projections owned by
  // other domains.
  registry: AnimalRegistryContext;
  // Picker data for the ownership panel.
  persons: PersonRecord[];
  households: HouseholdRecord[];
}

// One round-trip for the detail page: animal header + timeline +
// follow-ups. Returns null when the animal does not exist — the
// page renders a not-found state rather than an error.
export async function getAnimalMedicalAction(
  registryId: string,
): Promise<AnimalMedicalRecord | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const animal = await getAdminAnimal(registryId);
  if (!animal) return null;
  const [
    timeline,
    followUps,
    clinicExpectations,
    communications,
    ownerships,
    confirmations,
    lifecycleHistory,
    sterilization,
    registry,
    persons,
    households,
  ] = await Promise.all([
    listMedicalTimeline(animal.id),
    listFollowUpsForAnimal(animal.id),
    listClinicExpectationsForAnimal(animal.id),
    listCommunicationsForAnimal(animal.id),
    listOwnershipHistory(animal.id),
    listConfirmationsForAnimal(animal.id),
    listLifecycleHistory(animal.id),
    getAnimalSterilization(animal.id),
    getAnimalRegistryContext(animal.id),
    listPersons(),
    listHouseholds(),
  ]);
  return {
    animal,
    timeline,
    followUps,
    clinicExpectations,
    communications,
    ownerships,
    confirmations,
    lifecycleHistory,
    sterilization: sterilization ?? {
      status: animal.sterilizationStatus,
      sterilizedOn: animal.sterilizedOn,
      sterilizedBy: animal.sterilizedBy,
      evidence: [],
    },
    registry: registry ?? {
      microchips: [],
      registrations: [],
      payments: [],
      documents: [],
      auditTrail: [],
    },
    persons,
    households,
  };
}

// The staff-side lifecycle transition (#167). Goes through the canonical
// service so the status flip, the lifecycle-history row, ownership
// closures, and the audit row commit together.
export async function transitionLifecycleAction(
  animalId: string,
  toStatus: string,
  effectiveOn?: string | null,
  reason?: string | null,
): Promise<SaveResult> {
  return save("animals", (actor) =>
    transitionAnimalLifecycle(animalId, {
      toStatus,
      effectiveOn: effectiveOn ?? undefined,
      reason,
      source: "staff",
      actorLabel: actor,
    }),
  );
}

export interface SaveResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict" | "overlap" | "not-owner" | "not-current";
  field?: string;
}

// Both service result shapes narrow to this — the action layer only
// needs the failure metadata.
type MutationOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not-found"
        | "conflict"
        | "invalid"
        | "overlap"
        | "not-owner"
        | "not-current";
      field?: string;
    };

function toSaveResult(result: MutationOutcome): SaveResult {
  if (result.ok) return { ok: true };
  return {
    ok: false,
    reason: result.reason,
    ...("field" in result ? { field: result.field } : {}),
  };
}

// Runs a create-or-update save under a single logged boundary so every
// action reports failures identically.
async function save(
  subsystem: LogSubsystem,
  run: (actor: string) => Promise<MutationOutcome>,
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    return toSaveResult(await run(user?.email ?? "unknown"));
  } catch (error) {
    logError(subsystem, "admin-save", error);
    return { ok: false };
  }
}

export async function saveVaccinationAction(
  input: VaccinationWriteInput,
  vaccinationId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  return save("vaccinations", (actor) =>
    vaccinationId
      ? updateVaccination(vaccinationId, input, expectedUpdatedAt ?? "", actor)
      : createVaccination(input, actor),
  );
}

export async function saveEncounterAction(
  input: EncounterWriteInput,
  encounterId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    encounterId
      ? updateEncounter(encounterId, input, expectedUpdatedAt ?? "", actor)
      : createEncounter(input, actor),
  );
}

export async function saveProcedureAction(
  input: ProcedureWriteInput,
  procedureId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    procedureId
      ? updateProcedure(procedureId, input, expectedUpdatedAt ?? "", actor)
      : createProcedure(input, actor),
  );
}

export async function saveMedicationAction(
  input: MedicationWriteInput,
  medicationId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    medicationId
      ? updateMedication(medicationId, input, expectedUpdatedAt ?? "", actor)
      : createMedication(input, actor),
  );
}

export async function saveAlertAction(
  input: AlertWriteInput,
  alertId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    alertId
      ? updateAlert(alertId, input, expectedUpdatedAt ?? "", actor)
      : createAlert(input, actor),
  );
}

export async function saveWeightAction(
  input: WeightWriteInput,
  weightId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    weightId
      ? updateWeightRecord(weightId, input, expectedUpdatedAt ?? "", actor)
      : createWeightRecord(input, actor),
  );
}

// --- Ownership (#166) -------------------------------------------------------------

export async function saveOwnershipAction(
  input: OwnershipWriteInput,
): Promise<SaveResult> {
  return save("owners", async (actor) => {
    const result = await createOwnership(input, actor);
    return result.ok ? { ok: true } : result;
  });
}

export async function closeOwnershipAction(
  ownershipId: string,
  validTo: string,
): Promise<SaveResult> {
  return save("owners", async (actor) => {
    const result = await closeOwnership(ownershipId, validTo, actor);
    return result.ok ? { ok: true } : result;
  });
}

export async function transferOwnershipAction(
  ownershipId: string,
  validTo: string,
  newOwner: { personId?: string | null; householdId?: string | null },
  note?: string | null,
): Promise<SaveResult> {
  return save("owners", async (actor) => {
    const result = await transferOwnership(
      { ownershipId, validTo, newOwner, note },
      actor,
    );
    return result.ok ? { ok: true } : result;
  });
}

export async function correctOwnershipAction(
  ownershipId: string,
  input: { validFrom: string; validTo?: string | null; note?: string | null },
  expectedCreatedAt: string,
): Promise<SaveResult> {
  return save("owners", async (actor) => {
    const result = await correctOwnership(
      ownershipId,
      input,
      expectedCreatedAt,
      actor,
    );
    return result.ok ? { ok: true } : result;
  });
}

// Staff-recorded confirmation — a phone call or in-person affirmation
// counts the same as a portal click; method:'staff' records who did it.
export async function recordOwnershipConfirmationAction(
  ownershipId: string,
  personId: string,
  notes?: string | null,
): Promise<SaveResult> {
  return save("owners", async (actor) => {
    const result = await recordOwnershipConfirmation({
      ownershipId,
      personId,
      method: "staff",
      actorLabel: actor,
      notes,
    });
    return result.ok ? { ok: true } : result;
  });
}
