import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getAuth, Auth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, Firestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let storage: FirebaseStorage;

// Initialize Firebase for both client and server
app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
auth = getAuth(app);
db = getFirestore(app);
storage = getStorage(app);

// Emulator connection is opt-in and only used by local/E2E test runs —
// it is never enabled in production (the flag is never set there).
// Ports default to firebase.json's but can be overridden so the harness
// can dodge local port conflicts (other software bound to 8080/9099).
if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true") {
  connectAuthEmulator(
    auth,
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL ??
      "http://localhost:9099",
    {
      disableWarnings: true,
    },
  );
  connectFirestoreEmulator(
    db,
    "localhost",
    Number(process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT ?? 8080),
  );
}

export { app, auth, db, storage };
