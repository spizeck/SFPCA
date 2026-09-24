"use server";

// Server actions for the per-animal medical record (#173, grown into
// the full continuity record in #174). Every action self-authorizes via
// requireAdmin — veterinary data is staff-only and must never leak into
// public surfaces.

import { requireAdmin } from "@/lib/auth";
import { getAdminAnimal, type AdminAnimal } from "@/lib/registry/animals";
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
  listMedicalTimeline,
  listOpenFollowUps,
  updateAlert,
  updateEncounter,
  updateMedication,
  updateProcedure,
  updateWeightRecord,
  type AdminFollowUp,
  type AlertWriteInput,
  type EncounterWriteInput,
  type MedicalTimelineItem,
  type MedicationWriteInput,
  type ProcedureWriteInput,
  type WeightWriteInput,
} from "@/lib/registry/medical";
import { logError, type LogSubsystem } from "@/lib/logger";

export interface AnimalMedicalRecord {
  animal: AdminAnimal;
  // Unified chronological feed — encounters, vaccinations, procedures,
  // medications, weights, alert recordings (newest first).
  timeline: MedicalTimelineItem[];
  // Open rechecks/follow-ups for this animal — the #175 seam rendered
  // as actionable "needs attention" context, not history.
  openFollowUps: AdminFollowUp[];
}

// One round-trip for the detail page: animal header + timeline +
// open follow-ups. Returns null when the animal does not exist — the
// page renders a not-found state rather than an error.
export async function getAnimalMedicalAction(
  registryId: string,
): Promise<AnimalMedicalRecord | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const animal = await getAdminAnimal(registryId);
  if (!animal) return null;
  const [timeline, openFollowUps] = await Promise.all([
    listMedicalTimeline(animal.id),
    listOpenFollowUps(animal.id),
  ]);
  return { animal, timeline, openFollowUps };
}

export interface SaveResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict";
  field?: string;
}

// Both service result shapes narrow to this — the action layer only
// needs the failure metadata.
type MutationOutcome =
  | { ok: true }
  | { ok: false; reason: "not-found" | "conflict" | "invalid"; field?: string };

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
