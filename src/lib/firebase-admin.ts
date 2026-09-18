import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

let adminApp: App;

function getAdminApp() {
  if (getApps().length === 0) {
    // Emulator hosts signal a local/E2E run: no credentials are needed or
    // used, and a demo-* project ID can never reach production services.
    if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      adminApp = initializeApp({
        projectId:
          process.env.FIREBASE_ADMIN_PROJECT_ID ??
          process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      });
    } else {
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
