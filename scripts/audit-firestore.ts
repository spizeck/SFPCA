// Read-only production Firestore audit for #181.
// Emits ONLY structural metadata: doc counts, field names, type
// distributions, enum-value distributions, presence rates.
// NEVER prints field values that could contain PII.
//
//   npx tsx scripts/audit-firestore.ts --project=<id>
import { config } from "dotenv";
config({ path: ".env.local" });

const project = process.argv
  .find((a) => a.startsWith("--project="))
  ?.slice(10);
if (!project || project !== process.env.FIREBASE_ADMIN_PROJECT_ID) {
  console.error("pass --project matching FIREBASE_ADMIN_PROJECT_ID");
  process.exit(1);
}

type Stats = Record<string, Record<string, number>>;

function typeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  // Firestore Timestamp has toDate; keep structural, not value
  if (typeof v === "object" && typeof (v as { toDate?: unknown }).toDate === "function")
    return "timestamp";
  return typeof v;
}

function addField(stats: Stats, path: string, v: unknown) {
  stats[path] ??= {};
  const t = typeName(v);
  stats[path][t] = (stats[path][t] ?? 0) + 1;
}

// Safe to report values for these (enums/statuses, not PII)
const ENUM_FIELDS = new Set(["status", "species", "sex", "role"]);

async function audit(
  fs: FirebaseFirestore.Firestore,
  name: string,
) {
  const snap = await fs.collection(name).get();
  const stats: Stats = {};
  const enumVals: Record<string, Record<string, number>> = {};
  for (const doc of snap.docs) {
    const d = doc.data();
    const walk = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        addField(stats, path, v);
        if (ENUM_FIELDS.has(k) && typeof v === "string") {
          enumVals[path] ??= {};
          enumVals[path][v] = (enumVals[path][v] ?? 0) + 1;
        }
        if (v && typeof v === "object" && !Array.isArray(v) &&
            typeof (v as { toDate?: unknown }).toDate !== "function") {
          walk(v as Record<string, unknown>, path);
        }
      }
    };
    walk(d, "");
  }
  console.log(`\n=== ${name}: ${snap.size} docs ===`);
  const fields = Object.keys(stats).sort();
  for (const f of fields) {
    const types = Object.entries(stats[f]).map(([t, n]) => `${t}:${n}`).join(" ");
    const presence = Object.values(stats[f]).reduce((a, b) => a + b, 0);
    console.log(`  ${f}  [${types}]  present in ${presence}/${snap.size}`);
  }
  for (const [f, vals] of Object.entries(enumVals)) {
    console.log(`  VALUES ${f}: ${JSON.stringify(vals)}`);
  }
}

async function main() {
  const { adminDb } = await import("../src/lib/firebase-admin");
  const fs = adminDb();
  for (const c of ["animals", "animalRegistrations", "admins"]) {
    await audit(fs, c);
  }
}

main().catch((e) => {
  console.error("audit failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
