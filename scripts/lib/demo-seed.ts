// Deterministic pre-launch board-demo dataset (#275).
//
// Every record here is fictional — names, contacts, chips, payments, and
// medical history are invented for the demo and use reserved example
// domains/phones. The dataset exists to make the REAL application feel
// lived-in for the SFPCA board: every major workflow (registry, annual
// registrations, payments, chips, medical, lost & found, data quality,
// reminders, CMS) gets enough representative rows to explore.
//
// Determinism: all dates derive from `asOf` (the seed date), so the same
// run always produces the same relative history and never looks stale.
// IDs are database-generated; the returned manifest records exactly
// what was written so status/reset can reason about it later.
//
// The applier writes through drizzle into the real schema — it never
// invents enum values or columns that don't exist.

import {
  animals,
  animalLifecycleEvents,
  auditEvents,
  authIdentities,
  clinicExpectations,
  communications,
  communicationPreferences,
  households,
  householdMembers,
  lostFoundCases,
  lostFoundUpdates,
  medicalAlerts,
  microchipConflicts,
  microchipRecords,
  ownerRequests,
  ownershipConfirmations,
  ownerships,
  paymentEvents,
  payments,
  persons,
  adminUsers,
  registrations,
  registrationSubmissions,
  vaccinations,
  vetDocuments,
  vetEncounters,
  vetMedications,
  vetProcedures,
  weightRecords,
  followUps,
} from "../../src/lib/db/schema";
import { normalizeChipNumber } from "../../src/lib/microchips";

// Bump whenever the dataset shape changes — recorded on the run so
// status can tell which seed generation is applied.
export const DEMO_SEED_VERSION = 1;

// The three demo accounts. Emails are deliberately on the reserved
// example.com domain — they can never be a real person's address, and
// the pre-launch email sink means they never receive anything anyway.
export const DEMO_ADMIN_EMAIL = "sfpca.demo.admin@example.com";
export const DEMO_OWNER_EMAIL = "sfpca.demo.owner@example.com";
export const DEMO_USER_EMAIL = "sfpca.demo.user@example.com";

export interface DemoSeedContext {
  // Firebase uids for the three demo accounts — the CLI creates the
  // Auth users first, then seeds identities against their real uids.
  adminUid: string;
  ownerUid: string;
  userUid: string;
  // Anchor "today" — every relative date derives from it (YYYY-MM-DD).
  asOf: string;
}

export interface DemoSeedManifestEntry {
  store: "postgres" | "firestore" | "storage" | "auth";
  table: string;
  id: string;
}

export interface DemoSeedResult {
  counts: Record<string, number>;
  entities: DemoSeedManifestEntry[];
}

function isoDaysAgo(asOf: string, days: number): string {
  const d = new Date(`${asOf}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoDaysAhead(asOf: string, days: number): string {
  return isoDaysAgo(asOf, -days);
}

function tsDaysAgo(asOf: string, days: number): Date {
  return new Date(`${isoDaysAgo(asOf, days)}T12:00:00Z`);
}



export async function applyDemoPostgresSeed(
  // The applier runs against the postgres-js drizzle instance in the CLI
  // and the PGlite instance in tests — typed loosely on purpose, the
  // schema objects carry the real types.
   
  db: any,
  ctx: DemoSeedContext,
): Promise<DemoSeedResult> {
  const manifest: DemoSeedManifestEntry[] = [];
  const counts: Record<string, number> = {};
  const year = Number(ctx.asOf.slice(0, 4));

  const track = (table: string, rows: { id?: string }[]) => {
    counts[table] = (counts[table] ?? 0) + rows.length;
    for (const row of rows) {
      if (row.id) {
        manifest.push({ store: "postgres", table, id: row.id });
      }
    }
  };

  // --- People & households ------------------------------------------------
  const [maria] = await db.insert(persons).values({
    fullName: "Maria Hendricks",
    email: "maria.hendricks@example.com",
    phone: "+599 416 2201",
    address: "Windwardside 14, Saba",
    preferredChannel: "email",
  }).returning();
  const [tom] = await db.insert(persons).values({
    fullName: "Tom Hendricks",
    email: "tom.hendricks@example.com",
    phone: "+599 416 2202",
    address: "Windwardside 14, Saba",
    preferredChannel: "whatsapp",
  }).returning();
  const [dorothy] = await db.insert(persons).values({
    fullName: "Dorothy Simmons",
    email: "dorothy.simmons@example.com",
    phone: "+599 416 3310",
    address: "The Bottom 7, Saba",
    preferredChannel: "email",
  }).returning();
  const [robert] = await db.insert(persons).values({
    fullName: "Robert Johnson",
    email: "robert.johnson@example.com",
    phone: "+599 416 5544",
    address: "St. Johns 22, Saba",
    preferredChannel: "email",
  }).returning();
  const [angela] = await db.insert(persons).values({
    fullName: "Angela van der Berg",
    // Deliberately incomplete: no email, partial phone — a data-quality
    // and reminder-exception example that is still perfectly valid.
    phone: "+599 41",
    address: "Hell's Gate 3, Saba",
  }).returning();
  const [pieter] = await db.insert(persons).values({
    fullName: "Pieter van der Berg",
    email: "pieter.vandenberg@example.com",
    address: "Hell's Gate 3, Saba",
  }).returning();
  // Duplicate-person candidate: same normalized name AND same phone as
  // maria — the detector flags the pair for review without any
  // constraint being violated.
  const [mariaDup] = await db.insert(persons).values({
    fullName: "Maria  Hendricks",
    email: "m.hendriks@example.net",
    phone: "+599 416 2201",
    address: "Windwardside, Saba",
    notes: "Imported from an older spreadsheet — probably Maria Hendricks.",
  }).returning();
  const [kevin] = await db.insert(persons).values({
    fullName: "Kevin Lopez",
    email: "kevin.lopez@example.com",
    phone: "+599 416 8890",
    address: "Flat Point 5, Saba",
  }).returning();
  const [elena] = await db.insert(persons).values({
    fullName: "Elena Marsh",
    email: "elena.marsh@example.com",
    phone: "+599 416 7712",
    address: "Windwardside 30, Saba",
  }).returning();
  // The person the demo owner portal account links to.
  const [demoOwner] = await db.insert(persons).values({
    fullName: "Demo Board Owner",
    email: DEMO_OWNER_EMAIL,
    phone: "+599 416 9000",
    address: "The Bottom 12, Saba",
    preferredChannel: "email",
  }).returning();
  const [demoStaff] = await db.insert(persons).values({
    fullName: "Demo Staff Member",
    email: DEMO_ADMIN_EMAIL,
  }).returning();
  track("persons", [maria, tom, dorothy, robert, angela, pieter, mariaDup, kevin, elena, demoOwner, demoStaff]);

  const [hendricksHouse] = await db.insert(households).values({
    name: "Hendricks Household",
    address: "Windwardside 14, Saba",
  }).returning();
  const [vanderbergHouse] = await db.insert(households).values({
    name: "Van der Berg Household",
    address: "Hell's Gate 3, Saba",
  }).returning();
  // Duplicate-household candidate: same normalized address as the
  // Hendricks household, no members — a classic split-record finding.
  const [hendricksDup] = await db.insert(households).values({
    name: "Hendricks Family",
    address: "windwardside 14, saba",
  }).returning();
  track("households", [hendricksHouse, vanderbergHouse, hendricksDup]);

  await db.insert(householdMembers).values([
    { householdId: hendricksHouse.id, personId: maria.id, role: "primary" },
    { householdId: hendricksHouse.id, personId: tom.id, role: "member" },
    { householdId: vanderbergHouse.id, personId: angela.id, role: "primary" },
    { householdId: vanderbergHouse.id, personId: pieter.id, role: "member" },
  ]);
  counts["household_members"] = 4;

  // --- Animals -------------------------------------------------------------
  // 18 animals chosen so every admin queue, public listing, and
  // lifecycle state has something real to show.
  const a = (v: Record<string, unknown>) => db.insert(animals).values(v).returning();

  const [biscuit] = await a({
    name: "Biscuit", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 4), birthDateEstimated: false,
    description: "Friendly island dog, good with children.",
    identifyingNotes: "White patch on chest, small scar on left ear.",
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 4),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
    sterilizedOn: isoDaysAgo(ctx.asOf, 365 * 3),
    sterilizedBy: "Dr. Example (visiting vet)",
  });
  const [biscuitDup] = await a({
    name: "Biscuit", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 4 + 10), birthDateEstimated: true,
    identifyingNotes: "Entered twice at intake — likely the same dog.",
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 200),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
  });
  const [clover] = await a({
    name: "Clover", species: "dog", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 2), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 2),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
    sterilizedOn: isoDaysAgo(ctx.asOf, 365),
    sterilizedBy: "SFPCA clinic",
  });
  const [pickles] = await a({
    name: "Pickles", species: "cat", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 3), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 3),
    adoptionStatus: "not-listed",
    sterilizationStatus: "intact",
  });
  const [mittens] = await a({
    name: "Mittens", species: "cat", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 6), birthDateEstimated: false,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 6),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
    sterilizedOn: isoDaysAgo(ctx.asOf, 365 * 5),
  });
  const [bruno] = await a({
    name: "Bruno", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 5), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 5),
    adoptionStatus: "not-listed",
    sterilizationStatus: "intact",
  });
  const [shadow] = await a({
    name: "Shadow", species: "dog", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 7), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 7),
    adoptionStatus: "not-listed",
    sterilizationStatus: "unknown",
  });
  const [nibbles] = await a({
    name: "Nibbles", species: "other", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 400), birthDateEstimated: true,
    identifyingNotes: "Rabbit, brown and white.",
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 400),
    adoptionStatus: "not-listed",
    sterilizationStatus: "unknown",
  });
  const [max] = await a({
    name: "Max", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 3), birthDateEstimated: true,
    description: "Tan mixed-breed dog, very friendly, answers to Max.",
    identifyingNotes: "Tan coat, black muzzle, blue collar.",
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 3),
    adoptionStatus: "not-listed",
    sterilizationStatus: "intact",
  });
  const [sunny] = await a({
    name: "Sunny", species: "dog", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 2), birthDateEstimated: false,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 2),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
    sterilizedOn: isoDaysAgo(ctx.asOf, 365),
  });
  const [mochi] = await a({
    name: "Mochi", species: "cat", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365),
    adoptionStatus: "not-listed",
    sterilizationStatus: "intact",
  });
  const [captain] = await a({
    name: "Captain", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 8), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 8),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
  });
  const [bella] = await a({
    name: "Bella", species: "dog", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 3), birthDateEstimated: true,
    description: "Gentle, well-socialized dog looking for a quiet home.",
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 120),
    adoptionStatus: "available",
    sterilizationStatus: "sterilized",
    sterilizedOn: isoDaysAgo(ctx.asOf, 60),
    sterilizedBy: "SFPCA clinic",
  });
  const [rusty] = await a({
    name: "Rusty", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 4), birthDateEstimated: true,
    description: "Energetic and loyal; loves long hikes on the trails.",
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 90),
    adoptionStatus: "available",
    sterilizationStatus: "intact",
  });
  const [duchess] = await a({
    name: "Duchess", species: "cat", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 5), birthDateEstimated: true,
    description: "Calm senior cat; needs regular medication.",
    identifyingNotes: "Grey longhair, very shy.",
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 75),
    adoptionStatus: "available",
    sterilizationStatus: "sterilized",
    sterilizedOn: isoDaysAgo(ctx.asOf, 50),
  });
  const [peanut] = await a({
    name: "Peanut", species: "cat", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 300), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 45),
    adoptionStatus: "pending",
    sterilizationStatus: "intact",
  });
  const [barnaby] = await a({
    name: "Barnaby", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 9), birthDateEstimated: true,
    lifecycleStatus: "active",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 365 * 4),
    adoptionStatus: "adopted",
    sterilizationStatus: "sterilized",
  });
  const [rexSr] = await a({
    name: "Rex Sr.", species: "dog", sex: "male",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 12), birthDateEstimated: true,
    lifecycleStatus: "deceased",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 100),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
  });
  const [ginger] = await a({
    name: "Ginger", species: "cat", sex: "female",
    birthDate: isoDaysAgo(ctx.asOf, 365 * 2), birthDateEstimated: true,
    lifecycleStatus: "moved-off-saba",
    lifecycleEffectiveOn: isoDaysAgo(ctx.asOf, 150),
    adoptionStatus: "not-listed",
    sterilizationStatus: "sterilized",
  });
  track("animals", [
    biscuit, biscuitDup, clover, pickles, mittens, bruno, shadow,
    nibbles, max, sunny, mochi, captain, bella, rusty, duchess,
    peanut, barnaby, rexSr, ginger,
  ]);

  // Lifecycle history for the two non-active animals — terminal states
  // close every open ownership interval in the same transaction the
  // transition writes.
  await db.insert(animalLifecycleEvents).values([
    {
      animalId: rexSr.id, fromStatus: "active", toStatus: "deceased",
      effectiveOn: isoDaysAgo(ctx.asOf, 100), source: "staff",
      reason: "Reported deceased by owner; confirmed.",
      actorLabel: "SFPCA Staff",
      createdAt: tsDaysAgo(ctx.asOf, 100),
    },
    {
      animalId: ginger.id, fromStatus: "active", toStatus: "moved-off-saba",
      effectiveOn: isoDaysAgo(ctx.asOf, 150), source: "staff",
      reason: "Owner relocated off-island with the cat.",
      actorLabel: "SFPCA Staff",
      createdAt: tsDaysAgo(ctx.asOf, 150),
    },
  ]);
  counts["animal_lifecycle_events"] = 2;

  // --- Ownership ------------------------------------------------------------
  const o = (v: Record<string, unknown>) => db.insert(ownerships).values(v).returning();
  const [biscuitOwn] = await o({ animalId: biscuit.id, householdId: hendricksHouse.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 4) });
  const [biscuitDupOwn] = await o({ animalId: biscuitDup.id, householdId: hendricksHouse.id, validFrom: isoDaysAgo(ctx.asOf, 200) });
  const [cloverOwn] = await o({ animalId: clover.id, householdId: hendricksHouse.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 2) });
  const [picklesOwn] = await o({ animalId: pickles.id, householdId: hendricksHouse.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 3) });
  const [mittensOwn] = await o({ animalId: mittens.id, personId: dorothy.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 6) });
  const [brunoOwn] = await o({ animalId: bruno.id, personId: robert.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 5) });
  const [shadowOwn] = await o({ animalId: shadow.id, householdId: vanderbergHouse.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 7) });
  const [nibblesOwn] = await o({ animalId: nibbles.id, householdId: vanderbergHouse.id, validFrom: isoDaysAgo(ctx.asOf, 400) });
  const [maxOwn] = await o({ animalId: max.id, personId: kevin.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 3) });
  const [sunnyOwn] = await o({ animalId: sunny.id, personId: demoOwner.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 2) });
  const [mochiOwn] = await o({ animalId: mochi.id, personId: demoOwner.id, validFrom: isoDaysAgo(ctx.asOf, 365) });
  // >1 year old with NO confirmations → 'confirmation-overdue' data
  // quality finding and an annual-confirmation reminder candidate.
  const [captainOwn] = await o({ animalId: captain.id, personId: demoOwner.id, validFrom: isoDaysAgo(ctx.asOf, 500) });
  const [barnabyOwn] = await o({ animalId: barnaby.id, personId: elena.id, validFrom: isoDaysAgo(ctx.asOf, 200) });
  await o({ animalId: rexSr.id, personId: robert.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 6), validTo: isoDaysAgo(ctx.asOf, 100), note: "Closed when Rex Sr. was reported deceased." });
  await o({ animalId: ginger.id, personId: elena.id, validFrom: isoDaysAgo(ctx.asOf, 365 * 2), validTo: isoDaysAgo(ctx.asOf, 150), note: "Closed when Ginger moved off-island." });
  track("ownerships", [biscuitOwn, biscuitDupOwn, cloverOwn, picklesOwn, mittensOwn, brunoOwn, shadowOwn, nibblesOwn, maxOwn, sunnyOwn, mochiOwn, captainOwn, barnabyOwn]);
  counts["ownerships"] = 15;

  // Ownership confirmations: Sunny recently confirmed (not due);
  // Captain never confirmed → overdue.
  await db.insert(ownershipConfirmations).values([
    {
      ownershipId: sunnyOwn.id, animalId: sunny.id, personId: demoOwner.id,
      confirmedOn: isoDaysAgo(ctx.asOf, 40), method: "staff",
      actorLabel: "SFPCA Staff",
      createdAt: tsDaysAgo(ctx.asOf, 40),
    },
    {
      ownershipId: mittensOwn.id, animalId: mittens.id, personId: dorothy.id,
      confirmedOn: isoDaysAgo(ctx.asOf, 200), method: "owner-portal",
      createdAt: tsDaysAgo(ctx.asOf, 200),
    },
  ]);
  counts["ownership_confirmations"] = 2;

  // --- Microchips -----------------------------------------------------------
  const chip = (num: string, display: string, manufacturer = "Datamars") => ({
    chipNumber: normalizeChipNumber(num),
    chipDisplay: display,
    manufacturer,
  });
  const [biscuitChip] = await db.insert(microchipRecords).values({
    ...chip("985 113 001 234 567", "985-113-001-234-567"),
    animalId: biscuit.id,
    implantedOn: isoDaysAgo(ctx.asOf, 365 * 3),
    implantedBy: "SFPCA clinic",
    assignedFrom: isoDaysAgo(ctx.asOf, 365 * 3),
  }).returning();
  const [cloverChip] = await db.insert(microchipRecords).values({
    ...chip("985 113 009 876 543", "985-113-009-876-543"),
    animalId: clover.id,
    assignedFrom: isoDaysAgo(ctx.asOf, 365 * 2),
  }).returning();
  const [mittensChip] = await db.insert(microchipRecords).values({
    ...chip("985 120 000 111 222", "985-120-000-111-222", "AVID"),
    animalId: mittens.id,
    assignedFrom: isoDaysAgo(ctx.asOf, 365 * 5),
  }).returning();
  const [brunoChip] = await db.insert(microchipRecords).values({
    ...chip("985 121 333 444 555", "985-121-333-444-555"),
    animalId: bruno.id,
    assignedFrom: isoDaysAgo(ctx.asOf, 365 * 4),
  }).returning();
  const [maxChip] = await db.insert(microchipRecords).values({
    ...chip("985 222 000 333 444", "985-222-000-333-444"),
    animalId: max.id,
    assignedFrom: isoDaysAgo(ctx.asOf, 365 * 3),
  }).returning();
  const [sunnyChip] = await db.insert(microchipRecords).values({
    ...chip("985 310 555 666 777", "985-310-555-666-777"),
    animalId: sunny.id,
    assignedFrom: isoDaysAgo(ctx.asOf, 365),
  }).returning();
  // A replaced chip: Duchess's old chip closed 'replaced' when the new
  // one was implanted — history is preserved, scans still resolve.
  const [duchessOldChip] = await db.insert(microchipRecords).values({
    ...chip("985 330 111 000 999", "985-330-111-000-999"),
    animalId: duchess.id,
    assignedFrom: isoDaysAgo(ctx.asOf, 365),
    assignedTo: isoDaysAgo(ctx.asOf, 50),
    closedReason: "replaced",
  }).returning();
  const [duchessChip] = await db.insert(microchipRecords).values({
    ...chip("985 330 222 111 000", "985-330-222-111-000"),
    animalId: duchess.id,
    implantedOn: isoDaysAgo(ctx.asOf, 50),
    implantedBy: "SFPCA clinic",
    assignedFrom: isoDaysAgo(ctx.asOf, 50),
  }).returning();
  track("microchip_records", [biscuitChip, cloverChip, mittensChip, brunoChip, maxChip, sunnyChip, duchessOldChip, duchessChip]);

  // An open chip conflict: the duplicate Biscuit record was scanned at
  // intake carrying Biscuit's chip — exactly the evidence a merge needs.
  const [chipConflict] = await db.insert(microchipConflicts).values({
    chipNumber: biscuitChip.chipNumber,
    claimedAnimalId: biscuitDup.id,
    existingRecordId: biscuitChip.id,
    existingAnimalId: biscuit.id,
    source: "staff",
    detail: "Scanner read the same chip on the duplicate Biscuit record at intake.",
  }).returning();
  track("microchip_conflicts", [chipConflict]);

  // --- Registration submissions ---------------------------------------------
  const [pendingSubWithReceipt] = await db.insert(registrationSubmissions).values({
    ownerName: "Susan Clarke",
    ownerAddress: "Windwardside 40, Saba",
    ownerPhone: "+599 416 1122",
    ownerEmail: "susan.clarke@example.com",
    animals: [
      { name: "Daisy", type: "dog", sex: "female", isFixed: true },
      { name: "Rocky", type: "dog", sex: "male", isFixed: false },
    ],
    receiptRequested: true,
    totalFeeCents: 11000,
    currency: "USD",
    status: "pending",
    submittedAt: tsDaysAgo(ctx.asOf, 2),
  }).returning();
  const [pendingSubNoReceipt] = await db.insert(registrationSubmissions).values({
    ownerName: "Mark Davis",
    ownerPhone: "+599 416 7788",
    animals: [
      { name: "Tiger", type: "cat", sex: "male", isFixed: false },
    ],
    receiptRequested: false,
    totalFeeCents: 10000,
    currency: "USD",
    status: "pending",
    submittedAt: tsDaysAgo(ctx.asOf, 6),
  }).returning();
  const [approvedSub] = await db.insert(registrationSubmissions).values({
    ownerName: "Dorothy Simmons",
    ownerEmail: "dorothy.simmons@example.com",
    ownerPhone: "+599 416 3310",
    animals: [{ name: "Mittens", type: "cat", sex: "female", isFixed: true }],
    personId: dorothy.id,
    receiptRequested: false,
    totalFeeCents: 1000,
    currency: "USD",
    status: "approved",
    submittedAt: tsDaysAgo(ctx.asOf, 60),
    decidedAt: tsDaysAgo(ctx.asOf, 58),
  }).returning();
  const [rejectedSub] = await db.insert(registrationSubmissions).values({
    ownerName: "Anonymous Submitter",
    animals: [{ name: "Unknown", type: "dog", sex: "unknown", isFixed: false }],
    receiptRequested: false,
    totalFeeCents: 10000,
    currency: "USD",
    status: "rejected",
    submittedAt: tsDaysAgo(ctx.asOf, 75),
    decidedAt: tsDaysAgo(ctx.asOf, 74),
  }).returning();
  track("registration_submissions", [pendingSubWithReceipt, pendingSubNoReceipt, approvedSub, rejectedSub]);

  // --- Registrations + payments ----------------------------------------------
  // Year-period helpers: current year rows and prior-year history.
  const reg = (v: Record<string, unknown>) => db.insert(registrations).values(v).returning();
  const pay = (v: Record<string, unknown>) => db.insert(payments).values(v).returning();

  const [biscuitReg26] = await reg({
    animalId: biscuit.id, year, status: "active",
    ownershipId: biscuitOwn.id, householdId: hendricksHouse.id,
    ownerLabel: "Hendricks Household",
    submittedAt: tsDaysAgo(ctx.asOf, 45), registeredAt: tsDaysAgo(ctx.asOf, 44),
    amountDueCents: 1000, currency: "USD",
  });
  const [biscuitPay] = await pay({
    registrationId: biscuitReg26.id, personId: maria.id,
    amountCents: 1000, currency: "USD", kind: "payment",
    status: "confirmed", method: "bank-transfer", source: "staff",
    reference: "BT-2026-0441", recordedBy: "SFPCA Staff",
    occurredAt: tsDaysAgo(ctx.asOf, 43),
  });
  const [biscuitReg25] = await reg({
    animalId: biscuit.id, year: year - 1, status: "active",
    ownershipId: biscuitOwn.id, householdId: hendricksHouse.id,
    ownerLabel: "Hendricks Household",
    submittedAt: tsDaysAgo(ctx.asOf, 400), registeredAt: tsDaysAgo(ctx.asOf, 399),
    amountDueCents: 1000, currency: "USD",
  });
  const [biscuitPay25] = await pay({
    registrationId: biscuitReg25.id, personId: maria.id,
    amountCents: 1000, currency: "USD", kind: "payment",
    status: "confirmed", method: "cash", source: "staff",
    recordedBy: "SFPCA Staff", occurredAt: tsDaysAgo(ctx.asOf, 398),
  });

  const [cloverReg26] = await reg({
    animalId: clover.id, year, status: "active",
    ownershipId: cloverOwn.id, householdId: hendricksHouse.id,
    ownerLabel: "Hendricks Household",
    submittedAt: tsDaysAgo(ctx.asOf, 45), registeredAt: tsDaysAgo(ctx.asOf, 44),
    amountDueCents: 1000, currency: "USD",
  });
  const [cloverPay] = await pay({
    registrationId: cloverReg26.id, personId: maria.id,
    amountCents: 1000, currency: "USD", kind: "payment",
    status: "confirmed", method: "cash", source: "staff",
    recordedBy: "SFPCA Staff", occurredAt: tsDaysAgo(ctx.asOf, 42),
  });
  // Partial refund on Clover — the derived balance is what the UI shows.
  const [cloverRefund] = await pay({
    registrationId: cloverReg26.id, personId: maria.id,
    amountCents: 500, currency: "USD", kind: "refund",
    status: "confirmed", method: "cash", source: "staff",
    relatedPaymentId: cloverPay.id, recordedBy: "SFPCA Staff",
    note: "Partial refund — overcharged at intake.",
    occurredAt: tsDaysAgo(ctx.asOf, 38),
  });
  const [cloverReg25] = await reg({
    animalId: clover.id, year: year - 1, status: "active",
    ownershipId: cloverOwn.id, householdId: hendricksHouse.id,
    ownerLabel: "Hendricks Household",
    submittedAt: tsDaysAgo(ctx.asOf, 395), registeredAt: tsDaysAgo(ctx.asOf, 394),
    amountDueCents: 1000, currency: "USD",
  });

  // Pickles: registered, full $100 still owed — the unpaid queue.
  const [picklesReg26] = await reg({
    animalId: pickles.id, year, status: "active",
    ownershipId: picklesOwn.id, householdId: hendricksHouse.id,
    ownerLabel: "Hendricks Household",
    submittedAt: tsDaysAgo(ctx.asOf, 45), registeredAt: tsDaysAgo(ctx.asOf, 44),
    amountDueCents: 10000, currency: "USD",
  });

  const [mittensReg26] = await reg({
    animalId: mittens.id, year, status: "active",
    ownershipId: mittensOwn.id, personId: dorothy.id,
    ownerLabel: "Dorothy Simmons",
    submittedAt: tsDaysAgo(ctx.asOf, 60), registeredAt: tsDaysAgo(ctx.asOf, 58),
    amountDueCents: 1000, currency: "USD",
  });
  const [mittensPay] = await pay({
    registrationId: mittensReg26.id, personId: dorothy.id,
    amountCents: 1000, currency: "USD", kind: "payment",
    status: "confirmed", method: "bank-transfer", source: "staff",
    reference: "BT-2026-0402", recordedBy: "SFPCA Staff",
    occurredAt: tsDaysAgo(ctx.asOf, 57),
  });
  const [mittensReg25] = await reg({
    animalId: mittens.id, year: year - 1, status: "active",
    ownershipId: mittensOwn.id, personId: dorothy.id,
    ownerLabel: "Dorothy Simmons",
    submittedAt: tsDaysAgo(ctx.asOf, 420), registeredAt: tsDaysAgo(ctx.asOf, 419),
    amountDueCents: 1000, currency: "USD",
  });
  const [mittensReg24] = await reg({
    animalId: mittens.id, year: year - 2, status: "active",
    ownershipId: mittensOwn.id, personId: dorothy.id,
    ownerLabel: "Dorothy Simmons",
    submittedAt: tsDaysAgo(ctx.asOf, 780), registeredAt: tsDaysAgo(ctx.asOf, 779),
    amountDueCents: 1000, currency: "USD",
  });

  // Bruno: registered, unpaid, and a FAILED payment attempt on the ledger.
  const [brunoReg26] = await reg({
    animalId: bruno.id, year, status: "active",
    ownershipId: brunoOwn.id, personId: robert.id,
    ownerLabel: "Robert Johnson",
    submittedAt: tsDaysAgo(ctx.asOf, 30), registeredAt: tsDaysAgo(ctx.asOf, 29),
    amountDueCents: 10000, currency: "USD",
  });
  const [brunoFailedPay] = await pay({
    registrationId: brunoReg26.id, personId: robert.id,
    amountCents: 10000, currency: "USD", kind: "payment",
    status: "failed", method: "bank-transfer", source: "staff",
    reference: "BT-2026-0510", recordedBy: "SFPCA Staff",
    note: "Transfer never arrived; marked failed after follow-up.",
    occurredAt: tsDaysAgo(ctx.asOf, 27),
  });

  const [shadowReg25] = await reg({
    animalId: shadow.id, year: year - 1, status: "active",
    ownershipId: shadowOwn.id, householdId: vanderbergHouse.id,
    ownerLabel: "Van der Berg Household",
    submittedAt: tsDaysAgo(ctx.asOf, 380), registeredAt: tsDaysAgo(ctx.asOf, 379),
    amountDueCents: 10000, currency: "USD",
  });
  const [shadowPay25] = await pay({
    registrationId: shadowReg25.id, personId: angela.id,
    amountCents: 10000, currency: "USD", kind: "payment",
    status: "confirmed", method: "cash", source: "staff",
    recordedBy: "SFPCA Staff", occurredAt: tsDaysAgo(ctx.asOf, 378),
  });

  const [maxReg26] = await reg({
    animalId: max.id, year, status: "active",
    ownershipId: maxOwn.id, personId: kevin.id,
    ownerLabel: "Kevin Lopez",
    submittedAt: tsDaysAgo(ctx.asOf, 20), registeredAt: tsDaysAgo(ctx.asOf, 19),
    amountDueCents: 10000, currency: "USD",
  });

  const [sunnyReg26] = await reg({
    animalId: sunny.id, year, status: "active",
    ownershipId: sunnyOwn.id, personId: demoOwner.id,
    ownerLabel: "Demo Board Owner",
    submittedAt: tsDaysAgo(ctx.asOf, 35), registeredAt: tsDaysAgo(ctx.asOf, 34),
    amountDueCents: 1000, currency: "USD",
  });
  const [sunnyPay] = await pay({
    registrationId: sunnyReg26.id, personId: demoOwner.id,
    amountCents: 1000, currency: "USD", kind: "payment",
    status: "confirmed", method: "cash", source: "staff",
    recordedBy: "SFPCA Staff", occurredAt: tsDaysAgo(ctx.asOf, 33),
  });

  // Mochi: unpaid with a small adjustment on the ledger.
  const [mochiReg26] = await reg({
    animalId: mochi.id, year, status: "active",
    ownershipId: mochiOwn.id, personId: demoOwner.id,
    ownerLabel: "Demo Board Owner",
    submittedAt: tsDaysAgo(ctx.asOf, 35), registeredAt: tsDaysAgo(ctx.asOf, 34),
    amountDueCents: 10000, currency: "USD",
  });
  const [mochiAdjust] = await pay({
    registrationId: mochiReg26.id, personId: demoOwner.id,
    amountCents: 500, currency: "USD", kind: "adjustment",
    status: "confirmed", method: "other", source: "staff",
    recordedBy: "SFPCA Staff",
    note: "Manual correction — fee initially misquoted at intake.",
    occurredAt: tsDaysAgo(ctx.asOf, 33),
  });

  // Captain: prior-year registration resolved 'complimentary' — a
  // resolution, never a $0 payment.
  const [captainReg25] = await reg({
    animalId: captain.id, year: year - 1, status: "active",
    ownershipId: captainOwn.id, personId: demoOwner.id,
    ownerLabel: "Demo Board Owner",
    submittedAt: tsDaysAgo(ctx.asOf, 390), registeredAt: tsDaysAgo(ctx.asOf, 389),
    amountDueCents: 1000, currency: "USD",
    resolution: "complimentary",
    resolutionNote: "Rescue intake — fee waived under the rescue policy.",
    resolvedAt: tsDaysAgo(ctx.asOf, 389),
    resolvedBy: "SFPCA Staff",
  });

  const [barnabyReg25] = await reg({
    animalId: barnaby.id, year: year - 1, status: "active",
    ownershipId: barnabyOwn.id, personId: elena.id,
    ownerLabel: "Elena Marsh",
    submittedAt: tsDaysAgo(ctx.asOf, 385), registeredAt: tsDaysAgo(ctx.asOf, 384),
    amountDueCents: 1000, currency: "USD",
  });

  // Rex Sr.: a current-year row cancelled 'withdrawn' after he died —
  // the cancelled-registration display state.
  const [rexReg26] = await reg({
    animalId: rexSr.id, year, status: "cancelled",
    ownershipId: null, personId: robert.id,
    ownerLabel: "Robert Johnson",
    submittedAt: tsDaysAgo(ctx.asOf, 120), registeredAt: tsDaysAgo(ctx.asOf, 119),
    amountDueCents: 1000, currency: "USD",
    cancelledAt: tsDaysAgo(ctx.asOf, 100),
    cancellationReason: "withdrawn",
    cancellationNote: "Animal reported deceased mid-period.",
  });

  const allRegs = [
    biscuitReg26, biscuitReg25, cloverReg26, cloverReg25, picklesReg26,
    mittensReg26, mittensReg25, mittensReg24, brunoReg26, shadowReg25,
    maxReg26, sunnyReg26, mochiReg26, captainReg25, barnabyReg25, rexReg26,
  ];
  track("registrations", allRegs);

  const allPays = [
    biscuitPay, biscuitPay25, cloverPay, cloverRefund, mittensPay,
    shadowPay25, sunnyPay, mochiAdjust, brunoFailedPay,
  ];
  track("payments", allPays);

  // Ledger events — every money movement leaves its audit row.
  await db.insert(paymentEvents).values([
    { paymentId: biscuitPay.id, event: "recorded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 43) },
    { paymentId: biscuitPay.id, event: "confirmed", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 43) },
    { paymentId: biscuitPay25.id, event: "recorded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 398) },
    { paymentId: biscuitPay25.id, event: "confirmed", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 398) },
    { paymentId: cloverPay.id, event: "recorded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 42) },
    { paymentId: cloverPay.id, event: "confirmed", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 42) },
    { paymentId: cloverRefund.id, event: "refunded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 38) },
    { paymentId: mittensPay.id, event: "recorded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 57) },
    { paymentId: mittensPay.id, event: "confirmed", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 57) },
    { paymentId: shadowPay25.id, event: "recorded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 378) },
    { paymentId: shadowPay25.id, event: "confirmed", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 378) },
    { paymentId: sunnyPay.id, event: "recorded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 33) },
    { paymentId: sunnyPay.id, event: "confirmed", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 33) },
    { paymentId: mochiAdjust.id, event: "adjusted", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 33) },
    { paymentId: brunoFailedPay.id, event: "recorded", actorLabel: "SFPCA Staff", createdAt: tsDaysAgo(ctx.asOf, 28) },
    { paymentId: brunoFailedPay.id, event: "failed", actorLabel: "SFPCA Staff", detail: { reason: "transfer-not-received" }, createdAt: tsDaysAgo(ctx.asOf, 27) },
  ]);
  counts["payment_events"] = 16;

  // --- Lost & found -----------------------------------------------------------
  const [maxCase] = await db.insert(lostFoundCases).values({
    caseType: "missing", status: "open",
    animalId: max.id,
    reportedAt: tsDaysAgo(ctx.asOf, 5),
    reportedVia: "owner-portal",
    reporterName: "Kevin Lopez",
    reporterContact: "kevin.lopez@example.com",
    lastSeenOn: isoDaysAgo(ctx.asOf, 5),
    lastSeenLocation: "Windwardside, near the Mount Scenery trailhead",
    description: "Tan male dog, blue collar, very friendly.",
    chipNumber: maxChip.chipNumber,
    chipDisplay: maxChip.chipDisplay,
    microchipRecordId: maxChip.id,
    publishedAt: tsDaysAgo(ctx.asOf, 5),
    publishedBy: "SFPCA Staff",
    publicNote: "Friendly tan dog named Max — please report sightings to SFPCA.",
    actorLabel: "SFPCA Staff",
  }).returning();
  const [biscuitCase] = await db.insert(lostFoundCases).values({
    caseType: "missing", status: "resolved",
    animalId: biscuit.id,
    reportedAt: tsDaysAgo(ctx.asOf, 40),
    reportedVia: "staff",
    reporterName: "Maria Hendricks",
    reporterContact: "+599 416 2201",
    lastSeenOn: isoDaysAgo(ctx.asOf, 40),
    lastSeenLocation: "Windwardside 14",
    description: "White patch on chest.",
    publishedAt: tsDaysAgo(ctx.asOf, 40),
    publishedBy: "SFPCA Staff",
    publicNote: "Missing dog in Windwardside.",
    resolvedAt: tsDaysAgo(ctx.asOf, 35),
    resolvedBy: "SFPCA Staff",
    outcome: "reunited",
    resolutionNote: "Found by a neighbor two streets over and returned.",
    actorLabel: "SFPCA Staff",
  }).returning();
  const [strayCase] = await db.insert(lostFoundCases).values({
    caseType: "found", status: "open",
    reportedAt: tsDaysAgo(ctx.asOf, 2),
    reportedVia: "staff",
    reporterName: "Member of public",
    reporterContact: "+599 416 0000",
    foundOn: isoDaysAgo(ctx.asOf, 2),
    foundLocation: "The Bottom, near the market",
    description: "Tabby cat, orange collar, no chip read on first scan.",
    chipNumber: "981020999888",
    chipDisplay: "981-020-999-888",
    notes: "Holding at the clinic; re-scan planned.",
    actorLabel: "SFPCA Staff",
  }).returning();
  track("lost_found_cases", [maxCase, biscuitCase, strayCase]);

  await db.insert(lostFoundUpdates).values([
    {
      caseId: maxCase.id, kind: "sighting",
      occurredAt: tsDaysAgo(ctx.asOf, 3),
      location: "Crispeen trail, lower section",
      note: "Caller reports a tan dog matching Max's description heading downhill.",
      reporterName: "Hiker (anonymous)",
      source: "public",
      createdAt: tsDaysAgo(ctx.asOf, 3),
    },
    {
      caseId: maxCase.id, kind: "sighting",
      occurredAt: tsDaysAgo(ctx.asOf, 1),
      location: "Windwardside, Booby Hill road",
      note: "Second sighting — same direction of travel.",
      reporterName: "Local resident",
      reporterContact: "+599 416 0001",
      source: "public",
      createdAt: tsDaysAgo(ctx.asOf, 1),
    },
    {
      caseId: maxCase.id, kind: "update",
      occurredAt: tsDaysAgo(ctx.asOf, 1),
      note: "Flyers posted at the trailhead; vet clinics notified.",
      source: "staff",
      actorLabel: "SFPCA Staff",
      createdAt: tsDaysAgo(ctx.asOf, 1),
    },
    {
      caseId: biscuitCase.id, kind: "sighting",
      occurredAt: tsDaysAgo(ctx.asOf, 36),
      location: "Windwardside 21",
      note: "Spotted in a neighbor's yard.",
      source: "staff",
      actorLabel: "SFPCA Staff",
      createdAt: tsDaysAgo(ctx.asOf, 36),
    },
    {
      caseId: biscuitCase.id, kind: "update",
      occurredAt: tsDaysAgo(ctx.asOf, 35),
      note: "Owner collected him — reunited.",
      source: "staff",
      actorLabel: "SFPCA Staff",
      createdAt: tsDaysAgo(ctx.asOf, 35),
    },
  ]);
  counts["lost_found_updates"] = 5;

  // --- Medical -----------------------------------------------------------------
  const [biscuitVisit1] = await db.insert(vetEncounters).values({
    animalId: biscuit.id, kind: "visit",
    occurredOn: isoDaysAgo(ctx.asOf, 200),
    provider: "Dr. Example (visiting vet)",
    reason: "Annual checkup",
    complaint: "None — routine exam.",
    findings: "Healthy, good body condition.",
    assessment: "No concerns.",
    plan: "Continue current care; next visit in a year.",
  }).returning();
  const [biscuitVisit2] = await db.insert(vetEncounters).values({
    animalId: biscuit.id, kind: "visit",
    occurredOn: isoDaysAgo(ctx.asOf, 50),
    provider: "SFPCA clinic",
    reason: "Dental cleaning + checkup",
    complaint: "Mild tartar noted by owner.",
    findings: "Moderate tartar; gums otherwise healthy.",
    assessment: "Dental disease grade 1.",
    plan: "Dental cleaning performed; recheck in 3 months.",
  }).returning();
  const [duchessVisit] = await db.insert(vetEncounters).values({
    animalId: duchess.id, kind: "visit",
    occurredOn: isoDaysAgo(ctx.asOf, 30),
    provider: "SFPCA clinic",
    reason: "Skin condition flare-up",
    complaint: "Overgrooming and hair loss on flanks.",
    findings: "Eosinophilic dermatitis suspected.",
    assessment: "Allergic dermatitis — penicillin allergy on file.",
    plan: "Start prednisolone course; recheck in 2 weeks.",
  }).returning();
  const [captainVisit] = await db.insert(vetEncounters).values({
    animalId: captain.id, kind: "visit",
    occurredOn: isoDaysAgo(ctx.asOf, 400),
    provider: "SFPCA clinic",
    reason: "Senior wellness exam",
    findings: "Mild arthritis in hips; otherwise well for age.",
    plan: "Weight management; review vaccination status.",
  }).returning();
  const [bellaIntake] = await db.insert(vetEncounters).values({
    animalId: bella.id, kind: "visit",
    occurredOn: isoDaysAgo(ctx.asOf, 110),
    provider: "SFPCA clinic",
    reason: "Intake exam",
    findings: "Underweight, otherwise healthy.",
    plan: "Spay scheduled; begin vaccination series.",
  }).returning();
  const [maxIntake] = await db.insert(vetEncounters).values({
    animalId: max.id, kind: "history",
    occurredOn: isoDaysAgo(ctx.asOf, 900),
    provider: null,
    reason: "Owner-reported history",
    notes: "Owner reports Max was vaccinated before coming to Saba; no records available.",
  }).returning();
  track("vet_encounters", [biscuitVisit1, biscuitVisit2, duchessVisit, captainVisit, bellaIntake, maxIntake]);

  const [biscuitNeuter] = await db.insert(vetProcedures).values({
    animalId: biscuit.id, kind: "neuter",
    performedOn: isoDaysAgo(ctx.asOf, 365 * 3),
    provider: "Dr. Example (visiting vet)",
    description: "Routine castration.",
    notes: "Unremarkable recovery.",
  }).returning();
  const [biscuitDental] = await db.insert(vetProcedures).values({
    animalId: biscuit.id, encounterId: biscuitVisit2.id, kind: "dental",
    performedOn: isoDaysAgo(ctx.asOf, 50),
    provider: "SFPCA clinic",
    description: "Scale and polish.",
  }).returning();
  const [duchessSpay] = await db.insert(vetProcedures).values({
    animalId: duchess.id, kind: "spay",
    performedOn: isoDaysAgo(ctx.asOf, 50),
    provider: "SFPCA clinic",
    description: "Ovariohysterectomy.",
    notes: "Recovering well.",
  }).returning();
  track("vet_procedures", [biscuitNeuter, biscuitDental, duchessSpay]);

  const [duchessMed] = await db.insert(vetMedications).values({
    animalId: duchess.id, encounterId: duchessVisit.id,
    medication: "Prednisolone", dose: "5 mg", route: "oral",
    frequency: "once daily",
    startOn: isoDaysAgo(ctx.asOf, 30), endOn: isoDaysAhead(ctx.asOf, 12),
    instructions: "Give with food.",
    prescribedBy: "SFPCA clinic",
  }).returning();
  const [biscuitMed] = await db.insert(vetMedications).values({
    animalId: biscuit.id, encounterId: biscuitVisit2.id,
    medication: "Amoxicillin", dose: "250 mg", route: "oral",
    frequency: "BID",
    startOn: isoDaysAgo(ctx.asOf, 50), endOn: isoDaysAgo(ctx.asOf, 36),
    prescribedBy: "SFPCA clinic",
  }).returning();
  track("vet_medications", [duchessMed, biscuitMed]);

  const [duchessAlert] = await db.insert(medicalAlerts).values({
    animalId: duchess.id, encounterId: duchessVisit.id,
    kind: "allergy", severity: "critical",
    summary: "Penicillin allergy",
    details: "Anaphylactic reaction documented — never administer penicillins.",
    status: "active",
    recordedOn: isoDaysAgo(ctx.asOf, 30),
  }).returning();
  const [biscuitAlert] = await db.insert(medicalAlerts).values({
    animalId: biscuit.id,
    kind: "condition", severity: "info",
    summary: "Mild dental disease",
    status: "resolved",
    recordedOn: isoDaysAgo(ctx.asOf, 200),
    resolvedOn: isoDaysAgo(ctx.asOf, 50),
  }).returning();
  track("medical_alerts", [duchessAlert, biscuitAlert]);

  await db.insert(weightRecords).values([
    { animalId: biscuit.id, measuredOn: isoDaysAgo(ctx.asOf, 365 * 2), weightGrams: 18400 },
    { animalId: biscuit.id, encounterId: biscuitVisit1.id, measuredOn: isoDaysAgo(ctx.asOf, 200), weightGrams: 19100 },
    { animalId: biscuit.id, encounterId: biscuitVisit2.id, measuredOn: isoDaysAgo(ctx.asOf, 50), weightGrams: 18900, notes: "Stable" },
    { animalId: duchess.id, encounterId: duchessVisit.id, measuredOn: isoDaysAgo(ctx.asOf, 30), weightGrams: 3900 },
    { animalId: bella.id, encounterId: bellaIntake.id, measuredOn: isoDaysAgo(ctx.asOf, 110), weightGrams: 14200, notes: "Underweight at intake" },
    { animalId: captain.id, encounterId: captainVisit.id, measuredOn: isoDaysAgo(ctx.asOf, 400), weightGrams: 27500 },
  ]);
  counts["weight_records"] = 6;

  // Vaccinations: a spread of current / due-soon / overdue states so the
  // reminder pipeline and the admin queues have real candidates.
  const vax = (
    animal: { id: string },
    name: string,
    administeredDaysAgo: number,
    dueDaysOffset: number,
    extra: Record<string, unknown> = {},
  ) => db.insert(vaccinations).values({
    animalId: animal.id,
    vaccineName: name,
    administeredOn: isoDaysAgo(ctx.asOf, administeredDaysAgo),
    dueOn: dueDaysOffset === 0 ? null : isoDaysAhead(ctx.asOf, dueDaysOffset),
    ...extra,
  }).returning();

  const [biscuitRabies] = await vax(biscuit, "Rabies", 340, 25, { administeredBy: "SFPCA clinic", lotNumber: "RBX-118" });
  await vax(biscuit, "DHPP", 340, 25, { administeredBy: "SFPCA clinic" });
  const [cloverRabies] = await vax(clover, "Rabies", 355, 10, { administeredBy: "SFPCA clinic" });
  const [mittensFvrcp] = await vax(mittens, "FVRCP", 360, 5, { administeredBy: "Dr. Example (visiting vet)" });
  const [captainRabies] = await vax(captain, "Rabies", 385, -20, { administeredBy: "SFPCA clinic" });
  const [bellaRabies] = await vax(bella, "Rabies", 100, 265, { administeredBy: "SFPCA clinic" });
  const [bellaDhpp] = await vax(bella, "DHPP", 100, 265, { administeredBy: "SFPCA clinic" });
  const [duchessFvrcp] = await vax(duchess, "FVRCP", 80, 285, { administeredBy: "SFPCA clinic" });
  const [sunnyRabies] = await vax(sunny, "Rabies", 200, 165, { administeredBy: "SFPCA clinic" });
  const [maxRabies] = await vax(max, "Rabies", 400, -35, { administeredBy: "SFPCA clinic" });
  track("vaccinations", [biscuitRabies, cloverRabies, mittensFvrcp, captainRabies, bellaRabies, bellaDhpp, duchessFvrcp, sunnyRabies, maxRabies]);
  counts["vaccinations"] = 10;

  const [duchessDoc] = await db.insert(vetDocuments).values({
    animalId: duchess.id, encounterId: duchessVisit.id,
    storagePath: "vet-docs/demo-vaccination-certificate.pdf",
    label: "Vaccination certificate (demo)",
    notes: "Demo document — fictional.",
    uploadedBy: "SFPCA Staff",
  }).returning();
  track("vet_documents", [duchessDoc]);

  // --- Operational queues -----------------------------------------------------
  const [picklesFollowUp] = await db.insert(followUps).values({
    animalId: pickles.id, personId: maria.id,
    registrationId: picklesReg26.id,
    kind: "recheck",
    reason: "Dental recheck",
    dueOn: isoDaysAhead(ctx.asOf, 3),
    status: "open",
  }).returning();
  const [duchessFollowUp] = await db.insert(followUps).values({
    animalId: duchess.id,
    encounterId: duchessVisit.id,
    kind: "recheck",
    reason: "Recheck dermatitis",
    dueOn: isoDaysAgo(ctx.asOf, 7),
    status: "open",
    notes: "Overdue — was due last week.",
  }).returning();
  const [biscuitFollowUp] = await db.insert(followUps).values({
    animalId: biscuit.id, personId: maria.id,
    encounterId: biscuitVisit2.id,
    kind: "recheck",
    reason: "Post-dental recheck",
    dueOn: isoDaysAgo(ctx.asOf, 20),
    status: "completed",
    resolvedAt: tsDaysAgo(ctx.asOf, 19),
  }).returning();
  track("follow_ups", [picklesFollowUp, duchessFollowUp, biscuitFollowUp]);

  const [sunnyExpected] = await db.insert(clinicExpectations).values({
    animalId: sunny.id, personId: demoOwner.id,
    expectedOn: isoDaysAhead(ctx.asOf, 1),
    sessionLabel: "Saturday AM clinic",
    reason: "Rabies vaccination",
    status: "expected",
  }).returning();
  const [bellaSeen] = await db.insert(clinicExpectations).values({
    animalId: bella.id,
    expectedOn: isoDaysAgo(ctx.asOf, 10),
    reason: "Spay recheck",
    status: "seen",
    resolvedAt: tsDaysAgo(ctx.asOf, 10),
  }).returning();
  const [brunoNoShow] = await db.insert(clinicExpectations).values({
    animalId: bruno.id, personId: robert.id,
    expectedOn: isoDaysAgo(ctx.asOf, 4),
    reason: "Vaccination visit",
    status: "no_show",
    resolvedAt: tsDaysAgo(ctx.asOf, 4),
  }).returning();
  track("clinic_expectations", [sunnyExpected, bellaSeen, brunoNoShow]);

  // --- Owner requests ----------------------------------------------------------
  const [transferReq] = await db.insert(ownerRequests).values({
    kind: "transfer",
    personId: dorothy.id,
    animalId: mittens.id,
    ownershipId: mittensOwn.id,
    detail: "My neighbour is taking Mittens while I am off-island for six months.",
    payload: { transferTarget: "Susan Clarke, Windwardside" },
    status: "pending",
    createdAt: tsDaysAgo(ctx.asOf, 3),
  }).returning();
  const [resolvedReq] = await db.insert(ownerRequests).values({
    kind: "lifecycle-deceased",
    personId: robert.id,
    animalId: rexSr.id,
    detail: "Rex passed away at home.",
    status: "approved",
    resolutionNote: "Confirmed and lifecycle transitioned.",
    resolvedBy: "SFPCA Staff",
    resolvedAt: tsDaysAgo(ctx.asOf, 100),
    createdAt: tsDaysAgo(ctx.asOf, 102),
  }).returning();
  track("owner_requests", [transferReq, resolvedReq]);

  // --- Communications ledger -----------------------------------------------------
  const [commDelivered] = await db.insert(communications).values({
    personId: dorothy.id, animalId: mittens.id,
    channel: "email", kind: "vaccination-reminder", status: "delivered",
    idempotencyKey: `vax-reminder:${mittensFvrcp.id}:${mittensFvrcp.dueOn}:reminder-1`,
    relatedType: "vaccination", relatedId: mittensFvrcp.id,
    cycleKey: mittensFvrcp.dueOn, touch: "reminder-1",
    recipient: "dorothy.simmons@example.com",
    subject: "Vaccination reminder for Mittens",
    bodyText: "Mittens' FVRCP vaccination is due soon. (demo content)",
    provider: "demo-sink",
    attempts: 1,
    sentAt: tsDaysAgo(ctx.asOf, 10),
    deliveredAt: tsDaysAgo(ctx.asOf, 10),
    lastAttemptAt: tsDaysAgo(ctx.asOf, 10),
    createdAt: tsDaysAgo(ctx.asOf, 10),
  }).returning();
  const [commFailed] = await db.insert(communications).values({
    personId: robert.id, animalId: bruno.id,
    channel: "email", kind: "registration-payment-reminder", status: "failed",
    idempotencyKey: `reg-pay:${brunoReg26.id}:${year}:reminder-1`,
    relatedType: "registration", relatedId: brunoReg26.id,
    cycleKey: String(year), touch: "reminder-1",
    recipient: "robert.johnson@example.com",
    subject: "Registration balance for Bruno",
    bodyText: "Bruno's registration has an outstanding balance. (demo content)",
    provider: "demo-sink",
    attempts: 3,
    detail: "bounced",
    sentAt: tsDaysAgo(ctx.asOf, 15),
    lastAttemptAt: tsDaysAgo(ctx.asOf, 13),
    createdAt: tsDaysAgo(ctx.asOf, 15),
  }).returning();
  const [commSkipped] = await db.insert(communications).values({
    personId: angela.id, animalId: shadow.id,
    channel: "email", kind: "annual-confirmation-reminder", status: "skipped",
    idempotencyKey: `confirm-reminder:${shadowOwn.id}:${year}:skip:no-email`,
    relatedType: "ownership", relatedId: shadowOwn.id,
    cycleKey: String(year), touch: "skip:no-email",
    detail: "no-email",
    createdAt: tsDaysAgo(ctx.asOf, 12),
  }).returning();
  const [commQueued] = await db.insert(communications).values({
    personId: demoOwner.id, animalId: captain.id,
    channel: "email", kind: "annual-confirmation-reminder", status: "queued",
    idempotencyKey: `confirm-reminder:${captainOwn.id}:${year}:reminder-1`,
    relatedType: "ownership", relatedId: captainOwn.id,
    cycleKey: String(year), touch: "reminder-1",
    recipient: DEMO_OWNER_EMAIL,
    subject: "Annual confirmation for Captain",
    bodyText: "Please confirm Captain is still in your care. (demo content)",
    createdAt: tsDaysAgo(ctx.asOf, 1),
  }).returning();
  track("communications", [commDelivered, commFailed, commSkipped, commQueued]);

  await db.insert(communicationPreferences).values({
    personId: dorothy.id,
    channel: "email", kind: "vaccination-reminder",
    optedOut: true,
    actorLabel: "Dorothy Simmons",
    createdAt: tsDaysAgo(ctx.asOf, 5),
  });
  counts["communication_preferences"] = 1;

  // --- Identities, admin, audit ---------------------------------------------------
  await db.insert(adminUsers).values({
    email: DEMO_ADMIN_EMAIL, role: "admin", personId: demoStaff.id,
  });
  counts["admin_users"] = (counts["admin_users"] ?? 0) + 1;

  const identities = await db.insert(authIdentities).values([
    { provider: "firebase", providerUid: ctx.adminUid, email: DEMO_ADMIN_EMAIL, personId: demoStaff.id },
    { provider: "firebase", providerUid: ctx.ownerUid, email: DEMO_OWNER_EMAIL, personId: demoOwner.id },
    { provider: "firebase", providerUid: ctx.userUid, email: DEMO_USER_EMAIL },
  ]).returning();
  track("auth_identities", identities);

  await db.insert(auditEvents).values([
    { actorLabel: "SFPCA Staff", entityType: "animal", entityId: biscuit.id, action: "create", createdAt: tsDaysAgo(ctx.asOf, 365 * 4) },
    { actorLabel: "SFPCA Staff", entityType: "animal", entityId: rexSr.id, action: "lifecycle-transition", after: { to: "deceased" }, createdAt: tsDaysAgo(ctx.asOf, 100) },
    { actorLabel: "SFPCA Staff", entityType: "registration", entityId: biscuitReg26.id, action: "create", createdAt: tsDaysAgo(ctx.asOf, 44) },
    { actorLabel: "SFPCA Staff", entityType: "registration", entityId: rexReg26.id, action: "cancel", after: { reason: "withdrawn" }, createdAt: tsDaysAgo(ctx.asOf, 100) },
    { actorLabel: "SFPCA Staff", entityType: "lost-found-case", entityId: maxCase.id, action: "publish", createdAt: tsDaysAgo(ctx.asOf, 5) },
    { actorLabel: "SFPCA Staff", entityType: "person", entityId: dorothy.id, action: "update", createdAt: tsDaysAgo(ctx.asOf, 30) },
  ]);
  counts["audit_events"] = 6;

  return { counts, entities: manifest };
}
