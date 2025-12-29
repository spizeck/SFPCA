const functions = require("firebase-functions/v2");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();

// Get environment variables
const {
  VERCEL_TOKEN,
  VERCEL_PROJECT_ID
} = process.env;

// Trigger Vercel rebuild
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
      }
    );

    console.log("Vercel rebuild triggered successfully:", response.data);
  } catch (error) {
    console.error("Error triggering Vercel rebuild:", error.response?.data || error.message);
  }
}

// Firestore trigger for any document change
exports.onFirestoreChange = functions.firestore.onDocumentWritten("*", async (event) => {
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
});

// Manual trigger function
exports.triggerRebuild = functions.https.onRequest(async (req, res) => {
  try {
    console.log("Manual rebuild triggered via HTTP");
    
    // Trigger Vercel rebuild
    await triggerVercelRebuild();

    res.json({ 
      success: true, 
      message: "Vercel rebuild triggered successfully" 
    });
  } catch (error) {
    console.error("Error in manual rebuild:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});
