// Emulator-backed tests for firestore.rules and storage.rules.
// Run via `npm run test:rules` (requires no production credentials).
//
// #183 retirement posture: the operational collections (animals,
// animalRegistrations, admins) are deny-all for every principal —
// Postgres owns those domains and the retired collections can never
// serve as an alternate read/write path. Staff identity for
// rules-evaluated client writes is the `admin` custom claim set by the
// session route; the seeded admins/ document below exists to prove the
// collection is no longer consulted.
import { test, before, after } from "node:test";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";

const PROJECT_ID = "demo-sfpca";
const BUCKET = "demo-sfpca.appspot.com";
const ADMIN_EMAIL = "staff@sfpca.org";
const USER_EMAIL = "user@example.com";

// Referenced only for compat imports (server timestamps are no longer
// needed — the retired collections accept no client writes).
void firebase;

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: "127.0.0.1", port: 8080 },
    storage: { host: "127.0.0.1", port: 9199, bucket: BUCKET },
  });

  // Seed data bypassing security rules
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    // Pre-launch leftovers: real documents sitting in the retired
    // collections. They must be unreadable and unwritable through the
    // client SDK for every principal — the deny-all posture.
    await db.collection("admins").doc(ADMIN_EMAIL).set({
      email: ADMIN_EMAIL,
      role: "admin",
    });
    await db.collection("animals").doc("avail-1").set({
      name: "Buddy", status: "available", photos: [],
    });
    await db.collection("animalRegistrations").doc("reg-1").set({
      ownerInfo: { name: "Jane Doe" },
      animals: [{ name: "Rex" }],
      status: "pending",
    });
    await db.collection("homepage").doc("main").set({ hero: "Welcome" });
    await db.collection("siteSettings").doc("global").set({ phone: "x" });
    await db.collection("faq").doc("q1").set({ question: "?", answer: "!" });
    await db.collection("vetServices").doc("main").set({ content: "x" });
    await db.collection("animalAdoptions").doc("main").set({ content: "x" });
    await db.collection("animalRegistration").doc("main").set({ content: "x" });

    const storage = context.storage();
    for (const path of [
      "team-photos/existing.png",
      "images/existing.png",
      "animals/avail-1/existing.png",
      // A receipt left by a pre-launch submission — private forever.
      "receipts/reg-1",
      "receipts/existing",
    ]) {
      await storage
        .ref(path)
        .put(new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    }
  });
});

after(async () => {
  await testEnv.cleanup();
});

const publicDb = () => testEnv.unauthenticatedContext().firestore();
const userDb = () =>
  testEnv.authenticatedContext("user-1", {
    email: USER_EMAIL,
    email_verified: true,
  }).firestore();
// Verified user carrying the admin custom claim — the rules-side staff
// identity set by the session route after Postgres admin_users
// authorizes the login.
const adminDb = () =>
  testEnv.authenticatedContext("admin-1", {
    email: ADMIN_EMAIL,
    email_verified: true,
    admin: true,
  }).firestore();
// Verified user with the admin's email but NO claim: proves the
// admins/ collection document is never consulted — a seeded admins/
// row grants nothing.
const noClaimDb = () =>
  testEnv.authenticatedContext("noclaim-1", {
    email: ADMIN_EMAIL,
    email_verified: true,
  }).firestore();
// Attacker who created an account using the admin's email address but
// never verified it (open email/password sign-up).
const spoofedDb = () =>
  testEnv.authenticatedContext("attacker-1", {
    email: ADMIN_EMAIL,
    email_verified: false,
  }).firestore();

// ---------- Public content reads ----------

for (const [collection, docId] of [
  ["homepage", "main"],
  ["siteSettings", "global"],
  ["faq", "q1"],
  ["vetServices", "main"],
  ["animalAdoptions", "main"],
  ["animalRegistration", "main"],
]) {
  test(`public can read ${collection}/${docId}`, async () => {
    await assertSucceeds(publicDb().collection(collection).doc(docId).get());
  });

  test(`non-admin cannot write ${collection}/${docId}`, async () => {
    await assertFails(
      userDb().collection(collection).doc(docId).set({ hacked: true }),
    );
  });
}

test("a claimed admin can write public content", async () => {
  await assertSucceeds(
    adminDb().collection("homepage").doc("main").set({ hero: "Updated" }),
  );
  await assertSucceeds(
    adminDb().collection("animalRegistration").doc("main").set({ content: "y" }),
  );
});

test("a verified email without the admin claim cannot write CMS content", async () => {
  // admins/staff@sfpca.org exists in the emulator — the retired
  // collection must grant nothing; only the claim authorizes.
  for (const collection of [
    "homepage",
    "siteSettings",
    "faq",
    "vetServices",
    "animalAdoptions",
    "animalRegistration",
  ]) {
    await assertFails(
      noClaimDb().collection(collection).doc("main").set({ hacked: true }),
    );
    await assertFails(
      spoofedDb().collection(collection).doc("main").set({ hacked: true }),
    );
  }
});

// ---------- Retired operational collections (deny-all) ----------

for (const collection of ["animals", "animalRegistrations", "admins"]) {
  test(`${collection}: no principal can read or write`, async () => {
    const docId =
      collection === "animals"
        ? "avail-1"
        : collection === "animalRegistrations"
          ? "reg-1"
          : ADMIN_EMAIL;
    for (const db of [publicDb(), userDb(), noClaimDb(), spoofedDb()]) {
      await assertFails(db.collection(collection).doc(docId).get());
      await assertFails(db.collection(collection).doc(docId).set({ x: 1 }));
      await assertFails(db.collection(collection).doc(docId).delete());
    }
    // Even the claimed admin is denied — the collections are retired,
    // not admin-gated; nobody uses them at runtime.
    await assertFails(adminDb().collection(collection).doc(docId).get());
    await assertFails(adminDb().collection(collection).doc(docId).set({ x: 1 }));
    await assertFails(adminDb().collection(collection).doc(docId).delete());
    // Listing/creating is equally closed.
    await assertFails(publicDb().collection(collection).get());
    await assertFails(adminDb().collection(collection).get());
    await assertFails(
      adminDb().collection(collection).doc("new-doc").set({ x: 1 }),
    );
  });
}

test("unknown collections are denied by default", async () => {
  await assertFails(publicDb().collection("secrets").doc("x").get());
  await assertFails(adminDb().collection("secrets").doc("x").set({}));
});

// ---------- Storage ----------

const publicStorage = () => testEnv.unauthenticatedContext().storage();
const userStorage = () =>
  testEnv.authenticatedContext("user-1", {
    email: USER_EMAIL,
    email_verified: true,
  }).storage();
const adminStorage = () =>
  testEnv.authenticatedContext("admin-1", {
    email: ADMIN_EMAIL,
    email_verified: true,
    admin: true,
  }).storage();
const noClaimStorage = () =>
  testEnv.authenticatedContext("noclaim-1", {
    email: ADMIN_EMAIL,
    email_verified: true,
  }).storage();
const spoofedStorage = () =>
  testEnv.authenticatedContext("attacker-1", {
    email: ADMIN_EMAIL,
    email_verified: false,
  }).storage();

const pngBytes = () => new Uint8Array([137, 80, 78, 71]);

test("public can read storage object team-photos/existing.png", async () => {
  await assertSucceeds(
    publicStorage().ref("team-photos/existing.png").getMetadata(),
  );
});

// The images/ Storage prefix was deliberately removed (issue #137): no
// code path ever uploaded to or read from it — the rule was boilerplate
// predating every current Storage workflow — and the production prefix
// is empty, so no stored content can reference a live object there. The
// seeded images/existing.png object proves removal denies access without
// deleting existing data.
test("images/ storage objects are unreadable by everyone", async () => {
  await assertFails(publicStorage().ref("images/existing.png").getMetadata());
  await assertFails(userStorage().ref("images/existing.png").getMetadata());
  await assertFails(adminStorage().ref("images/existing.png").getMetadata());
});

test("images/ storage namespace is not writable by anyone", async () => {
  for (const storage of [
    publicStorage(),
    userStorage(),
    adminStorage(),
    spoofedStorage(),
  ]) {
    await assertFails(
      storage.ref("images/new.png").put(pngBytes(), { contentType: "image/png" }),
    );
    // A PUT onto an occupied path is an update — also denied.
    await assertFails(
      storage
        .ref("images/existing.png")
        .put(pngBytes(), { contentType: "image/png" }),
    );
    await assertFails(storage.ref("images/existing.png").delete());
  }
});

// The animals/ Storage prefix was deliberately removed (issue #127): the
// app stores animal photo URLs on the registry row and nothing
// uploads to animals/**, so the namespace falls through to default-deny —
// for everyone, including admins. The seeded animals/avail-1/existing.png
// object proves removal denies access without deleting existing data.
test("animals/ storage objects are unreadable by everyone", async () => {
  await assertFails(publicStorage().ref("animals/avail-1/existing.png").getMetadata());
  await assertFails(userStorage().ref("animals/avail-1/existing.png").getMetadata());
  await assertFails(adminStorage().ref("animals/avail-1/existing.png").getMetadata());
});

test("animals/ storage namespace is not writable by anyone", async () => {
  for (const storage of [publicStorage(), userStorage(), adminStorage()]) {
    await assertFails(
      storage.ref("animals/avail-1/photo.png").put(pngBytes(), { contentType: "image/png" }),
    );
    await assertFails(storage.ref("animals/avail-1/existing.png").delete());
  }
});

test("non-admin cannot upload to team-photos/", async () => {
  for (const storage of [userStorage(), publicStorage(), spoofedStorage(), noClaimStorage()]) {
    await assertFails(
      storage.ref("team-photos/new.png").put(pngBytes(), { contentType: "image/png" }),
    );
  }
});

test("claimed admin can upload an image to team-photos/", async () => {
  await assertSucceeds(
    adminStorage().ref("team-photos/new.png").put(pngBytes(), { contentType: "image/png" }),
  );
});

test("claimed admin can overwrite and delete team photos", async () => {
  await assertSucceeds(
    adminStorage()
      .ref("team-photos/existing.png")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertSucceeds(
    adminStorage().ref("team-photos/obsolete.png").put(pngBytes(), { contentType: "image/png" }),
  );
  await assertSucceeds(adminStorage().ref("team-photos/obsolete.png").delete());
});

test("non-admin cannot delete storage objects", async () => {
  await assertFails(userStorage().ref("team-photos/existing.png").delete());
  await assertFails(publicStorage().ref("team-photos/existing.png").delete());
  await assertFails(noClaimStorage().ref("team-photos/existing.png").delete());
});

test("claimed admin cannot upload non-image content or files over 5 MB", async () => {
  await assertFails(
    adminStorage()
      .ref("team-photos/evil.html")
      .put(new Uint8Array([60, 104, 116, 109, 108]), {
        contentType: "text/html",
      }),
  );
  await assertFails(
    adminStorage()
      .ref("team-photos/huge.png")
      .put(new Uint8Array(5 * 1024 * 1024 + 1), { contentType: "image/png" }),
  );
});

test("storage paths outside known prefixes are denied by default", async () => {
  await assertFails(publicStorage().ref("backups/db.json").getMetadata());
  await assertFails(
    adminStorage()
      .ref("backups/db.json")
      .put(pngBytes(), { contentType: "image/png" }),
  );
});

// ---------- Payment receipts (private submission data) ----------
// Post-#183 posture: public constrained create is the ONLY client-side
// operation. Reads/updates/deletes are denied for every principal —
// staff view receipts through server-minted signed URLs and orphan
// cleanup runs through the Admin SDK, both of which bypass rules.

test("public can upload an image or PDF receipt", async () => {
  await assertSucceeds(
    publicStorage()
      .ref("receipts/new-receipt-1")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertSucceeds(
    publicStorage()
      .ref("receipts/new-receipt-2")
      .put(new Uint8Array([37, 80, 68, 70]), {
        contentType: "application/pdf",
      }),
  );
});

test("public cannot upload non-image/PDF or oversized receipts", async () => {
  await assertFails(
    publicStorage()
      .ref("receipts/evil")
      .put(new Uint8Array([60, 104, 116, 109, 108]), {
        contentType: "text/html",
      }),
  );
  await assertFails(
    publicStorage()
      .ref("receipts/huge")
      .put(new Uint8Array(5 * 1024 * 1024 + 1), {
        contentType: "image/png",
      }),
  );
});

test("receipts are not readable by any client principal", async () => {
  for (const storage of [
    publicStorage(),
    userStorage(),
    noClaimStorage(),
    spoofedStorage(),
    adminStorage(),
  ]) {
    await assertFails(storage.ref("receipts/reg-1").getMetadata());
    await assertFails(storage.ref("receipts/existing").getMetadata());
    await assertFails(storage.ref("receipts/reg-1").getDownloadURL());
  }
});

test("nobody can overwrite an existing receipt object", async () => {
  for (const storage of [publicStorage(), userStorage(), adminStorage()]) {
    await assertFails(
      storage.ref("receipts/reg-1").put(pngBytes(), { contentType: "image/png" }),
    );
    await assertFails(
      storage.ref("receipts/existing").put(pngBytes(), { contentType: "image/png" }),
    );
  }
});

test("no client principal can delete a receipt — cleanup is server-side only", async () => {
  // The old anonymous orphan-delete path is gone: Firebase Storage rules
  // cannot query Postgres, so deletion is exclusively an Admin SDK
  // operation (the scheduled sweep). Every client delete is denied,
  // including for claimed admins and would-be orphans.
  // A brand-new upload can't be self-deleted either — it waits for
  // the sweep to classify it against Postgres.
  await assertSucceeds(
    publicStorage()
      .ref("receipts/new-undeletable")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  for (const storage of [
    publicStorage(),
    userStorage(),
    noClaimStorage(),
    spoofedStorage(),
    adminStorage(),
  ]) {
    await assertFails(storage.ref("receipts/reg-1").delete());
    await assertFails(storage.ref("receipts/existing").delete());
    await assertFails(storage.ref("receipts/new-undeletable").delete());
  }
});
