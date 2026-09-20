const functions = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const {triggerVercelRebuild} = require("./lib/rebuild");
const {sweepOrphanedReceipts} = require("./lib/sweep");

admin.initializeApp();

// Get environment variables
const {
  REBUILD_TRIGGER_TOKEN,
} = process.env;

// Firestore collections whose writes can change statically generated
// public pages — the only writes that should trigger a Vercel rebuild.
// Notably absent: animalRegistrations and admins. A public
// registration submission must not burn a deploy, and filtering here
// also keeps private document paths out of the trigger logs entirely.
const REBUILD_COLLECTIONS = new Set([
  "homepage",
  "siteSettings",
  "animals",
  "faq",
  "vetServices",
  "animalAdoptions",
  "animalRegistration",
]);

/**
 * The manual rebuild endpoint performs a privileged operation, so it
 * requires a shared secret: `Authorization: Bearer <REBUILD_TRIGGER_TOKEN>`.
 * When the token is not configured the endpoint refuses every request
 * (fails closed). Compared in constant time.
 * @param {object} req The HTTP request.
 * @return {boolean} Whether the request is authorized.
 */
function isRebuildAuthorized(req) {
  if (!REBUILD_TRIGGER_TOKEN) {
    return false;
  }
  const provided = Buffer.from(req.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${REBUILD_TRIGGER_TOKEN}`);
  // Compare buffer (byte) lengths: timingSafeEqual throws on unequal
  // buffers, and string length differs from byte length for multibyte
  // characters.
  return provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected);
}

/**
 * Triggers a Vercel rebuild when a content-bearing Firestore document
 * is written.
 * @param {object} event The Firestore document write event.
 */
async function handleFirestoreChange(event) {
  // Only proceed if this is not a read operation and there's actual data
  // change
  if (!event.data.before.exists && !event.data.after.exists) {
    return;
  }

  const docPath = event.data.before.exists ?
      event.data.before.ref.path : event.data.after.ref.path;
  const collectionId = docPath.split("/")[0];

  // Non-content writes (registrations, admins, ...) never change the
  // public site. Skipping them before any logging also means private
  // document IDs never appear in these logs.
  if (!REBUILD_COLLECTIONS.has(collectionId)) {
    return;
  }

  // Skip if the document hasn't actually changed (same data)
  if (event.data.before.exists && event.data.after.exists) {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();

    if (JSON.stringify(beforeData) === JSON.stringify(afterData)) {
      return;
    }
  }

  const eventId = crypto.randomUUID();
  logger.info({
    subsystem: "rebuild",
    operation: "firestore-trigger",
    outcome: "content-change",
    collection: collectionId,
    eventId,
  });

  // Propagates on failure: a failed rebuild request must mark this
  // execution failed, not disappear as a silent skip.
  await triggerVercelRebuild({log: logger, eventId});
}

// Firestore trigger for any document change
exports.onFirestoreChange =
    functions.firestore.onDocumentWritten("*", handleFirestoreChange);

// Manual trigger function. Bearer-token gated: the function URL alone
// must not be enough to trigger rebuilds.
exports.triggerRebuild = functions.https.onRequest(async (req, res) => {
  if (!isRebuildAuthorized(req)) {
    // Warn, not error: an unauthorized probe is not an operational
    // incident, and this must not become an error-spam vector.
    logger.warn({
      subsystem: "rebuild",
      operation: "manual-trigger",
      outcome: "denied",
    });
    res.status(403).json({
      success: false,
      error: "Forbidden",
    });
    return;
  }

  try {
    const triggered = await triggerVercelRebuild({log: logger});
    if (!triggered) {
      res.status(503).json({
        success: false,
        error: "Rebuild is not configured",
      });
      return;
    }
    res.json({
      success: true,
      message: "Vercel rebuild triggered successfully",
    });
  } catch (error) {
    // triggerVercelRebuild already logged the safe fields. Return a
    // generic message — the caller is authenticated but internal error
    // detail (upstream payloads, URLs) stays in the logs.
    res.status(500).json({
      success: false,
      error: "Rebuild request failed",
    });
  }
});

/**
 * Deletes payment receipts whose registration write never landed.
 * The public form uploads a receipt to receipts/<registrationId>
 * before creating the Firestore document; a failed write leaves an
 * orphan. Clients delete their own orphan immediately (storage rules
 * permit delete only while the document does not exist), but that
 * cleanup call can itself fail. This sweeper is the fail-safe: any
 * receipts/<id> object without a matching animalRegistrations/<id>
 * document is unreferenced private data and is removed. Logs counts
 * only — never object names or contents.
 */
exports.sweepOrphanedReceipts =
    functions.scheduler.onSchedule("every 24 hours", async () => {
      const result = await sweepOrphanedReceipts({
        bucket: admin.storage().bucket(),
        db: admin.firestore(),
        log: logger,
        runId: crypto.randomUUID(),
      });
      if (result.failed > 0) {
        // Mark the execution failed so error-rate alerting fires; the
        // sweep is idempotent and the next run retries the remainder.
        throw new Error(
            "sweepOrphanedReceipts: " + result.failed +
            " receipt object(s) failed during sweep",
        );
      }
    });
