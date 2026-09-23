import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

let adminApp: App;

// Required production configuration (names only — values are secrets
// and must never appear in logs or errors).
const REQUIRED_ADMIN_ENV = [
  "FIREBASE_ADMIN_PROJECT_ID",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "FIREBASE_ADMIN_PRIVATE_KEY",
] as const;

export function missingAdminEnvVars(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return REQUIRED_ADMIN_ENV.filter((name) => !env[name]);
}

function getAdminApp() {
  if (getApps().length === 0) {
    // Emulator hosts signal a local/E2E run: no credentials are needed or
    // used, and a demo-* project ID can never reach production services.
    // The client-side project ID takes precedence here — ID tokens issued
    // by the Auth emulator carry that project as their audience, so the
    // Admin SDK must verify them against the same project even when a
    // real FIREBASE_ADMIN_PROJECT_ID exists in .env.local.
    if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      adminApp = initializeApp({
        projectId:
          process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
          process.env.FIREBASE_ADMIN_PROJECT_ID,
      });
    } else {
      // A missing credential would otherwise surface as a cryptic cert()
      // or first-request failure far from its cause. Fail fast naming
      // which variables are absent — never their values.
      const missing = missingAdminEnvVars();
      if (missing.length > 0) {
        throw new Error(
          `Firebase Admin is not configured: missing env var(s) ${missing.join(", ")}`,
        );
      }
      adminApp = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });
    }
  } else {
    adminApp = getApps()[0];
  }
  return adminApp;
}

export const adminAuth = () => getAuth(getAdminApp());
export const adminDb = () => getFirestore(getAdminApp());
export const adminStorage = () => getStorage(getAdminApp());

// Receipt objects live under receipts/<submissionId> in the default
// bucket. Signed URLs are minted here (never via the client SDK) so
// admin review can read private receipts without public-read rules.
export const adminReceiptBucket = () =>
  adminStorage().bucket(
    process.env.FIREBASE_ADMIN_STORAGE_BUCKET ??
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  );
