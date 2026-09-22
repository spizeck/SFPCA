// Emulator-backed tests for firestore.rules and storage.rules.
// Run via `npm run test:rules` (requires no production credentials).
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

const serverTimestamp = () =>
  firebase.firestore.FieldValue.serverTimestamp();

let testEnv;

// Valid submission shape matching src/components/animal-registration/.
// Seed writes bypass the rules, so fixed Dates are fine there; public
// creates must send server timestamps (rules pin createdAt/updatedAt to
// request.time) — use freshRegistration() for those.
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

const freshRegistration = (overrides = {}) => ({
  ...validRegistration,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...overrides,
});

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
      // An orphan: no animalRegistrations/existing document exists.
      "receipts/existing",
      // A referenced receipt: animalRegistrations/reg-1 exists above.
      "receipts/reg-1",
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

test("admin can write public content", async () => {
  await assertSucceeds(
    adminDb().collection("homepage").doc("main").set({ hero: "Updated" }),
  );
});

// animalRegistration is in the public-read loop above — it holds only
// page copy rendered on the public registration page. Writes stay
// admin-only, so also pin the positive admin case.
test("admin can write animalRegistration page content", async () => {
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
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-new")
      .set(freshRegistration()),
  );
});

test("public can submit a registration carrying its bound receipt path", async () => {
  await assertSucceeds(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-receipt")
      .set(freshRegistration({ paymentReceipt: "receipts/reg-receipt" })),
  );
});

test("public cannot reference a receipt belonging to another registration", async () => {
  // paymentReceipt must equal receipts/<this doc's id> — a submission
  // can never point at an existing receipt owned by a different doc.
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-receipt-2")
      .set(freshRegistration({ paymentReceipt: "receipts/reg-1" })),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-receipt-3")
      .set(freshRegistration({ paymentReceipt: "receipts/abc-123" })),
  );
});

test("public submissions cannot self-approve or carry unexpected fields", async () => {
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-bad-1")
      .set(freshRegistration({ status: "approved" })),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-bad-2")
      .set({ ...freshRegistration(), isAdmin: true }),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-bad-3")
      .set({ status: "pending" }),
  );
  // Privileged/workflow fields must never be injectable on create.
  for (const field of ["reviewed", "internalNotes", "assignedStaff", "approved"]) {
    await assertFails(
      publicDb()
        .collection("animalRegistrations")
        .doc(`reg-bad-${field}`)
        .set({ ...freshRegistration(), [field]: true }),
    );
  }
});

test("public submissions with missing or mistyped required fields fail", async () => {
  const cases = [
    // Missing required fields
    { ...freshRegistration(), ownerInfo: { name: "x", address: "y", phone: "z" } },
    { ...freshRegistration(), animals: [] },
    // Wrong types
    { ...freshRegistration(), totalFee: "10" },
    {
      ...freshRegistration(),
      ownerInfo: { name: 42, address: "y", phone: "z", email: "e@x.co" },
    },
    { ...freshRegistration(), animals: "dog" },
    { ...freshRegistration(), paymentReceipt: 123 },
    // Empty required strings
    {
      ...freshRegistration(),
      ownerInfo: { name: "", address: "y", phone: "z", email: "e@x.co" },
    },
  ];
  for (const [i, data] of cases.entries()) {
    await assertFails(
      publicDb().collection("animalRegistrations").doc(`reg-fail-${i}`).set(data),
    );
  }
});

test("public submissions cannot smuggle extra owner fields or oversized data", async () => {
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-owner-extra")
      .set(
        freshRegistration({
          ownerInfo: {
            name: "Jane",
            address: "x",
            phone: "y",
            email: "e@x.co",
            ssn: "123-45-6789",
          },
        }),
      ),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-long")
      .set(
        freshRegistration({
          ownerInfo: {
            name: "n".repeat(121),
            address: "x",
            phone: "y",
            email: "e@x.co",
          },
        }),
      ),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-many")
      .set(freshRegistration({ animals: Array(26).fill({ name: "a" }) })),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-fee")
      .set(freshRegistration({ totalFee: -5 })),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-fee-2")
      .set(freshRegistration({ totalFee: 25001 })),
  );
});

test("public submissions cannot forge receipt paths or timestamps", async () => {
  // paymentReceipt must be null or a receipts/ storage path — not an
  // arbitrary URL staff might later click.
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-url")
      .set(freshRegistration({ paymentReceipt: "https://evil.example/x" })),
  );
  // Client-controlled timestamps are rejected; createdAt/updatedAt must
  // be server timestamps resolving to request.time.
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-ts")
      .set({
        ...validRegistration,
        createdAt: new Date("2020-01-01"),
        updatedAt: new Date("2020-01-01"),
      }),
  );
});

test("registration data is not readable or enumerable by public or non-admin users", async () => {
  await assertFails(publicDb().collection("animalRegistrations").doc("reg-1").get());
  await assertFails(publicDb().collection("animalRegistrations").get());
  await assertFails(userDb().collection("animalRegistrations").doc("reg-1").get());
  await assertFails(userDb().collection("animalRegistrations").get());
  // Probing queries against private fields are denied for everyone
  // without admin rights.
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .where("ownerInfo.email", "==", "jane@example.com")
      .get(),
  );
  await assertFails(
    userDb()
      .collection("animalRegistrations")
      .where("status", "==", "pending")
      .get(),
  );
});

test("public cannot update or delete an existing registration", async () => {
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-1")
      .update({ status: "approved" }),
  );
  await assertFails(
    publicDb().collection("animalRegistrations").doc("reg-1").delete(),
  );
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

test("admin can read and transition registrations through the lifecycle", async () => {
  await assertSucceeds(adminDb().collection("animalRegistrations").get());
  // pending -> approved -> rejected -> pending: all supported transitions
  // succeed so staff can correct mistakes; none is terminal.
  await assertSucceeds(
    adminDb()
      .collection("animalRegistrations")
      .doc("reg-1")
      .update({ status: "approved" }),
  );
  await assertSucceeds(
    adminDb()
      .collection("animalRegistrations")
      .doc("reg-1")
      .update({ status: "rejected" }),
  );
  await assertSucceeds(
    adminDb()
      .collection("animalRegistrations")
      .doc("reg-1")
      .update({ status: "pending" }),
  );
});

test("admin cannot write an unsupported registration status", async () => {
  await assertFails(
    adminDb()
      .collection("animalRegistrations")
      .doc("reg-1")
      .update({ status: "archived" }),
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
// app stores animal photo URLs on the Firestore document and nothing
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

for (const path of [
  "team-photos/new.png",
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

// ---------- Payment receipts (private submission data) ----------

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

test("receipts are not readable by public or non-admin users", async () => {
  await assertFails(publicStorage().ref("receipts/reg-1").getMetadata());
  await assertFails(userStorage().ref("receipts/reg-1").getMetadata());
  await assertFails(
    publicStorage().ref("receipts/reg-1").getDownloadURL(),
  );
});

test("nobody can overwrite an existing receipt object", async () => {
  await assertFails(
    publicStorage()
      .ref("receipts/reg-1")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertFails(
    userStorage()
      .ref("receipts/existing")
      .put(pngBytes(), { contentType: "image/png" }),
  );
});

test("referenced receipts cannot be deleted by public or non-admin users", async () => {
  // receipts/reg-1 is bound to the existing animalRegistrations/reg-1
  // document — only admins may delete referenced receipts.
  await assertFails(publicStorage().ref("receipts/reg-1").delete());
  await assertFails(userStorage().ref("receipts/reg-1").delete());
});

test("an orphan receipt can be deleted — the submission-cleanup path", async () => {
  // Self-contained orphan: receipts/orphan-1 has no matching
  // animalRegistrations document, simulating an upload whose
  // registration write failed. Anonymous delete is permitted exactly in
  // this case — this is what lets the public form clean up its own
  // upload when the Firestore write fails.
  await assertSucceeds(
    publicStorage()
      .ref("receipts/orphan-1")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertSucceeds(publicStorage().ref("receipts/orphan-1").delete());
});

test("a failed registration write leaves no orphan — full flow", async () => {
  // Regression for the orphan-receipt bug: upload succeeds, the
  // Firestore create is rejected (here: a forged privileged field, but
  // any failure behaves identically), and the anonymous cleanup delete
  // is then authorized because the document does not exist.
  await assertSucceeds(
    publicStorage()
      .ref("receipts/reg-orphan")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertFails(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-orphan")
      .set(
        freshRegistration({
          paymentReceipt: "receipts/reg-orphan",
          internalNotes: "smuggle",
        }),
      ),
  );
  await assertSucceeds(
    publicStorage().ref("receipts/reg-orphan").delete(),
  );
  // The lost-response case: the write actually lands, so the receipt is
  // now referenced and anonymous cleanup must be denied.
  await assertSucceeds(
    publicStorage()
      .ref("receipts/reg-late")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertSucceeds(
    publicDb()
      .collection("animalRegistrations")
      .doc("reg-late")
      .set(freshRegistration({ paymentReceipt: "receipts/reg-late" })),
  );
  await assertFails(publicStorage().ref("receipts/reg-late").delete());
});

test("admin can read, delete, and re-upload receipts", async () => {
  await assertSucceeds(adminStorage().ref("receipts/existing").getMetadata());
  // Replacing a receipt is delete-then-create: a PUT onto an occupied
  // path is treated as a create and denied for everyone, so an existing
  // object can never be silently overwritten.
  await assertSucceeds(adminStorage().ref("receipts/existing").delete());
  await assertSucceeds(
    adminStorage()
      .ref("receipts/existing")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertSucceeds(
    adminStorage()
      .ref("receipts/to-delete")
      .put(pngBytes(), { contentType: "image/png" }),
  );
  await assertSucceeds(adminStorage().ref("receipts/to-delete").delete());
});
