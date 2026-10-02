// Neon preview-branch lifecycle cleanup (#262).
//
// The Vercel–Neon integration creates `preview/<git-branch>` Neon
// branches for Vercel Preview deployments but never removes them
// (RUNBOOK §19a). This script is the deletion path, driven by:
//
//   single:  PR_HEAD_REF=<ref> tsx scripts/neon-preview-cleanup.ts
//            — or `… cleanup.ts pr <ref>` — deletes preview/<ref> if it
//            exists. Idempotent: already-deleted / never-created is a
//            success, not an error. Runs from the `pull_request_target:
//            closed` and `delete` GitHub workflows.
//
//   sweep:   tsx scripts/neon-preview-cleanup.ts sweep [--apply]
//            [--grace-days N] [--abandoned-days N]
//            — enumerates preview/* branches, classifies them against
//            live git refs, and (with --apply) deletes the stale ones.
//            Defaults to DRY-RUN. Runs on schedule and manually.
//
//   list:    tsx scripts/neon-preview-cleanup.ts list
//            — read-only inventory of preview branches with age.
//
// Safety contract:
// - operates only on the configured SFPCA Neon project
//   (NEON_PROJECT_ID may override for tests, defaults to the audited id)
// - deletes by branch ID after an exact `preview/<ref>` name match —
//   untrusted ref text is never sent to the API
// - never deletes the primary branch, never deletes a name that is not
//   a well-formed `preview/<git-ref>` name
// - single mode skips when another OPEN PR shares the same head-ref
//   name (fork/origin collisions share one Neon branch)
// - sweep refuses to run when liveness cannot be determined — a blind
//   sweep would delete live previews
// - NEON_API_KEY missing → warn + exit 0: cleanup must not go red on
//   every PR close while the repo secret is still being provisioned
//
// The key stays server-side: the workflow runs on pull_request_target
// with trusted default-branch code and passes only the event's head
// ref via environment.

import { config } from "dotenv";
import {
  NeonApiError,
  classifyPreviewBranches,
  deleteBranch,
  listBranches,
  neonProjectId,
  previewBranchNameFor,
  previewSuffix,
  branchAgeDays,
  DEFAULT_ABANDONED_DAYS,
  DEFAULT_GRACE_DAYS,
} from "./lib/neon";
import {
  githubRepo,
  githubToken,
  listOpenPrHeadRefs,
  listRepoBranches,
  lsRemoteHeads,
  originUrl,
} from "./lib/github-refs";
import type { LiveRefs } from "./lib/neon";

config({ path: ".env.local" });

function warn(msg: string) {
  // ::warning:: renders as an annotation in GitHub Actions logs and is
  // harmless text locally.
  console.log(`::warning::${msg}`);
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

async function liveRefs(): Promise<LiveRefs> {
  const repo = githubRepo();
  const token = githubToken();

  let openPrHeads: Set<string>;
  if (repo) {
    openPrHeads = await listOpenPrHeadRefs(repo, token);
  } else {
    throw new Error(
      "cannot determine open PRs (GITHUB_REPOSITORY unset) — refusing to judge staleness",
    );
  }

  let remoteHeads: Set<string> | null = null;
  if (repo) {
    try {
      remoteHeads = await listRepoBranches(repo, token);
    } catch {
      remoteHeads = null; // fall through to ls-remote
    }
  }
  if (!remoteHeads) {
    const url = originUrl();
    if (!url) {
      throw new Error(
        "cannot enumerate remote branches (GitHub API failed, no origin remote)",
      );
    }
    remoteHeads = lsRemoteHeads(url);
  }
  return { openPrHeads, remoteHeads };
}

function keyOrWarn(): string | null {
  const key = process.env.NEON_API_KEY;
  if (!key) {
    warn(
      "NEON_API_KEY is not configured — skipping preview-branch cleanup " +
        "(add the repo secret to enable it; see RUNBOOK §19a).",
    );
    return null;
  }
  return key;
}

// Other open PRs whose head ref resolves to the same Neon preview
// branch name — a fork `fix/x` and an origin `fix/x` share
// `preview/fix/x`. Never pulled from under them.
async function sharedByOpenPr(ref: string): Promise<boolean> {
  const repo = githubRepo();
  if (!repo) return false; // no GitHub context — can't know
  const heads = await listOpenPrHeadRefs(repo, githubToken());
  return heads.has(ref);
}

async function cmdPr(ref: string, key: string, projectId: string) {
  const expected = previewBranchNameFor(ref);
  if (expected === null) {
    warn(`unusable git ref "${ref}" — nothing deleted`);
    return;
  }
  const branches = await listBranches(key, projectId);
  const named = branches.find((b) => b.name === expected);
  if (!named) {
    console.log(
      `neon-preview-cleanup: no branch "${expected}" — already gone or never created.`,
    );
    return;
  }
  if (named.primary) {
    // Structural impossibility for a preview/* name; hard-stop anyway.
    throw new Error(`refusing: "${expected}" is the primary branch`);
  }
  if (await sharedByOpenPr(ref)) {
    console.log(
      `neon-preview-cleanup: keeping ${expected} — another open PR uses head ref "${ref}".`,
    );
    return;
  }
  await deleteBranch(key, projectId, named.id);
  console.log(`neon-preview-cleanup: deleted ${expected} (${named.id}).`);
}

async function cmdList(key: string, projectId: string) {
  const branches = await listBranches(key, projectId);
  const now = Date.now();
  const previews = branches.filter((b) => previewSuffix(b.name) !== null);
  if (!previews.length) {
    console.log("(no preview/* branches)");
    return;
  }
  for (const b of previews) {
    const age = branchAgeDays(b, now);
    console.log(
      `${b.name}  id=${b.id}  age=${age === null ? "?" : `${age.toFixed(1)}d`}` +
        `${b.primary ? "  [primary — never deletable]" : ""}`,
    );
  }
}

async function cmdSweep(key: string, projectId: string) {
  const apply = has("--apply");
  const graceDays = Number(arg("--grace-days") ?? DEFAULT_GRACE_DAYS);
  const abandonedDays = Number(
    arg("--abandoned-days") ?? DEFAULT_ABANDONED_DAYS,
  );
  if (!(graceDays >= 0) || !(abandonedDays >= graceDays)) {
    throw new Error("invalid --grace-days/--abandoned-days");
  }

  const [branches, live] = await Promise.all([
    listBranches(key, projectId),
    liveRefs(),
  ]);
  const now = Date.now();
  const { stale, kept } = classifyPreviewBranches(branches, live, {
    now,
    graceDays,
    abandonedDays,
  });

  for (const { branch, reason } of kept) {
    if (previewSuffix(branch.name) !== null) {
      console.log(`keep    ${branch.name}  (${reason})`);
    }
  }
  if (!stale.length) {
    console.log("sweep: no stale preview branches.");
    return;
  }
  for (const b of stale) {
    const age = branchAgeDays(b, now);
    console.log(
      `${apply ? "delete" : "STALE "}  ${b.name}  id=${b.id}  age=${age === null ? "?" : `${age.toFixed(1)}d`}`,
    );
  }
  if (!apply) {
    console.log(
      `sweep: dry-run — ${stale.length} stale branch(es). Re-run with --apply to delete.`,
    );
    return;
  }
  let failures = 0;
  for (const b of stale) {
    try {
      await deleteBranch(key, projectId, b.id);
      console.log(`deleted ${b.name}`);
    } catch (e) {
      failures++;
      if (e instanceof NeonApiError && e.status === 404) {
        console.log(`${b.name} already deleted`);
      } else {
        console.error(
          `failed to delete ${b.name}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }
  if (failures) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const key = keyOrWarn();
  if (!key) return;
  const projectId = neonProjectId();

  if (cmd === "sweep") {
    await cmdSweep(key, projectId);
    return;
  }
  if (cmd === "list") {
    await cmdList(key, projectId);
    return;
  }
  const ref = cmd === "pr" ? rest[0] : cmd === undefined ? process.env.PR_HEAD_REF : cmd;
  if (!ref) {
    console.error(
      "usage: neon-preview-cleanup.ts [pr <git-ref>] | list | sweep [--apply] [--grace-days N] [--abandoned-days N]",
    );
    process.exit(1);
  }
  await cmdPr(ref, key, projectId);
}

main().catch((e) => {
  console.error(
    "neon-preview-cleanup failed:",
    e instanceof Error ? e.message : e,
  );
  process.exit(1);
});

export {};
