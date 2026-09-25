import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as dsql } from "drizzle-orm";

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

// Operational registry data (animals, admin users) is Postgres-only
// after #183 — the seed needs a database connection for those sections.
const dbUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("Please set DATABASE_URL (or DATABASE_URL_UNPOOLED) — animals and admin users seed into Postgres");
  process.exit(1);
}

const app = initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore(app);
const pg = postgres(dbUrl, { max: 1, prepare: false });
const pgdb = drizzle(pg);

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

    console.log("Seeding animals (Postgres)...");
    for (const animal of seedData.animals) {
      const { id, status, photos, ...rest } = animal;
      // The seed's `status` is the adoption-catalog value; every seeded
      // animal is lifecycle 'active'. Legacy approxAge text is kept as
      // staff-only identifying notes (see #167 transform rules).
      await pgdb.execute(dsql`
        INSERT INTO animals (legacy_id, name, species, sex,
          identifying_notes, description, lifecycle_status,
          adoption_status, photo_urls)
        VALUES (${id ?? null}, ${rest.name}, ${rest.species}, ${rest.sex},
          ${rest.approxAge ? `Approx. age at import: ${rest.approxAge}` : null},
          ${rest.description ?? null},
          'active', ${status}, ${JSON.stringify(photos ?? [])}::jsonb)
      `);
    }

    console.log("Seeding admin users (Postgres)...");
    for (const [, data] of Object.entries(seedData.admins)) {
      await pgdb.execute(dsql`
        INSERT INTO admin_users (email, role)
        VALUES (${data.email.toLowerCase()}, ${data.role})
        ON CONFLICT DO NOTHING
      `);
    }

    console.log("✅ Seed data successfully loaded!");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding data:", error);
    process.exit(1);
  }
}

seed();
