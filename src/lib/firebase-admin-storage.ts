import { getStorage } from "firebase-admin/storage";
import { getAdminApp } from "./firebase-admin-app";

export const adminStorage = () => getStorage(getAdminApp());

// Receipt objects live under receipts/<submissionId> in the default
// bucket. Signed URLs are minted here (never via the client SDK) so
// admin review can read private receipts without public-read rules.
export const adminReceiptBucket = () => adminBucket();

// Generic default-bucket accessor — used by the db-backup scripts for
// the db-backups/ prefix (deny-all client rules; Admin SDK bypasses).
export const adminBucket = () =>
  adminStorage().bucket(
    process.env.FIREBASE_ADMIN_STORAGE_BUCKET ??
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  );
