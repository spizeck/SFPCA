"use client";

// Data-quality workspace (#178) — the unified exception surface for the
// registry. Findings are computed live server-side; this page renders,
// filters, and records human review decisions. Duplicate-animal pairs
// link to the merge review; nothing on this page mutates registry data
// itself.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  decideFindingAction,
  listDataQualityFindingsAction,
  reopenFindingAction,
} from "./actions";
import type { DataQualityFinding } from "@/lib/registry/data-quality";
import {
  DATA_QUALITY_CATEGORY_LABELS,
  DATA_QUALITY_SEVERITY_LABELS,
  type DataQualityCategory,
  type DataQualitySeverity,
} from "@/lib/data-quality";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { logError } from "@/lib/logger";
import {
  CheckCheck,
  CircleAlert,
  EyeOff,
  GitMerge,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

const CATEGORY_OPTIONS: (DataQualityCategory | "all")[] = [
  "all",
  "duplicates",
  "identity",
  "lifecycle",
  "registrations",
  "freshness",
];

const SEVERITY_OPTIONS: (DataQualitySeverity | "all")[] = [
  "all",
  "blocking",
  "review",
  "advisory",
];

const SEVERITY_BADGE: Record<
  DataQualitySeverity,
  { className: string; label: string }
> = {
  blocking: {
    className: "bg-red-100 text-red-800",
    label: DATA_QUALITY_SEVERITY_LABELS.blocking,
  },
  review: {
    className: "bg-amber-100 text-amber-800",
    label: DATA_QUALITY_SEVERITY_LABELS.review,
  },
  advisory: {
    className: "bg-sky-100 text-sky-800",
    label: DATA_QUALITY_SEVERITY_LABELS.advisory,
  },
};

function SeverityBadge({ severity }: { severity: DataQualitySeverity }) {
  const s = SEVERITY_BADGE[severity];
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${s.className}`}
    >
      {s.label}
    </span>
  );
}

export default function DataQualityPage() {
  const [findings, setFindings] = useState<DataQualityFinding[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [category, setCategory] = useState<string>("all");
  const [severity, setSeverity] = useState<string>("all");
  const [status, setStatus] = useState<string>("open");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      setFindings(
        await listDataQualityFindingsAction({
          category: category as DataQualityCategory | "all",
          severity: severity as DataQualitySeverity | "all",
          status: status as "open" | "suppressed" | "all",
        }),
      );
    } catch (error) {
      logError("animals", "data-quality-load", error);
      setLoadError(true);
    }
  }, [category, severity, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (
    f: DataQualityFinding,
    decision: "confirmed" | "dismissed",
  ) => {
    setBusyKey(f.key + decision);
    try {
      const r = await decideFindingAction({
        detector: f.detector,
        entityType: f.entityType,
        entityIds: f.entityIds,
        fingerprint: f.fingerprint,
        decision,
      });
      if (!r.ok) {
        toast({
          title: "Couldn't save",
          description: "The review decision wasn't recorded. Try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title:
          decision === "confirmed" ? "Marked as confirmed" : "Dismissed",
      });
      await load();
    } catch (error) {
      logError("animals", "data-quality-decide-ui", error);
      toast({
        title: "Couldn't save",
        description: "The review decision wasn't recorded. Try again.",
        variant: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const reopen = async (f: DataQualityFinding) => {
    setBusyKey(f.key + "reopen");
    try {
      const r = await reopenFindingAction({
        detector: f.detector,
        entityType: f.entityType,
        entityIds: f.entityIds,
      });
      if (!r.ok) {
        toast({
          title: "Couldn't reopen",
          description: "The review wasn't cleared. Try again.",
          variant: "destructive",
        });
        return;
      }
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  const counts = { blocking: 0, review: 0, advisory: 0 };
  for (const f of findings ?? []) {
    if (!f.suppressed) counts[f.severity] += 1;
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <ShieldAlert className="h-7 w-7" />
          Data quality
        </h1>
        <p className="text-muted-foreground mt-1">
          Possible duplicates and record problems, computed live. Nothing
          merges or deletes itself — every item here waits for a person to
          decide.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-56" aria-label="Category filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c === "all"
                      ? "All categories"
                      : DATA_QUALITY_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="w-48" aria-label="Severity filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all"
                      ? "All severities"
                      : DATA_QUALITY_SEVERITY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-48" aria-label="Status filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="suppressed">Dismissed</SelectItem>
                <SelectItem value="all">Everything</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {findings === null && !loadError && <p>Loading…</p>}
      {loadError && (
        <Card>
          <CardContent className="pt-6">
            <p>
              The data-quality checks couldn&apos;t run — the registry may be
              unreachable. Try reloading the page.
            </p>
          </CardContent>
        </Card>
      )}
      {findings !== null && !loadError && (
        <>
          {status === "open" && (
            <p className="text-sm text-muted-foreground">
              {counts.blocking} blocking · {counts.review} need review ·{" "}
              {counts.advisory} advisory
            </p>
          )}
          {findings.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <p>
                  {status === "suppressed"
                    ? "No dismissed findings."
                    : "All clear — no open data-quality findings."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {findings.map((f) => (
                <Card key={f.key + (f.fingerprint ?? "")}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                          {f.severity === "blocking" && (
                            <CircleAlert className="h-4 w-4 text-red-600" />
                          )}
                          {f.label}
                          <SeverityBadge severity={f.severity} />
                          {f.confirmed && (
                            <Badge variant="secondary">Confirmed</Badge>
                          )}
                          {f.suppressed && (
                            <Badge variant="outline">Dismissed</Badge>
                          )}
                          {f.staleReview && (
                            <Badge variant="outline" className="border-amber-500 text-amber-700">
                              Evidence changed — re-review
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription>
                          {DATA_QUALITY_CATEGORY_LABELS[f.category]}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm">{f.detail}</p>
                    {f.evidence.length > 0 && (
                      <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-0.5">
                        {f.evidence.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    )}
                    {f.review && (
                      <p className="text-xs text-muted-foreground">
                        {f.review.decision === "confirmed"
                          ? "Confirmed"
                          : "Dismissed"}{" "}
                        by {f.review.decidedByLabel ?? "staff"} on{" "}
                        {f.review.decidedAt.slice(0, 10)}
                        {f.review.note ? ` — ${f.review.note}` : ""}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button size="sm" variant="outline" asChild>
                        <Link href={f.href}>
                          {f.detector === "duplicate-animal" ? (
                            <>
                              <GitMerge className="h-4 w-4 mr-1" />
                              Compare &amp; merge
                            </>
                          ) : (
                            "Open record"
                          )}
                        </Link>
                      </Button>
                      {(f.detector === "duplicate-animal" ||
                        f.detector === "duplicate-person" ||
                        f.detector === "duplicate-household") &&
                        !f.suppressed && (
                          <>
                            {!f.confirmed && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyKey !== null}
                                onClick={() => decide(f, "confirmed")}
                              >
                                <CheckCheck className="h-4 w-4 mr-1" />
                                Confirm duplicate
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyKey !== null}
                              onClick={() => decide(f, "dismissed")}
                            >
                              <EyeOff className="h-4 w-4 mr-1" />
                              Not duplicates
                            </Button>
                          </>
                        )}
                      {f.detector !== "duplicate-animal" &&
                        f.detector !== "duplicate-person" &&
                        f.detector !== "duplicate-household" &&
                        f.detector !== "microchip-conflict" &&
                        !f.suppressed && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyKey !== null}
                            onClick={() => decide(f, "dismissed")}
                          >
                            <EyeOff className="h-4 w-4 mr-1" />
                            Dismiss
                          </Button>
                        )}
                      {f.review && (f.suppressed || f.staleReview) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyKey !== null}
                          onClick={() => reopen(f)}
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Reopen
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
