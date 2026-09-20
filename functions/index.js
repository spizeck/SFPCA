const functions = require("firebase-functions/v2");
const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require("crypto");

admin.initializeApp();

// Get environment variables
const {
  VERCEL_TOKEN,
  VERCEL_PROJECT_ID,
  REBUILD_TRIGGER_TOKEN,
} = process.env;

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
 * Triggers a Vercel rebuild via the configured deploy hook.
 */
async function triggerVercelRebuild() {
  try {
    if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
      console.log("Vercel credentials not configured, skipping rebuild");
      return;
    }

    console.log("Triggering Vercel rebuild...");

    const response = await axios.post(
        `https://api.vercel.com/v1/integrations/deploy/prj_${VERCEL_PROJECT_ID}/${VERCEL_TOKEN}`,
        {},
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
    );

    console.log("Vercel rebuild triggered successfully:", response.data);
  } catch (error) {
    console.error(
        "Error triggering Vercel rebuild:",
        error.response?.data || error.message,
    );
  }
}

/**
 * Triggers a Vercel rebuild when a Firestore document is written.
 * @param {object} event The Firestore document write event.
 */
async function handleFirestoreChange(event) {
  // Only proceed if this is not a read operation and there's actual data change
  if (!event.data.before.exists && !event.data.after.exists) {
    return;
  }

  // Skip if the document hasn't actually changed (same data)
  if (event.data.before.exists && event.data.after.exists) {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();

    if (JSON.stringify(beforeData) === JSON.stringify(afterData)) {
      console.log("No actual data change detected, skipping rebuild");
      return;
    }
  }

  console.log(`Firestore document changed: ${event.resource.name}`);

  // Trigger Vercel rebuild
  await triggerVercelRebuild();
}

// Firestore trigger for any document change
exports.onFirestoreChange =
    functions.firestore.onDocumentWritten("*", handleFirestoreChange);

// Manual trigger function. Bearer-token gated: the function URL alone
// must not be enough to trigger rebuilds.
exports.triggerRebuild = functions.https.onRequest(async (req, res) => {
  if (!isRebuildAuthorized(req)) {
    res.status(403).json({
      success: false,
      error: "Forbidden",
    });
    return;
  }

  try {
    console.log("Manual rebuild triggered via HTTP");

    // Trigger Vercel rebuild
    await triggerVercelRebuild();

    res.json({
      success: true,
      message: "Vercel rebuild triggered successfully",
    });
  } catch (error) {
    console.error("Error in manual rebuild:", error);
    res.status(500).json({
      success: false,
      error: error.message,
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
// Orphans younger than this are left alone: a receipt whose submission
// is still in flight (upload done, document write pending or retrying)
// must never be swept out from under it. One hour is far beyond any
// realistic submission window.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

exports.sweepOrphanedReceipts =
    functions.scheduler.onSchedule("every 24 hours", async () => {
      const bucket = admin.storage().bucket();
      const [files] = await bucket.getFiles({prefix: "receipts/"});
      const cutoff = Date.now() - ORPHAN_GRACE_MS;
      let deleted = 0;
      for (const file of files) {
        const registrationId = file.name.slice("receipts/".length);
        if (!registrationId || registrationId.includes("/")) {
          continue;
        }
        // Skip objects too new to safely classify — and any whose age
        // cannot be determined.
        const created = Date.parse(file.metadata.timeCreated || "");
        if (!created || created > cutoff) {
          continue;
        }
        const doc = await admin
            .firestore()
            .collection("animalRegistrations")
            .doc(registrationId)
            .get();
        if (!doc.exists) {
          await file.delete();
          deleted++;
        }
      }
      console.log(
          "sweepOrphanedReceipts: scanned " + files.length +
          " receipt object(s), deleted " + deleted + " orphan(s)",
      );
    });
