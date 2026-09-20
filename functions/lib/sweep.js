// Orphan-receipt sweeper, split from index.js so the scan/delete
// decision matrix is unit-testable with fake bucket/database objects.
//
// Privacy rules: receipt object names ARE registration document IDs —
// they are never logged. Only counts and error codes leave this
// module.

// Orphans younger than this are left alone: a receipt whose submission
// is still in flight (upload done, document write pending or
// retrying) must never be swept out from under it.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const RECEIPT_PREFIX = "receipts/";

/**
 * Deletes unreferenced receipt objects from storage. A receipt is
 * orphaned when no animalRegistrations/<id> document exists for its
 * object name — the public submission's Firestore write (and the
 * client's immediate cleanup) failed.
 * @param {object} deps Injected dependencies for testability.
 * @param {object} deps.bucket Admin SDK storage bucket.
 * @param {object} deps.db Admin SDK Firestore instance.
 * @param {number} deps.nowMs Current time in ms (defaults Date.now()).
 * @param {number} deps.graceMs Minimum object age before deletion.
 * @param {object} deps.log Structured logger.
 * @param {string} deps.runId Correlation id for this sweep.
 * @return {Promise<object>} Counters: scanned, deleted,
 *   skippedRecent, skippedMalformed, failed.
 */
async function sweepOrphanedReceipts({
  bucket,
  db,
  nowMs = Date.now(),
  graceMs = ORPHAN_GRACE_MS,
  log = console,
  runId,
}) {
  const base = {
    subsystem: "receipt-cleanup",
    operation: "sweep",
    runId,
  };
  const cutoff = nowMs - graceMs;
  const [files] = await bucket.getFiles({prefix: RECEIPT_PREFIX});

  const counts = {
    scanned: 0,
    deleted: 0,
    skippedRecent: 0,
    skippedMalformed: 0,
    failed: 0,
  };

  for (const file of files) {
    const registrationId = file.name.slice(RECEIPT_PREFIX.length);
    if (!file.name.startsWith(RECEIPT_PREFIX) ||
        !registrationId || registrationId.includes("/")) {
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
      const doc = await db
          .collection("animalRegistrations")
          .doc(registrationId)
          .get();
      if (!doc.exists) {
        await file.delete();
        counts.deleted++;
      }
    } catch (error) {
      counts.failed++;
      log.warn({...base, outcome: "object-failed",
        errorCode: typeof error?.code === "string" ?
          error.code : error?.name ?? "unknown"});
    }
  }

  const summary = {...base, ...counts};
  if (counts.failed > 0) {
    // Error-level so log-based alerting catches a partially failed
    // sweep; the caller rethrows to mark the execution failed.
    log.error({...summary, outcome: "partial-failure"});
  } else {
    log.info({...summary, outcome: "ok"});
  }
  return counts;
}

module.exports = {sweepOrphanedReceipts, ORPHAN_GRACE_MS};
