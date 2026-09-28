// Orphan clinical-document sweeper (#192). Same shape as the receipt
// sweeper: an upload that never got its vet_documents row (action
// failure, abandoned dialog, lost response) is deleted once it is old
// enough to classify; objects referenced by a row are never touched.
// Runs inside the existing /api/cron/sweep-receipts storage-hygiene
// pass — one daily sweep, two prefixes.
//
// Privacy rules unchanged: object names are never logged. Only counts
// and error codes leave this module.

import "server-only";

import { vetDocumentPathExists } from "./medical";
import type { RegistryDb } from "./public-animals";
import {
  ORPHAN_GRACE_MS,
  type SweepBucket,
  type SweepCounts,
} from "./receipt-sweep";

const VET_DOC_PREFIX = "vet-docs/";

interface SweepLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

export async function sweepOrphanedVetDocuments({
  bucket,
  db,
  nowMs = Date.now(),
  graceMs = ORPHAN_GRACE_MS,
  log = console,
  runId,
}: {
  bucket: SweepBucket;
  db: RegistryDb;
  nowMs?: number;
  graceMs?: number;
  log?: SweepLogger;
  runId?: string;
}): Promise<SweepCounts> {
  const base = {
    subsystem: "vet-doc-cleanup",
    operation: "sweep",
    runId,
  };
  const cutoff = nowMs - graceMs;
  const [files] = await bucket.getFiles({ prefix: VET_DOC_PREFIX });

  const counts: SweepCounts = {
    scanned: 0,
    deleted: 0,
    skippedRecent: 0,
    skippedMalformed: 0,
    failed: 0,
  };

  for (const file of files) {
    const objectName = file.name.slice(VET_DOC_PREFIX.length);
    if (
      !file.name.startsWith(VET_DOC_PREFIX) ||
      !objectName ||
      objectName.includes("/")
    ) {
      // Unexpected object shape inside the vet-docs/ prefix — leave it
      // for a human rather than guessing.
      counts.skippedMalformed++;
      continue;
    }
    counts.scanned++;

    // Skip objects too new to classify — and any whose age cannot be
    // determined (never delete what we can't date). An upload whose
    // registration call is still in flight must survive the sweep.
    const created = Date.parse(file.metadata?.timeCreated || "");
    if (!created || created > cutoff) {
      counts.skippedRecent++;
      continue;
    }

    // One bad object must not abort the whole sweep: account for the
    // failure, keep going, and let the caller mark the run failed.
    try {
      if (!(await vetDocumentPathExists(file.name, db))) {
        await file.delete();
        counts.deleted++;
      }
    } catch (error) {
      counts.failed++;
      log.warn({
        ...base,
        outcome: "object-failed",
        errorCode:
          typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code
            : ((error as { name?: string })?.name ?? "unknown"),
      });
    }
  }

  const summary = { ...base, ...counts };
  if (counts.failed > 0) {
    // Error-level so log-based alerting catches a partially failed
    // sweep; the caller rethrows to mark the execution failed.
    log.error({ ...summary, outcome: "partial-failure" });
  } else {
    log.info({ ...summary, outcome: "ok" });
  }
  return counts;
}
