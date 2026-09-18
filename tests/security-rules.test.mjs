// Emulator-backed tests for firestore.rules and storage.rules.
// Run via `npm run test:rules` (requires no production credentials).
import { test, before, after } from "node:test";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";

const PROJECT_ID = "demo-sfpca";
const BUCKET = "demo-sfpca.appspot.com";
const ADMIN_EMAIL = "staff@sfpca.org";
const USER_EMAIL = "user@example.com";

let testEnv;

// Valid submission shape matching src/components/animal-registration/
const validRegistration = {
  ownerInfo: {
    name: "Jane Doe",
    address: "Windwardside, Saba",
    phone: "+599 416 0000",
    email: "jane@example.com",
  },
  animals: [{ name: "Rex", type: "dog", sex: "male", isFixed: "yes" }],
  paymentReceipt: null,
  totalFee: 10,
  status: "pending",
  createdAt: new Date(),
  updatedAt: new Date(),
};

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: "127.0.0.1", port: 8080 },
    storage: { host: "127.0.0.1", port: 9199, bucket: BUCKET },
  });

  // Seed data bypassing security rules
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.collection("admins").doc(ADMIN_EMAIL).set({
      email: ADMIN_EMAIL,
      role: "admin",
    });
    await db.collection("homepage").doc("main").set({ hero: "Welcome" });
    await db.collection("siteSettings").doc("global").set({ phone: "x" });
    await db.collection("faq").doc("q1").set({ question: "?", answer: "!" });
    await db.collection("vetServices").doc("main").set({ content: "x" });
    await db.collection("animalAdoptions").doc("main").set({ content: "x" });
    await db.collection("animalRegistration").doc("main").set({ content: "x" });
    await db.collection("animals").doc("avail-1").set({
      name: "Buddy", status: "available", photos: [],
    });
    await db.collection("animals").doc("pend-1").set({
      name: "Milo", status: "pending", photos: [],
    });
    await db.collection("animals").doc("adopt-1").set({
      name: "Luna", status: "adopted", photos: [],
    });
    // Malformed/legacy documents: unknown and missing status values must
    // fail closed — never publicly readable.
    await db.collection("animals").doc("unknown-1").set({
      name: "Rex", status: "quarantined", photos: [],
    });
    await db.collection("animals").doc("nostatus-1").set({
      name: "Ghost", photos: [],
    });
    // Dedicated doc for admin transition writes so read tests above are
    // unaffected by mutations.
    await db.collection("animals").doc("trans-1").set({
      name: "Scout", status: "pending", photos: [],
    });
    await db.collection("animalRegistrations").doc("reg-1").set(validRegistration);

    const storage = context.storage();
    for (const path of [
      "team-photos/existing.png",
      "images/existing.png",
      "animals/avail-1/existing.png",
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
const adminDb = () =>
  testEnv.authenticatedContext("admin-1", {
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

test("admin can write public content", async () => {
  await assertSucceeds(
    adminDb().collection("homepage").doc("main").set({ hero: "Updated" }),
  );
});

test("animalRegistration page content is admin-only", async () => {
  await assertFails(publicDb().collection("animalRegistration").doc("main").get());
  await assertFails(userDb().collection("animalRegistration").doc("main").get());
  await assertFails(
    publicDb().collection("animalRegistration").doc("main").set({ hacked: true }),
  );
  await assertFails(
    userDb().collection("animalRegistration").doc("main").set({ hacked: true }),
  );
  await assertSucceeds(
    adminDb().collection("animalRegistration").doc("main").get(),
  );
  await assertSucceeds(
    adminDb().collection("animalRegistration").doc("main").set({ content: "y" }),
  );
});

// ---------- Animal visibility ----------

test("public can read an available animal", async () => {
  await assertSucceeds(publicDb().collection("animals").doc("avail-1").get());
});

test("public cannot read a pending or adopted animal", async () => {
  await assertFails(publicDb().collection("animals").doc("pend-1").get());
  await assertFails(publicDb().collection("animals").doc("adopt-1").get());
});

test("public cannot read an animal with an unknown or missing status", async () => {
  await assertFails(publicDb().collection("animals").doc("unknown-1").get());
  await assertFails(publicDb().collection("animals").doc("nostatus-1").get());
});

test("authenticated non-admin cannot read non-public animals either", async () => {
  for (const docId of ["pend-1", "adopt-1", "unknown-1", "nostatus-1"]) {
    await assertFails(userDb().collection("animals").doc(docId).get());
  }
});

test("public can query animals filtered to status == available", async () => {
  await assertSucceeds(
    publicDb().collection("animals").where("status", "==", "available").get(),
  );
});

test("public cannot list animals without the availability filter", async () => {
  await assertFails(publicDb().collection("animals").get());
});

test("public queries that could return non-public animals are denied", async () => {
  // Rules must prove every returned doc is public; queries that could
  // match pending/adopted/unknown statuses fail rather than leaking.
  await assertFails(
    publicDb().collection("animals").where("status", "!=", "available").get(),
  );
  await assertFails(
    publicDb()
      .collection("animals")
      .where("status", "in", ["available", "pending"])
      .get(),
  );
});

test("admin can list all animals", async () => {
  await assertSucceeds(adminDb().collection("animals").get());
  await assertSucceeds(adminDb().collection("animals").doc("pend-1").get());
});

test("non-admin cannot create, update, or delete animals", async () => {
  await assertFails(
    userDb().collection("animals").doc("new-1").set({ status: "available" }),
  );
  await assertFails(
    userDb().collection("animals").doc("pend-1").update({ status: "available" }),
  );
  await assertFails(userDb().collection("animals").doc("avail-1").delete());
});

test("admin can create, update, and delete animals", async () => {
  await assertSucceeds(
    adminDb().collection("animals").doc("new-1").set({ status: "pending" }),
  );
  await assertSucceeds(
    adminDb().collection("animals").doc("avail-1").update({ status: "adopted" }),
  );
  await assertSucceeds(adminDb().collection("animals").doc("new-1").delete());
});

test("admin lifecycle transitions between supported statuses succeed", async () => {
  // pending -> available -> adopted -> available: no state is terminal,
  // staff can correct mistakes.
  await assertSucceeds(
    adminDb().collection("animals").doc("trans-1").update({ status: "available" }),
  );
  await assertSucceeds(
    adminDb().collection("animals").doc("trans-1").update({ status: "adopted" }),
  );
  await assertSucceeds(
    adminDb().collection("animals").doc("trans-1").update({ status: "available" }),
  );
});

test("admin cannot write an unsupported or missing animal status", async () => {
  await assertFails(
    adminDb().collection("animals").doc("bad-1").set({ status: "stray" }),
  );
  await assertFails(
    adminDb().collection("animals").doc("bad-2").set({ name: "NoStatus" }),
  );
  await assertFails(
    adminDb().collection("animals").doc("pend-1").update({ status: "gone" }),
  );
});

// ---------- Private registration data ----------

test("public can submit a valid pending registration", async () => {
  await assertSucceeds(
    publicDb().collection("animalRegistrations").doc("reg-new").set(validRegistration),
  );
});

test("public submissions cannot self-approve or carry unexpected fields", async () => {
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-bad-1")
      .set({ ...validRegistration, status: "approved" }),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-bad-2")
      .set({ ...validRegistration, isAdmin: true }),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-bad-3")
      .set({ status: "pending" }),
  );
});

test("registration data is not readable by public or non-admin users", async () => {
  await assertFails(publicDb().collection("animalRegistrations").doc("reg-1").get());
  await assertFails(publicDb().collection("animalRegistrations").get());
  await assertFails(userDb().collection("animalRegistrations").doc("reg-1").get());
  await assertFails(userDb().collection("animalRegistrations").get());
});

test("non-admin cannot mutate or delete registrations", async () => {
  await assertFails(
    userDb()
      .collection("animalRegistrations")
      .doc("reg-1")
      .update({ status: "approved" }),
  );
  await assertFails(userDb().collection("animalRegistrations").doc("reg-1").delete());
});

test("admin can read and update registrations", async () => {
  await assertSucceeds(adminDb().collection("animalRegistrations").get());
  await assertSucceeds(
    adminDb()
      .collection("animalRegistrations")
      .doc("reg-1")
      .update({ status: "approved" }),
  );
});

// ---------- Admin identity ----------

test("unverified account bearing an admin email gets no admin access", async () => {
  await assertFails(spoofedDb().collection("animals").doc("avail-1").delete());
  await assertFails(
    spoofedDb().collection("animalRegistrations").doc("reg-1").get(),
  );
  await assertFails(spoofedDb().collection("admins").doc(USER_EMAIL).set({}));
});

test("non-admin verified user is not an admin", async () => {
  await assertFails(userDb().collection("admins").doc(USER_EMAIL).set({}));
  await assertFails(userDb().collection("admins").doc(ADMIN_EMAIL).get());
});

test("admin can read and manage the admins collection", async () => {
  await assertSucceeds(adminDb().collection("admins").doc(ADMIN_EMAIL).get());
  await assertSucceeds(
    adminDb()
      .collection("admins")
      .doc("editor@sfpca.org")
      .set({ email: "editor@sfpca.org", role: "editor" }),
  );
});

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
  }).storage();
const spoofedStorage = () =>
  testEnv.authenticatedContext("attacker-1", {
    email: ADMIN_EMAIL,
    email_verified: false,
  }).storage();

const pngBytes = () => new Uint8Array([137, 80, 78, 71]);

for (const path of [
  "team-photos/existing.png",
  "images/existing.png",
  "animals/avail-1/existing.png",
]) {
  test(`public can read storage object ${path}`, async () => {
    await assertSucceeds(publicStorage().ref(path).getMetadata());
  });
}

for (const path of [
  "team-photos/new.png",
  "images/new.png",
  "animals/avail-1/photo.png",
]) {
  test(`non-admin cannot upload to ${path}`, async () => {
    await assertFails(
      userStorage().ref(path).put(pngBytes(), { contentType: "image/png" }),
    );
    await assertFails(
      publicStorage().ref(path).put(pngBytes(), { contentType: "image/png" }),
    );
    await assertFails(
      spoofedStorage().ref(path).put(pngBytes(), { contentType: "image/png" }),
    );
  });

  test(`admin can upload an image to ${path}`, async () => {
    await assertSucceeds(
      adminStorage().ref(path).put(pngBytes(), { contentType: "image/png" }),
    );
  });
}

test("admin can overwrite and delete storage objects", async () => {
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
});

test("admin cannot upload non-image content or files over 5 MB", async () => {
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
