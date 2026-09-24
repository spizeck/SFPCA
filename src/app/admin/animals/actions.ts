"use server";

// Server actions for the admin animal registry (#183, #167). Every
// action self-authorizes via requireAdmin — Postgres is the only
// datastore these touch; Firestore is no longer involved in animal
// records.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  createAnimal,
  deleteAnimal,
  searchAnimals,
  updateAnimal,
  type AdminAnimal,
  type AnimalSearchFilters,
  type AnimalWriteInput,
} from "@/lib/registry/animals";
import { logError } from "@/lib/logger";

// One row of the staff registry list: the admin animal DTO plus the
// search-hit context (current owners, active chips) the list renders.
export interface AdminAnimalRow {
  animal: AdminAnimal;
  owners: string[];
  microchips: string[];
}

// Staff search — one text box matching name, registry ref, uuid, legacy
// id, identifying notes, owner/household name, and microchip number;
// lifecycle and adoption filters narrow it. Bounded server-side.
export async function searchAnimalsAction(
  query: string,
  filters: AnimalSearchFilters,
): Promise<AdminAnimalRow[]> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return (await searchAnimals(query, filters)).map((hit) => ({
    animal: hit.animal,
    owners: hit.owners,
    microchips: hit.microchips,
  }));
}

export interface SaveAnimalResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict";
}

export interface SaveAnimalInput extends AnimalWriteInput {
  // Create-only: the animal's initial registry lifecycle. Defaults to
  // 'active'; ignored on update (lifecycle changes only through
  // transitionAnimalLifecycleAction so history is always preserved).
  lifecycleStatus?: string;
}

export async function saveAnimalAction(
  input: SaveAnimalInput,
  editingRegistryId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveAnimalResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const actor = user?.email ?? "unknown";

  try {
    const result = editingRegistryId
      ? await updateAnimal(
          editingRegistryId,
          input,
          expectedUpdatedAt ?? "",
          actor,
        )
      : await createAnimal(input, actor);
    if (result.ok) {
      // The homepage preview is statically rendered — bust it so a
      // listing change shows up without waiting for a redeploy. The
      // listing/detail pages are force-dynamic already.
      revalidatePath("/");
      return { ok: true };
    }
    return { ok: false, reason: result.reason };
  } catch (error) {
    logError("animals", "admin-save", error);
    return { ok: false };
  }
}

export async function deleteAnimalAction(
  registryId: string,
): Promise<SaveAnimalResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");

  try {
    const result = await deleteAnimal(registryId, user?.email ?? "unknown");
    if (result.ok) {
      revalidatePath("/");
      return { ok: true };
    }
    return { ok: false, reason: result.reason };
  } catch (error) {
    logError("animals", "admin-delete", error);
    return { ok: false };
  }
}
