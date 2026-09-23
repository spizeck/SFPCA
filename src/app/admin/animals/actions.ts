"use server";

// Server actions for the admin animal manager (#183). Every action
// self-authorizes via requireAdmin — Postgres is the only datastore
// these touch; Firestore is no longer involved in animal records.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  createAnimal,
  deleteAnimal,
  listAdminAnimals,
  updateAnimal,
  type AdminAnimal,
  type AnimalWriteInput,
} from "@/lib/registry/animals";
import type { Animal } from "@/lib/types";
import type { AnimalStatus } from "@/lib/animal-lifecycle";
import { logError } from "@/lib/logger";

function toAnimal(dto: AdminAnimal): Animal {
  return {
    id: dto.legacyId ?? dto.id,
    name: dto.name,
    species: dto.species as Animal["species"],
    sex: dto.sex as Animal["sex"],
    approxAge: dto.approxAge ?? "",
    description: dto.description ?? "",
    status: dto.lifecycleStatus as AnimalStatus,
    photos: dto.photoUrls,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

// The admin table keys edits by the registry uuid, not the public-facing
// id — a legacy-id row must still be updatable by its Postgres identity.
// We keep both on a private mapping type so the mutation inputs carry
// the uuid while the UI keeps displaying the Animal shape.
export interface AdminAnimalRow extends Animal {
  registryId: string;
}

function toAdminAnimal(dto: AdminAnimal): AdminAnimalRow {
  return { ...toAnimal(dto), registryId: dto.id };
}

export async function listAnimalsAction(): Promise<AdminAnimalRow[]> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return (await listAdminAnimals()).map(toAdminAnimal);
}

export interface SaveAnimalResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict";
}

export async function saveAnimalAction(
  input: AnimalWriteInput,
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
      // status change shows up without waiting for a redeploy. The
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
