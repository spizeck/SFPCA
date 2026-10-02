// Unit tests for the Neon preview-branch lifecycle rules (#262).
// These pin the safety contract that the cleanup workflow and operator
// tooling both depend on: only well-formed preview/* names are
// deletable, the primary branch is untouchable, and anything ambiguous
// is kept.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ABANDONED_DAYS,
  DEFAULT_GRACE_DAYS,
  classifyPreviewBranches,
  matchPreviewBranch,
  neonProjectId,
  previewBranchNameFor,
  previewSuffix,
  sanitizeGitRef,
  type NeonBranch,
} from "../scripts/lib/neon";

const NOW = Date.parse("2026-10-02T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function branch(
  name: string,
  opts: { primary?: boolean; ageDays?: number } = {},
): NeonBranch {
  return {
    id: `br-${name.replace(/\W/g, "-")}`,
    name,
    primary: opts.primary,
    created_at:
      opts.ageDays === undefined
        ? undefined
        : new Date(NOW - opts.ageDays * DAY).toISOString(),
  };
}

const noLive = { openPrHeads: new Set<string>(), remoteHeads: new Set<string>() };
const opts = {
  now: NOW,
  graceDays: DEFAULT_GRACE_DAYS,
  abandonedDays: DEFAULT_ABANDONED_DAYS,
};

describe("sanitizeGitRef", () => {
  it("accepts normal branch names", () => {
    expect(sanitizeGitRef("fix/262-neon-cleanup")).toBe("fix/262-neon-cleanup");
    expect(sanitizeGitRef("feature_foo.bar")).toBe("feature_foo.bar");
  });
  it("strips refs/heads/ prefixes", () => {
    expect(sanitizeGitRef("refs/heads/fix/x")).toBe("fix/x");
  });
  it("rejects malformed/untrusted refs", () => {
    for (const bad of [
      "",
      "..",
      "foo..bar",
      "foo bar",
      "foo\\bar",
      "foo~bar",
      "foo?bar",
      "foo*bar",
      "foo[bar",
      "-starts-with-dash",
      "trailingslash/",
      "ends.lock",
      "a".repeat(300),
    ]) {
      expect(sanitizeGitRef(bad)).toBeNull();
    }
  });
});

describe("previewBranchNameFor", () => {
  it("maps a git ref onto the Vercel–Neon naming convention", () => {
    expect(previewBranchNameFor("ops/180-neon-integration")).toBe(
      "preview/ops/180-neon-integration",
    );
    expect(previewBranchNameFor("main")).toBe("preview/main");
  });
  it("returns null for refs that cannot name a branch", () => {
    expect(previewBranchNameFor("")).toBeNull();
    expect(previewBranchNameFor("../escape")).toBeNull();
    expect(previewBranchNameFor("x; rm -rf /")).toBeNull();
  });
});

describe("matchPreviewBranch", () => {
  const branches = [
    branch("main", { primary: true }),
    branch("preview/fix/a"),
    branch("preview/fix/b"),
  ];

  it("resolves a normal preview branch by ref", () => {
    expect(matchPreviewBranch(branches, "fix/a")?.id).toBe(
      "br-preview-fix-a",
    );
  });
  it("never resolves the primary branch", () => {
    // A ref of "main" targets preview/main — not present → null. And a
    // crafted ref cannot reach the primary "main" branch itself.
    expect(matchPreviewBranch(branches, "main")).toBeNull();
    expect(matchPreviewBranch(branches, "../main")).toBeNull();
    expect(matchPreviewBranch(branches, "")).toBeNull();
  });
  it("refuses a primary branch even if named preview/*", () => {
    const weird = [branch("preview/x", { primary: true })];
    expect(matchPreviewBranch(weird, "x")).toBeNull();
  });
  it("unknown branch → no match (already deleted / never created)", () => {
    expect(matchPreviewBranch(branches, "fix/never-existed")).toBeNull();
  });
});

describe("previewSuffix", () => {
  it("extracts suffixes and rejects non-preview names", () => {
    expect(previewSuffix("preview/fix/a")).toBe("fix/a");
    expect(previewSuffix("main")).toBeNull();
    expect(previewSuffix("preview/")).toBeNull();
    expect(previewSuffix("preview/bad name")).toBeNull();
    expect(previewSuffix("preview/../evil")).toBeNull();
  });
});

describe("classifyPreviewBranches", () => {
  it("marks orphaned-by-deletion branches stale after grace", () => {
    const { stale } = classifyPreviewBranches(
      [branch("preview/fix/merged", { ageDays: 3 })],
      noLive,
      opts,
    );
    expect(stale.map((b) => b.name)).toEqual(["preview/fix/merged"]);
  });
  it("keeps branches inside the grace window", () => {
    const { stale, kept } = classifyPreviewBranches(
      [branch("preview/fix/fresh", { ageDays: 0.5 })],
      noLive,
      opts,
    );
    expect(stale).toHaveLength(0);
    expect(kept[0].reason).toMatch(/grace/);
  });
  it("keeps branches referenced by an open PR regardless of age", () => {
    const { stale } = classifyPreviewBranches(
      [branch("preview/fix/open", { ageDays: 90 })],
      { openPrHeads: new Set(["fix/open"]), remoteHeads: new Set() },
      opts,
    );
    expect(stale).toHaveLength(0);
  });
  it("keeps branches whose git branch still exists (until abandoned)", () => {
    const { stale, kept } = classifyPreviewBranches(
      [branch("preview/fix/live", { ageDays: 5 })],
      { openPrHeads: new Set(), remoteHeads: new Set(["fix/live"]) },
      opts,
    );
    expect(stale).toHaveLength(0);
    expect(kept[0].reason).toMatch(/still exists/);
  });
  it("marks abandoned branches stale even with a live git ref", () => {
    const { stale } = classifyPreviewBranches(
      [branch("preview/fix/ancient", { ageDays: 45 })],
      { openPrHeads: new Set(), remoteHeads: new Set(["fix/ancient"]) },
      opts,
    );
    expect(stale.map((b) => b.name)).toEqual(["preview/fix/ancient"]);
  });
  it("never classifies primary or non-preview branches stale", () => {
    const { stale } = classifyPreviewBranches(
      [
        branch("main", { primary: true, ageDays: 400 }),
        branch("dev-scratch", { ageDays: 400 }),
      ],
      noLive,
      opts,
    );
    expect(stale).toHaveLength(0);
  });
  it("keeps branches with missing/unparseable created_at", () => {
    const { stale, kept } = classifyPreviewBranches(
      [
        { id: "br-1", name: "preview/fix/no-ts" },
        {
          id: "br-2",
          name: "preview/fix/bad-ts",
          created_at: "not-a-date",
        },
      ],
      noLive,
      opts,
    );
    expect(stale).toHaveLength(0);
    expect(kept).toHaveLength(2);
  });
  it("keeps preview branches whose suffix is unparseable", () => {
    const { stale, kept } = classifyPreviewBranches(
      [branch("preview/not a ref", { ageDays: 400 })],
      noLive,
      opts,
    );
    expect(stale).toHaveLength(0);
    expect(kept[0].reason).toMatch(/unparseable/);
  });
});

describe("neonProjectId", () => {
  it("defaults to the audited SFPCA project", () => {
    expect(neonProjectId({})).toBe("withered-sound-26167673");
    expect(neonProjectId({ NEON_PROJECT_ID: "other" })).toBe("other");
  });
});
