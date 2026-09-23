"use server";

// Server actions for the per-animal medical record (#173). Every action
// self-authorizes via requireAdmin — veterinary data is staff-only and
// must never leak into public surfaces.

import { requireAdmin } from "@/lib/auth";
import { getAdminAnimal, type AdminAnimal } from "@/lib/registry/animals";
import {
  createVaccination,
  listVaccinationsForAnimal,
  updateVaccination,
  type AdminVaccination,
  type VaccinationWriteInput,
} from "@/lib/registry/vaccinations";
import { logError } from "@/lib/logger";

export interface AnimalMedicalRecord {
  animal: AdminAnimal;
  vaccinations: AdminVaccination[];
}

// One round-trip for the detail page: animal header + vaccination
// history. Returns null when the animal does not exist — the page
// renders a not-found state rather than an error.
export async function getAnimalMedicalAction(
  registryId: string,
): Promise<AnimalMedicalRecord | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const animal = await getAdminAnimal(registryId);
  if (!animal) return null;
  const vaccinationList = await listVaccinationsForAnimal(animal.id);
  return { animal, vaccinations: vaccinationList };
}

export interface SaveVaccinationResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict";
  field?: string;
}

export async function saveVaccinationAction(
  input: VaccinationWriteInput,
  vaccinationId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveVaccinationResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const actor = user?.email ?? "unknown";

  try {
    const result = vaccinationId
      ? await updateVaccination(
          vaccinationId,
          input,
          expectedUpdatedAt ?? "",
          actor,
        )
      : await createVaccination(input, actor);
    if (result.ok) return { ok: true };
    return {
      ok: false,
      reason: result.reason,
      ...("field" in result ? { field: result.field } : {}),
    };
  } catch (error) {
    logError("vaccinations", "admin-save", error);
    return { ok: false };
  }
}
