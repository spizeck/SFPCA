import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";

// Load environment variables from .env.local
config({ path: ".env.local" });

// Use environment variables instead of service account file
const serviceAccount = {
  projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
  clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
  console.error("Please set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and FIREBASE_ADMIN_PRIVATE_KEY environment variables");
  process.exit(1);
}

const app = initializeApp({
  credential: cert(serviceAccount),
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
