// Live-ref discovery for the Neon preview sweep (#262).
//
// "Live" means: the git branch still exists on the remote, or an open
// pull request still has it as head ref. Two sources are supported:
// the GitHub REST API (CI — GITHUB_TOKEN/GITHUB_REPOSITORY) and
// `git ls-remote` (operator machines — works unauthenticated on this
// public repo, and covers branch existence even without a token).
//
// Failure handling is the safety boundary: callers must treat an empty
// result WITHOUT a reachable source as "cannot determine liveness" and
// refuse to sweep, not as "nothing is live".

import { execFileSync } from "node:child_process";

const GITHUB_API = "https://api.github.com";

export function githubRepo(
  env: Record<string, string | undefined> = process.env,
): string | null {
  // GITHUB_REPOSITORY is "owner/name" in Actions.
  return env.GITHUB_REPOSITORY ?? null;
}

export function githubToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? null;
}

async function ghApi(
  repo: string,
  token: string | null,
  path: string,
  // GitHub returns ad-hoc JSON shapes.
): Promise<any> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sfpca-neon-preview-cleanup",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${GITHUB_API}/repos/${repo}${path}`, { headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `GitHub API GET ${path} → ${r.status}: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body;
}

// head.ref of every open PR (covers fork PRs, whose branch names do not
// appear on this repo's remote). Paginates until a short page.
export async function listOpenPrHeadRefs(
  repo: string,
  token: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let page = 1; ; page++) {
    const prs = await ghApi(repo, token, `/pulls?state=open&per_page=100&page=${page}`);
    for (const pr of prs) {
      if (typeof pr?.head?.ref === "string") out.add(pr.head.ref);
    }
    if (!Array.isArray(prs) || prs.length < 100) break;
  }
  return out;
}

export async function listRepoBranches(
  repo: string,
  token: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let page = 1; ; page++) {
    const branches = await ghApi(
      repo,
      token,
      `/branches?per_page=100&page=${page}&protected=false`,
    );
    for (const b of branches) {
      if (typeof b?.name === "string") out.add(b.name);
    }
    if (!Array.isArray(branches) || branches.length < 100) break;
  }
  return out;
}

// Token-free fallback for operator machines: lists remote heads via the
// git wire protocol. Works on the public repo without credentials.
export function lsRemoteHeads(remoteUrl: string): Set<string> {
  const out = execFileSync(
    "git",
    ["ls-remote", "--heads", remoteUrl],
    { encoding: "utf8", timeout: 30_000 },
  );
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/refs\/heads\/(.+)$/);
    if (m) set.add(m[1].trim());
  }
  return set;
}

export function originUrl(): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}
