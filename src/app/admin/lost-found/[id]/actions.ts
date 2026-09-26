"use server";

// Server actions for one lost/found case (#176). Every action
// self-authorizes via requireAdmin — the case carries private reporter
// and owner contact details.

import { requireAdmin } from "@/lib/auth";
import {
  addCaseUpdate,
  cancelCase,
  getCaseDetail,
  linkCaseToAnimal,
  publishCase,
  reopenCase,
  resolveCase,
  unpublishCase,
  type LostFoundCaseDetail,
} from "@/lib/registry/lost-found";
import type {
  LostFoundOutcome,
  LostFoundUpdateKind,
} from "@/lib/lost-found";
import { searchAnimals } from "@/lib/registry/animals";
import { logError } from "@/lib/logger";

export async function getCaseDetailAction(
  caseId: string,
): Promise<LostFoundCaseDetail | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return getCaseDetail(caseId);
}

// Light-weight picker results for "link this found case to an animal" —
// the same canonical registry search the animals list uses.
export interface LinkCandidate {
  id: string;
  name: string;
  registryRef: string;
  species: string;
  sex: string;
  lifecycleStatus: string;
  owners: string[];
  microchips: string[];
}

export async function searchLinkCandidatesAction(
  query: string,
): Promise<LinkCandidate[]> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const hits = await searchAnimals(query, {});
  return hits.slice(0, 10).map((h) => ({
    id: h.animal.id,
    name: h.animal.name,
    registryRef: h.animal.registryRef,
    species: h.animal.species,
    sex: h.animal.sex,
    lifecycleStatus: h.animal.lifecycleStatus,
    owners: h.owners,
    microchips: h.microchips,
  }));
}

export interface CaseActionResult {
  ok: boolean;
  reason?:
    | "invalid"
    | "not-found"
    | "conflict"
    | "not-open"
    | "not-unmatched"
    | "has-open-case";
  field?: string;
}

type MutationOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not-found"
        | "conflict"
        | "invalid"
        | "not-open"
        | "not-unmatched"
        | "has-open-case";
      field?: string;
    };

function toResult(result: MutationOutcome): CaseActionResult {
  if (result.ok) return { ok: true };
  return {
    ok: false,
    reason: result.reason,
    ...("field" in result ? { field: result.field } : {}),
  };
}

async function save(
  run: (actor: string) => Promise<MutationOutcome>,
): Promise<CaseActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    return toResult(await run(user?.email ?? "unknown"));
  } catch (error) {
    logError("lost-found", "admin-save", error);
    return { ok: false };
  }
}

export async function addCaseUpdateAction(
  caseId: string,
  input: {
    kind: LostFoundUpdateKind;
    occurredAt?: string | null;
    location?: string | null;
    note?: string | null;
    reporterName?: string | null;
    reporterContact?: string | null;
  },
): Promise<CaseActionResult> {
  return save(async (actor) => {
    const result = await addCaseUpdate(
      caseId,
      { ...input, source: "staff" },
      actor,
    );
    return result.ok ? { ok: true } : result;
  });
}

export async function linkCaseToAnimalAction(
  caseId: string,
  animalId: string,
): Promise<CaseActionResult> {
  return save((actor) => linkCaseToAnimal(caseId, animalId, actor));
}

export async function resolveCaseAction(
  caseId: string,
  input: {
    outcome: LostFoundOutcome;
    resolutionNote?: string | null;
    deceasedEffectiveOn?: string | null;
  },
): Promise<CaseActionResult> {
  return save((actor) => resolveCase(caseId, input, actor));
}

export async function cancelCaseAction(
  caseId: string,
  input: { note?: string | null },
): Promise<CaseActionResult> {
  return save((actor) => cancelCase(caseId, input, actor));
}

export async function reopenCaseAction(
  caseId: string,
): Promise<CaseActionResult> {
  return save((actor) => reopenCase(caseId, actor));
}

export async function publishCaseAction(
  caseId: string,
  input: { publicNote?: string | null },
): Promise<CaseActionResult> {
  return save((actor) => publishCase(caseId, input, actor));
}

export async function unpublishCaseAction(
  caseId: string,
): Promise<CaseActionResult> {
  return save((actor) => unpublishCase(caseId, actor));
}
