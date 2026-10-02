// Shared Neon API helpers + preview-branch lifecycle rules (#262).
//
// The Vercel–Neon integration provisions one copy-on-write branch named
// `preview/<git-branch>` per git branch that gets a Vercel Preview
// deployment. Nothing upstream deletes them (verified in RUNBOOK §19a),
// so this module is the single place that decides:
//
//   - what a preview branch is expected to be called for a git ref;
//   - which branches automation may delete (only `preview/*`, never the
//     primary branch, matched by NAME then deleted by ID);
//   - which preview branches count as stale for the scheduled sweep.
//
// Both CLIs (scripts/neon-ops.ts, scripts/neon-preview-cleanup.ts) and
// the vitest suite consume these helpers — keep it dependency-free.

export const NEON_API_BASE = "https://console.neon.tech/api/v2";
// sfpca-db — audited in #180. Overridable for tests via NEON_PROJECT_ID;
// automation must never silently target a different project.
export const DEFAULT_NEON_PROJECT_ID = "withered-sound-26167673";
export const PREVIEW_BRANCH_PREFIX = "preview/";

export interface NeonBranch {
  id: string;
  name: string;
  primary?: boolean;
  parent_id?: string;
  created_at?: string;
}

export interface NeonEndpoint {
  id: string;
  host: string;
  branch_id: string;
  type: string;
}

export function neonProjectId(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.NEON_PROJECT_ID || DEFAULT_NEON_PROJECT_ID;
}

export async function neonApi(
  key: string,
  projectId: string,
  path: string,
  init?: RequestInit,
  // Neon returns ad-hoc JSON shapes.
): Promise<any> {
  const r = await fetch(`${NEON_API_BASE}/projects/${projectId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new NeonApiError(
      `Neon API ${init?.method ?? "GET"} ${path} → ${r.status}: ${JSON.stringify(body).slice(0, 300)}`,
      r.status,
    );
  }
  return body;
}

export class NeonApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "NeonApiError";
  }
}

export async function listBranches(
  key: string,
  projectId: string,
): Promise<NeonBranch[]> {
  return (await neonApi(key, projectId, "/branches")).branches ?? [];
}

export async function listEndpoints(
  key: string,
  projectId: string,
): Promise<NeonEndpoint[]> {
  return (await neonApi(key, projectId, "/endpoints")).endpoints ?? [];
}

export function findBranch(
  branches: NeonBranch[],
  nameOrId: string,
): NeonBranch | undefined {
  return branches.find((b) => b.id === nameOrId || b.name === nameOrId);
}

export async function deleteBranch(
  key: string,
  projectId: string,
  id: string,
): Promise<void> {
  await neonApi(key, projectId, `/branches/${id}`, { method: "DELETE" });
}

// --- Preview-branch naming -------------------------------------------------

// Git ref components cannot contain space, ~, ^, ?, *, [, ], control
// chars, or ".."; the leading "refs/heads/" prefix is stripped. Anything
// else is treated as untrusted input and rejected rather than
// normalized — we must never invent a branch name the Vercel–Neon
// integration could not itself have produced verbatim.
const GIT_REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

export function sanitizeGitRef(ref: string): string | null {
  const stripped = ref.replace(/^refs\/heads\//, "");
  if (
    stripped.length === 0 ||
    stripped.length > 255 ||
    !GIT_REF_COMPONENT.test(stripped) ||
    stripped.includes("..") ||
    stripped.endsWith("/") ||
    stripped.endsWith(".lock")
  ) {
    return null;
  }
  return stripped;
}

// Expected Neon branch name for a git ref, e.g.
// "fix/otel-core-2x" → "preview/fix/otel-core-2x". Returns null when
// the ref is not a plausible git branch name.
export function previewBranchNameFor(ref: string): string | null {
  const clean = sanitizeGitRef(ref);
  return clean === null ? null : `${PREVIEW_BRANCH_PREFIX}${clean}`;
}

export function previewSuffix(branchName: string): string | null {
  if (!branchName.startsWith(PREVIEW_BRANCH_PREFIX)) return null;
  const suffix = branchName.slice(PREVIEW_BRANCH_PREFIX.length);
  return sanitizeGitRef(suffix) === suffix && suffix.length > 0
    ? suffix
    : null;
}

// Resolve the Neon branch that automation may delete for a git ref.
// Name match → delete by ID: untrusted ref text is never sent to the
// API, and a branch whose name happens to match but that is marked
// primary is refused outright.
export function matchPreviewBranch(
  branches: NeonBranch[],
  ref: string,
): NeonBranch | null {
  const expected = previewBranchNameFor(ref);
  if (expected === null) return null;
  const match = branches.find((b) => b.name === expected);
  if (!match || match.primary) return null;
  return match;
}

// --- Staleness --------------------------------------------------------------

export interface LiveRefs {
  // head.ref of every open PR in the repo (same-repo and forks).
  openPrHeads: ReadonlySet<string>;
  // branch names currently present on origin.
  remoteHeads: ReadonlySet<string>;
}

export interface StaleOptions {
  now: number; // ms epoch
  // Never touch a preview branch younger than this — covers the race
  // between a branch push and the git/API views used for liveness.
  graceDays: number;
  // A preview branch this old is stale even if its git branch still
  // exists but no open PR references it (closed-not-merged leftovers).
  abandonedDays: number;
}

export const DEFAULT_GRACE_DAYS = 1;
export const DEFAULT_ABANDONED_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function branchAgeDays(branch: NeonBranch, now: number): number | null {
  if (!branch.created_at) return null;
  const created = Date.parse(branch.created_at);
  return Number.isNaN(created) ? null : (now - created) / DAY_MS;
}

// A preview branch is stale when ALL of:
//   - it parses as preview/<valid git ref> and is not the primary branch
//   - no OPEN pull request has head ref <suffix>
//   - it is older than graceDays
//   - either its git branch is gone from origin, OR it is older than
//     abandonedDays
// Anything ambiguous (unparseable suffix, missing created_at) is kept —
// the sweep must never delete a branch it cannot explain.
export function classifyPreviewBranches(
  branches: NeonBranch[],
  live: LiveRefs,
  opts: StaleOptions,
): { stale: NeonBranch[]; kept: { branch: NeonBranch; reason: string }[] } {
  const stale: NeonBranch[] = [];
  const kept: { branch: NeonBranch; reason: string }[] = [];

  for (const branch of branches) {
    const suffix = previewSuffix(branch.name);
    if (suffix === null) {
      if (branch.name.startsWith(PREVIEW_BRANCH_PREFIX)) {
        kept.push({ branch, reason: "unparseable preview suffix" });
      }
      continue; // not a preview branch at all
    }
    if (branch.primary) {
      kept.push({ branch, reason: "primary branch" });
      continue;
    }
    if (live.openPrHeads.has(suffix)) {
      kept.push({ branch, reason: `open PR uses ${suffix}` });
      continue;
    }
    const age = branchAgeDays(branch, opts.now);
    if (age === null) {
      kept.push({ branch, reason: "created_at missing" });
      continue;
    }
    if (age < opts.graceDays) {
      kept.push({ branch, reason: `younger than ${opts.graceDays}d grace` });
      continue;
    }
    if (live.remoteHeads.has(suffix) && age < opts.abandonedDays) {
      kept.push({ branch, reason: `git branch ${suffix} still exists` });
      continue;
    }
    stale.push(branch);
  }
  return { stale, kept };
}
