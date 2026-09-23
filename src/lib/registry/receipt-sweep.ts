// Orphan-receipt sweeper (#183). Moved out of Firebase Functions: the
// authoritative existence check is now Postgres registration_submissions,
// which a Function could not reach without duplicating DB credentials
// into a second runtime. Runs as a Vercel cron route instead.
//
// Privacy rules unchanged: receipt object names ARE registration
// submission ids — they are never logged. Only counts and error codes
// leave this module.

import "server-only";

import { registrationSubmissionExists } from "./registrations";
import type { RegistryDb } from "./public-animals";

// Orphans younger than this are left alone: a receipt whose submission
// is still in flight (upload done, insert pending or retrying) must
// never be swept out from under it.
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const RECEIPT_PREFIX = "receipts/";

export interface SweepFile {
  name: string;
  metadata?: { timeCreated?: string };
  delete(): Promise<unknown>;
}

export interface SweepBucket {
  getFiles(
    options: { prefix: string },
  ): Promise<[SweepFile[], ...unknown[]]>;
}

export interface SweepCounts {
  scanned: number;
  deleted: number;
  skippedRecent: number;
  skippedMalformed: number;
  failed: number;
}

interface SweepLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

export async function sweepOrphanedReceipts({
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
    subsystem: "receipt-cleanup",
    operation: "sweep",
    runId,
  };
  const cutoff = nowMs - graceMs;
  const [files] = await bucket.getFiles({ prefix: RECEIPT_PREFIX });

  const counts: SweepCounts = {
    scanned: 0,
    deleted: 0,
    skippedRecent: 0,
    skippedMalformed: 0,
    failed: 0,
  };

  for (const file of files) {
    const submissionId = file.name.slice(RECEIPT_PREFIX.length);
    if (
      !file.name.startsWith(RECEIPT_PREFIX) ||
      !submissionId ||
      submissionId.includes("/")
    ) {
      // Unexpected object shape inside the receipts/ prefix — leave it
      // for a human rather than guessing.
      counts.skippedMalformed++;
      continue;
    }
    counts.scanned++;

    // Skip objects too new to classify — and any whose age cannot be
    // determined (never delete what we can't date).
    const created = Date.parse(file.metadata?.timeCreated || "");
    if (!created || created > cutoff) {
      counts.skippedRecent++;
      continue;
    }

    // One bad object must not abort the whole sweep: account for the
    // failure, keep going, and let the caller mark the run failed.
    try {
      if (!(await registrationSubmissionExists(submissionId, db))) {
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
