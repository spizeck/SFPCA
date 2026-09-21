// Read-only audit for issue #137: does production depend on Storage
// objects under images/?
//
// Uses ONLY the public NEXT_PUBLIC_* client config — the same values
// embedded in the deployed site's JS bundle. No admin SDK, no service
// account, no auth. Every read performed here is one the current
// security rules already allow to any anonymous internet client:
//   - images/** allows `read: if true`, which includes list
//   - public-read Firestore collections are fetched identically by the
//     public website on every page load
// Nothing here can write or mutate production data.
import { config } from "dotenv";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { getStorage, ref, listAll } from "firebase/storage";

config({ path: ".env.local" });

const app = initializeApp({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
});
const db = getFirestore(app);
const storage = getStorage(app);

// Recursively find string fields whose value references Firebase
// Storage or an images/ path.
const hits = [];
function scan(value, path) {
  if (typeof value === "string") {
    if (
      /firebasestorage|storage\.googleapis|images%2F|\/images\//i.test(value)
    ) {
      hits.push({ path, value });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) scan(v, `${path}.${k}`);
  }
}

console.log("== Storage: list images/ prefix (anonymous) ==");
try {
  const res = await listAll(ref(storage, "images/"));
  console.log(`items: ${res.items.length}, prefixes: ${res.prefixes.length}`);
  for (const item of res.items) console.log(`  object: ${item.fullPath}`);
  for (const p of res.prefixes) console.log(`  subprefix: ${p.fullPath}`);
  // One level of recursion is enough to see whether the namespace is in
  // use at all; deepen if anything shows up.
  for (const p of res.prefixes) {
    const sub = await listAll(p);
    for (const item of sub.items) console.log(`  object: ${item.fullPath}`);
    for (const pp of sub.prefixes)
      console.log(`  subprefix: ${pp.fullPath}`);
  }
} catch (e) {
  console.log(`list images/ FAILED: ${e.code ?? e.message}`);
}

console.log("\n== Storage: list bucket root (anonymous) ==");
try {
  const res = await listAll(ref(storage));
  console.log(
    `root prefixes: [${res.prefixes.map((p) => p.fullPath).join(", ")}]`,
  );
  console.log(`root items: ${res.items.length}`);
} catch (e) {
  console.log(`list root FAILED: ${e.code ?? e.message}`);
}

console.log("\n== Firestore: public documents ==");

async function scanDoc(col, id) {
  try {
    const snap = await getDoc(doc(db, col, id));
    if (!snap.exists()) {
      console.log(`${col}/${id}: does not exist`);
      return;
    }
    const before = hits.length;
    scan(snap.data(), `${col}/${id}`);
    console.log(
      `${col}/${id}: read ok, ${hits.length - before} storage/image refs`,
    );
  } catch (e) {
    console.log(`${col}/${id}: read FAILED: ${e.code ?? e.message}`);
  }
}

await scanDoc("homepage", "main");
await scanDoc("siteSettings", "global");
await scanDoc("vetServices", "main");
await scanDoc("animalAdoptions", "main");
await scanDoc("animalRegistration", "main"); // expected: admin-only

try {
  const faqs = await getDocs(collection(db, "faq"));
  console.log(`faq: ${faqs.size} docs readable`);
  faqs.forEach((d) => scan(d.data(), `faq/${d.id}`));
} catch (e) {
  console.log(`faq list FAILED: ${e.code ?? e.message}`);
}

try {
  const animals = await getDocs(
    query(collection(db, "animals"), where("status", "==", "available")),
  );
  console.log(`animals (available): ${animals.size} docs readable`);
  animals.forEach((d) => scan(d.data(), `animals/${d.id}`));
} catch (e) {
  console.log(`animals query FAILED: ${e.code ?? e.message}`);
}

console.log("\n== All storage/image URL references in public content ==");
if (hits.length === 0) console.log("(none)");
for (const h of hits) console.log(`${h.path} = ${h.value}`);

process.exit(0);
