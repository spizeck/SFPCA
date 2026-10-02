// Neon operator helper for the SFPCA registry project (#180/#181).
//
// Uses NEON_API_KEY (from .env.local) against the project's Neon API.
// Vercel Secret env vars are write-only — the Neon API is the supported
// way to obtain connection strings and manage branches/snapshots.
//
//   npx tsx scripts/neon-ops.ts list
//   npx tsx scripts/neon-ops.ts create-branch <name> [--parent <name|id>]
//   npx tsx scripts/neon-ops.ts delete-branch <name|id>
//   npx tsx scripts/neon-ops.ts preview-branches   # preview/* w/ age +
//                                                  # stale verdict
//   npx tsx scripts/neon-ops.ts snapshot                 # manual snapshot of main
//   npx tsx scripts/neon-ops.ts snapshots                # list snapshots on main
//   npx tsx scripts/neon-ops.ts delete-snapshot <id>     # free the single
//                                                        # Free-plan slot
//   npx tsx scripts/neon-ops.ts conn <name|id>           # write DATABASE_URL_UNPOOLED into .env.local
//   npx tsx scripts/neon-ops.ts conn main --production   # same, for the prod branch
//
// Safety:
// - prints names/ids/hosts only — never passwords or full URLs
// - `conn` writes the unpooled URL into .env.local (gitignored), never stdout
// - `conn` to the primary branch requires explicit --production
// - delete-branch refuses the primary branch and anything that is not a
//   well-formed name in this project
// - preview-branch lifecycle (auto-delete on PR close + scheduled sweep)
//   lives in scripts/neon-preview-cleanup.ts; `preview-branches` is the
//   operator inspection surface for it
// - fails fast without NEON_API_KEY

import { config } from "dotenv";
import fs from "node:fs";
import {
  classifyPreviewBranches,
  branchAgeDays,
  deleteBranch,
  listBranches,
  listEndpoints,
  findBranch,
  neonApi,
  neonProjectId,
  previewSuffix,
  DEFAULT_ABANDONED_DAYS,
  DEFAULT_GRACE_DAYS,
  type NeonBranch,
  type NeonEndpoint,
} from "./lib/neon";
import { githubRepo, githubToken, listOpenPrHeadRefs, listRepoBranches, lsRemoteHeads, originUrl } from "./lib/github-refs";

config({ path: ".env.local" });

const PROJECT = neonProjectId();
const KEY = process.env.NEON_API_KEY;

if (!KEY) {
  console.error(
    "NEON_API_KEY is not set in .env.local. Create a project-scoped key " +
      "in the Neon console (Account Settings → API Keys).",
  );
  process.exit(1);
}

const api = (path: string, init?: RequestInit) =>
  neonApi(KEY!, PROJECT, path, init);
const branches = () => listBranches(KEY!, PROJECT);
const endpoints = () => listEndpoints(KEY!, PROJECT);

async function findOrThrow(nameOrId: string): Promise<NeonBranch> {
  const b = findBranch(await branches(), nameOrId);
  if (!b) throw new Error(`branch not found: ${nameOrId}`);
  return b;
}

async function endpointFor(branchId: string): Promise<NeonEndpoint> {
  const ep = (await endpoints()).find(
    (e) => e.branch_id === branchId && e.type === "read_write",
  );
  if (!ep) throw new Error(`no read_write endpoint on branch ${branchId}`);
  return ep;
}

async function cmdList() {
  const [bs, eps] = await Promise.all([branches(), endpoints()]);
  for (const b of bs) {
    const ep = eps.find((e) => e.branch_id === b.id);
    console.log(
      `${b.primary ? "[primary]" : "        "} ${b.name}  id=${b.id}` +
        (ep ? `  endpoint=${ep.id}  host=${ep.host}` : "  (no endpoint)"),
    );
  }
}

// Operator view of the preview-branch lifecycle: every preview/* branch
// with its age and the verdict the scheduled sweep would reach right
// now (live refs come from the GitHub API when GITHUB_REPOSITORY is
// set, else `git ls-remote origin`).
async function cmdPreviewBranches() {
  const bs = await branches();
  const previews = bs.filter((b) => previewSuffix(b.name) !== null);
  if (!previews.length) {
    console.log("(no preview/* branches)");
    return;
  }

  let live = { openPrHeads: new Set<string>(), remoteHeads: new Set<string>() };
  let liveSource = "none — stale verdicts unavailable";
  try {
    const repo = githubRepo();
    const token = githubToken();
    if (repo) {
      live = {
        openPrHeads: await listOpenPrHeadRefs(repo, token),
        remoteHeads: await listRepoBranches(repo, token),
      };
      liveSource = `GitHub API (${repo})`;
    } else {
      const url = originUrl();
      if (url) {
        live = { openPrHeads: new Set(), remoteHeads: lsRemoteHeads(url) };
        liveSource = `git ls-remote (${url}) — open-PR status unknown`;
      }
    }
  } catch (e) {
    console.error(
      `warning: could not enumerate live refs: ${e instanceof Error ? e.message : e}`,
    );
  }
  console.log(`live refs via: ${liveSource}\n`);

  const now = Date.now();
  const { stale, kept } = classifyPreviewBranches(previews, live, {
    now,
    graceDays: DEFAULT_GRACE_DAYS,
    abandonedDays: DEFAULT_ABANDONED_DAYS,
  });
  const staleIds = new Set(stale.map((b) => b.id));
  for (const b of previews) {
    const age = branchAgeDays(b, now);
    const verdict =
      staleIds.has(b.id)
        ? "STALE — sweep would delete"
        : kept.find((k) => k.branch.id === b.id)?.reason ?? "";
    console.log(
      `${b.name}  id=${b.id}  age=${age === null ? "?" : `${age.toFixed(1)}d`}  ${verdict}`,
    );
  }
  console.log(
    "\nDelete: tsx scripts/neon-preview-cleanup.ts sweep --apply   (or: delete-branch <name>)",
  );
}

async function cmdCreate(name: string, parentArg?: string) {
  const parent = parentArg
    ? await findOrThrow(parentArg)
    : (await branches()).find((b) => b.primary);
  if (!parent) throw new Error("no parent branch found");
  const j = await api("/branches", {
    method: "POST",
    body: JSON.stringify({
      branch: { parent_id: parent.id, name },
      endpoints: [{ type: "read_write" }],
    }),
  });
  console.log(`created branch ${j.branch.id} name=${name} parent=${parent.name}`);
}

async function cmdDelete(nameOrId: string) {
  const b = await findOrThrow(nameOrId);
  if (b.primary) throw new Error("refusing to delete the primary branch");
  await deleteBranch(KEY!, PROJECT, b.id);
  console.log(`deleted branch ${b.name} (${b.id})`);
}

async function mainBranch(): Promise<NeonBranch> {
  const b = (await branches()).find((x) => x.primary);
  if (!b) throw new Error("no primary branch found");
  return b;
}

async function cmdSnapshot() {
  const main = await mainBranch();
  const r = await api(`/branches/${main.id}/snapshot`, {
    method: "POST",
    body: JSON.stringify({
      snapshot: { name: `manual-${new Date().toISOString().slice(0, 16)}` },
    }),
  });
  console.log("snapshot created:", JSON.stringify(r.snapshot ?? r).slice(0, 300));
}

async function cmdSnapshots() {
  const j = await api(`/snapshots`);
  for (const s of j.snapshots ?? []) {
    console.log(`${s.id}  name=${s.name}  created=${s.created_at}  lsn=${s.lsn ?? "-"}`);
  }
  if (!(j.snapshots ?? []).length) console.log("(no snapshots)");
}

// Free plan allows ONE manual snapshot — the runbook's refresh-before-
// execute flow replaces the prior disposable snapshot each run.
async function cmdDeleteSnapshot(id: string) {
  if (!id) throw new Error("usage: delete-snapshot <snapshot-id>");
  await api(`/snapshots/${id}`, { method: "DELETE" });
  console.log(`deleted snapshot ${id}`);
}

async function cmdConn(nameOrId: string, production: boolean) {
  const b = await findOrThrow(nameOrId);
  if (b.primary && !production) {
    throw new Error(
      `${b.name} is the primary (production) branch — pass --production to confirm`,
    );
  }
  const ep = await endpointFor(b.id);
  const role = await api(
    `/branches/${b.id}/roles/neondb_owner/reveal_password`,
  );
  const url = `postgresql://neondb_owner:${role.password}@${ep.host}/neondb?sslmode=require`;

  const path = ".env.local";
  const existing = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
  const lines = existing
    .split("\n")
    .filter((l) => !l.startsWith("DATABASE_URL_UNPOOLED="));
  lines.push(`DATABASE_URL_UNPOOLED=${url}`);
  fs.writeFileSync(path, lines.join("\n"));
  console.log(
    `DATABASE_URL_UNPOOLED written to .env.local → host=${ep.host} ` +
      `branch=${b.name}${b.primary ? " (PRODUCTION)" : ""}`,
  );
}

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "list":
      await cmdList();
      break;
    case "preview-branches":
      await cmdPreviewBranches();
      break;
    case "create-branch":
      await cmdCreate(
        rest[0],
        rest.includes("--parent") ? rest[rest.indexOf("--parent") + 1] : undefined,
      );
      break;
    case "delete-branch":
      await cmdDelete(rest[0]);
      break;
    case "snapshot":
      await cmdSnapshot();
      break;
    case "snapshots":
      await cmdSnapshots();
      break;
    case "delete-snapshot":
      await cmdDeleteSnapshot(rest[0]);
      break;
    case "conn":
      await cmdConn(rest[0], rest.includes("--production"));
      break;
    default:
      console.error(
        "commands: list | preview-branches | create-branch <name> [--parent <b>] | delete-branch <b> | snapshot | snapshots | delete-snapshot <id> | conn <branch> [--production]",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("neon-ops failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
