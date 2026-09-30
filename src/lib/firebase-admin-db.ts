import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp } from "./firebase-admin-app";

// Firestore lives in its own module so Firestore-only routes and scripts
// never import firebase-admin/auth — its jwks-rsa -> ESM-only jose chain
// is the failure that caused the #144 Vercel runtime outage.
export const adminDb = () => getFirestore(getAdminApp());
