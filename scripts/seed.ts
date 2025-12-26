import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

if (!serviceAccount) {
  console.error("Please set FIREBASE_SERVICE_ACCOUNT_PATH environment variable");
  process.exit(1);
}

const app = initializeApp({
  credential: cert(JSON.parse(fs.readFileSync(serviceAccount, "utf8"))),
});

const db = getFirestore(app);

async function seed() {
  try {
    const seedData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "seed-data.json"), "utf8")
    ) as {
      homepage: any;
      siteSettings: any;
      animals: any[];
      admins: Record<string, { email: string; role: string; createdAt: string }>;
    };

    console.log("Seeding homepage data...");
    await db.collection("homepage").doc("main").set(seedData.homepage);

    console.log("Seeding site settings...");
    await db.collection("siteSettings").doc("global").set(seedData.siteSettings);

    console.log("Seeding animals...");
    for (const animal of seedData.animals) {
      await db.collection("animals").add({
        ...animal,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    console.log("Seeding admin users...");
    for (const [email, data] of Object.entries(seedData.admins)) {
      await db.collection("admins").doc(email).set({
        email: data.email,
        role: data.role,
        createdAt: new Date(data.createdAt),
      });
    }

    console.log("✅ Seed data successfully loaded!");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding data:", error);
    process.exit(1);
  }
}

seed();
