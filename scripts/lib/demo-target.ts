// Shared production/local target resolution for the operator CLIs
// (production-demo.ts, cleanup-prelaunch-legacy-seed.ts).
//
// Extracted from scripts/production-demo.ts so every production-capable
// operator command proves the same two identities before it touches
// anything:
//   - --production: FIREBASE_ADMIN_PROJECT_ID must be the expected
//     project AND DATABASE_URL's host must be an endpoint of the Neon
//     PRIMARY branch (verified via the Neon API, keyed by NEON_API_KEY);
//   - --local: MUST run against the Firebase emulators and a demo-*
//     project id, and a remote DATABASE_URL is refused unless the Neon
//     API proves it is not the production primary endpoint (fail CLOSED).
//
// Refusals are raised as DemoRefusal — callers translate them into
// their own `refused:` exit path.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  listBranches,
  listEndpoints,
  neonProjectId,
} from "./neon";
import { DemoRefusal } from "./demo-db";

export const EXPECTED_FIREBASE_PROJECT = "saba-sfpca";

export interface DemoTarget {
  mode: "production" | "local";
  sql: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle>;
  projectId: string;
  bucketName: string;
}

export async function resolveDemoTarget(opts: {
  production: boolean;
  local: boolean;
}): Promise<DemoTarget> {
  const refuse = (message: string): never => {
    throw new DemoRefusal(message);
  };
  if (opts.production === opts.local) {
    refuse("pass exactly one of --production or --local");
  }

  const emulatorMode = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST,
  );
  // The project the Admin SDK will actually attach to — under emulators
  // NEXT_PUBLIC_FIREBASE_PROJECT_ID takes precedence (getAdminApp).
  const projectId = emulatorMode
    ? (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
      process.env.FIREBASE_ADMIN_PROJECT_ID)
    : process.env.FIREBASE_ADMIN_PROJECT_ID;
  const bucket =
    process.env.FIREBASE_ADMIN_STORAGE_BUCKET ??
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

  if (opts.local) {
    // Local mode is the safe sandbox: it MUST run against the Firebase
    // emulators — a real project id here would make "local" commands
    // mutate production resources.
    if (!emulatorMode) {
      refuse(
        "--local requires the Firebase emulators (FIRESTORE_EMULATOR_HOST/" +
          "FIREBASE_AUTH_EMULATOR_HOST). Start `firebase emulators` first, or export them.",
      );
    }
    if (!projectId || !projectId.startsWith("demo-")) {
      refuse(
        "--local requires a demo-* Firebase project id (emulator convention), " +
          `got '${projectId ?? "unset"}' — refusing to touch what may be a real project.`,
      );
    }
  } else {
    if (emulatorMode) {
      refuse(
        "emulator env vars are set — production mode refuses to run " +
          "against emulators (use --local for emulator targets).",
      );
    }
    if (projectId !== EXPECTED_FIREBASE_PROJECT) {
      refuse(
        `FIREBASE_ADMIN_PROJECT_ID is '${projectId ?? "unset"}', expected ` +
          `'${EXPECTED_FIREBASE_PROJECT}' — identity could not be proven.`,
      );
    }
    if (!process.env.NEON_API_KEY) {
      refuse(
        "NEON_API_KEY is required in production mode — it is how the " +
          "command proves DATABASE_URL points at the primary Neon branch.",
      );
    }
  }

  const url =
    process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    refuse("DATABASE_URL (or _UNPOOLED) is not a Postgres connection string");
  }
  const host = new URL(url!).hostname;

  if (opts.production) {
    // Prove the Postgres target is the production primary branch by
    // matching its endpoint host against the Neon API.
    const project = neonProjectId();
    const key = process.env.NEON_API_KEY!;
    const [branches, endpoints] = await Promise.all([
      listBranches(key, project),
      listEndpoints(key, project),
    ]);
    const primary = branches.find((b) => b.primary);
    if (!primary) refuse("could not resolve the primary Neon branch");
    const hosts = endpoints
      .filter((e) => e.branch_id === primary!.id)
      .map((e) => e.host);
    if (!hosts.includes(host)) {
      refuse(
        `DATABASE_URL host '${host}' is not an endpoint of the primary ` +
          `branch '${primary!.name}' (${hosts.join(", ") || "no endpoints"}).`,
      );
    }
    console.log(
      `identity ok: neon primary '${primary!.name}' @ ${host}; firebase project '${projectId}'`,
    );
  } else {
    // The local target must not secretly be production — fail CLOSED:
    // a remote DATABASE_URL is only acceptable once the Neon API
    // confirms the host is not the production primary endpoint. No
    // API key / failed lookup / unknown host class → refuse.
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    if (!localHosts.has(host) && !host.endsWith(".local")) {
      if (!process.env.NEON_API_KEY) {
        refuse(
          `--local against remote DATABASE_URL host '${host}' cannot be ` +
            "verified — set NEON_API_KEY + NEON_PROJECT_ID so the " +
            "endpoint can be checked against the production primary, " +
            "or point DATABASE_URL at a local database.",
        );
      }
      let hosts: string[] = [];
      try {
        const project = neonProjectId();
        const [branches, endpoints] = await Promise.all([
          listBranches(process.env.NEON_API_KEY!, project),
          listEndpoints(process.env.NEON_API_KEY!, project),
        ]);
        const primary = branches.find((b) => b.primary);
        hosts = primary
          ? endpoints.filter((e) => e.branch_id === primary.id).map((e) => e.host)
          : [];
      } catch (error) {
        if (error instanceof DemoRefusal) throw error;
        refuse(
          `--local against remote DATABASE_URL host '${host}' could not ` +
            `be verified against the Neon API (${error instanceof Error ? error.message : error}) — refusing.`,
        );
      }
      if (hosts.includes(host)) {
        refuse(
          `DATABASE_URL host '${host}' IS the production primary endpoint — ` +
            "remove production credentials before using --local.",
        );
      }
    }
    console.log(`identity ok (local): host=${host}; project='${projectId}'`);
  }

  const sqlClient = postgres(url!, { max: 2, prepare: false });
  return {
    mode: opts.production ? "production" : "local",
    sql: sqlClient,
    db: drizzle(sqlClient),
    projectId: projectId!,
    bucketName: bucket!,
  };
}
