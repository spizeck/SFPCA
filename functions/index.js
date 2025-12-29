const functions = require("firebase-functions/v2");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();

// Get environment variables
const {
  VERCEL_TOKEN,
  VERCEL_TEAM_ID,
  VERCEL_PROJECT_ID,
  GITHUB_TOKEN
} = process.env;

// Trigger Vercel rebuild
async function triggerVercelRebuild() {
  try {
    if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
      console.log("Vercel credentials not configured, skipping rebuild");
      return;
    }

    const response = await axios.post(
      `https://api.vercel.com/v1/integrations/deploy/prj_${VERCEL_PROJECT_ID}/${VERCEL_TOKEN}`,
      {},
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Vercel rebuild triggered:", response.data);
  } catch (error) {
    console.error("Error triggering Vercel rebuild:", error.response?.data || error.message);
  }
}

// Merge dev branch to main
async function mergeDevToMain() {
  try {
    if (!GITHUB_TOKEN) {
      console.log("GitHub token not configured, skipping merge");
      return;
    }

    // Get the latest commit SHA from dev branch
    const { data: devBranch } = await axios.get(
      "https://api.github.com/repos/spizeck/SFPCA/branches/dev",
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    // Create a pull request from dev to main
    const { data: pr } = await axios.post(
      "https://api.github.com/repos/spizeck/SFPCA/pulls",
      {
        title: "Sync dev to main",
        head: "dev",
        base: "main",
        body: "Automated sync from dev to main after Firestore update",
        draft: false,
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    // Merge the pull request
    if (pr && pr.number) {
      const { data: mergeResult } = await axios.put(
        `https://api.github.com/repos/spizeck/SFPCA/pulls/${pr.number}/merge`,
        {
          commit_title: "Auto-merge dev to main",
          merge_method: "squash",
        },
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );

      console.log("Successfully merged dev to main:", mergeResult.sha);
    }
  } catch (error) {
    // If PR already exists, try to find and merge it
    if (error.response?.status === 422) {
      try {
        const { data: existingPRs } = await axios.get(
          "https://api.github.com/repos/spizeck/SFPCA/pulls?head=dev&base=main",
          {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              Accept: "application/vnd.github.v3+json",
            },
          }
        );

        if (existingPRs.length > 0) {
          const pr = existingPRs[0];
          const { data: mergeResult } = await axios.put(
            `https://api.github.com/repos/spizeck/SFPCA/pulls/${pr.number}/merge`,
            {
              commit_title: "Auto-merge dev to main",
              merge_method: "squash",
            },
            {
              headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github.v3+json",
              },
            }
          );

          console.log("Successfully merged existing PR:", mergeResult.sha);
        }
      } catch (mergeError) {
        console.error("Error merging existing PR:", mergeError.response?.data || mergeError.message);
      }
    } else {
      console.error("Error merging dev to main:", error.response?.data || error.message);
    }
  }
}

// Firestore trigger for any document change
exports.onFirestoreWrite = functions.firestore.onDocumentWritten("*", async (event) => {
  // Only proceed if this is not a read operation
  if (!event.data.before.exists && !event.data.after.exists) {
    return;
  }

  console.log(`Firestore document changed: ${event.resource.name}`);

  // Trigger Vercel rebuild
  await triggerVercelRebuild();

  // Merge dev to main
  await mergeDevToMain();
});

// Separate function for manual triggering if needed
exports.triggerDeployment = functions.https.onRequest(async (req, res) => {
  try {
    console.log("Manual deployment triggered");

    // Trigger Vercel rebuild
    await triggerVercelRebuild();

    // Merge dev to main
    await mergeDevToMain();

    res.json({ success: true, message: "Deployment triggered successfully" });
  } catch (error) {
    console.error("Error in manual deployment:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
