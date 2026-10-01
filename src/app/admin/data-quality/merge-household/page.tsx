"use client";

// Duplicate-household merge review (#211). Side-by-side member and
// ownership evidence, explicit survivor choice, server-computed preview,
// explicit confirm — the execute call revalidates under row locks.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  executeHouseholdMergeAction,
  getHouseholdMergePairAction,
  previewHouseholdMergeAction,
} from "./actions";
import type {
  HouseholdMergePreview,
  HouseholdMergeSide,
} from "@/lib/registry/household-merge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { logError } from "@/lib/logger";
import { CircleAlert, GitMerge, TriangleAlert } from "lucide-react";

function HouseholdCard({
  side,
  chosen,
  onChoose,
}: {
  side: HouseholdMergeSide;
  chosen: boolean;
  onChoose: () => void;
}) {
  const h = side.household;
  return (
    <Card className={chosen ? "border-primary ring-2 ring-primary/30" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 flex-wrap text-lg">
          {h.name}
          {side.merged && <Badge variant="secondary">Merged</Badge>}
        </CardTitle>
        <CardDescription>{h.address ?? "No address on record"}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        <p>
          Members:{" "}
          {side.members
            .map((m) => `${m.fullName}${m.role === "primary" ? " (primary)" : ""}`)
            .join(", ") || "none"}
        </p>
        <p>Currently owns: {side.currentAnimals.join(", ") || "no animals"}</p>
        <div className="pt-2">
          <label className="flex items-center gap-2 font-medium">
            <input
              type="radio"
              name="survivor"
              checked={chosen}
              onChange={onChoose}
            />
            Keep this record
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

function HouseholdMergeReview() {
  const params = useSearchParams();
  const router = useRouter();
  const aId = params.get("a") ?? "";
  const bId = params.get("b") ?? "";
  const { toast } = useToast();

  const [pair, setPair] = useState<{ a: HouseholdMergeSide; b: HouseholdMergeSide } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [preview, setPreview] = useState<HouseholdMergePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, "survivor" | "retired">>({});
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!aId || !bId) {
      setLoadError(true);
      return;
    }
    // Reset choices on the param change itself, not in the async
    // response — a duplicate/late resolution (dev StrictMode fires this
    // twice) must not wipe a survivor the reviewer already picked.
    setSurvivorId(null);
    setPreview(null);
    let cancelled = false;
    getHouseholdMergePairAction(aId, bId)
      .then((p) => {
        if (cancelled) return;
        if (!p) setLoadError(true);
        setPair(p);
      })
      .catch((e) => {
        if (cancelled) return;
        logError("owners", "household-merge-pair-load", e);
        setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  const retiredId = pair && survivorId ? (survivorId === aId ? bId : aId) : null;

  const runPreview = async () => {
    if (!survivorId || !retiredId) return;
    setBusy(true);
    setPreviewError(null);
    try {
      const r = await previewHouseholdMergeAction(survivorId, retiredId);
      if (!r.ok) {
        setPreview(null);
        setPreviewError(r.message);
        return;
      }
      setPreview(r.preview);
      const defaults: Record<string, "survivor" | "retired"> = {};
      for (const c of r.preview.fieldConflicts) defaults[c.field] = "survivor";
      setChoices(defaults);
    } catch (e) {
      logError("owners", "household-merge-preview-ui", e);
      setPreviewError("The preview failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  const runMerge = async () => {
    if (!preview || !survivorId || !retiredId) return;
    setConfirming(false);
    setBusy(true);
    try {
      const r = await executeHouseholdMergeAction({
        survivorId,
        retiredId,
        fieldChoices: choices,
        fingerprint: preview.fingerprint,
        note: note || null,
      });
      if (!r.ok) {
        const message =
          r.reason === "stale"
            ? "These records changed since the preview — review again."
            : r.reason === "blocked"
              ? (r.blockers?.map((b) => b.message).join(" ") ?? "Merge is blocked.")
              : r.reason === "invalid"
                ? "Unresolved field choices — pick a value for every conflict."
                : "Merge failed — try again.";
        toast({ title: "Merge not completed", description: message, variant: "destructive" });
        await runPreview();
        return;
      }
      toast({ title: "Merged", description: `Records merged into ${r.survivorName}.` });
      router.push("/admin/persons");
    } catch (e) {
      logError("owners", "household-merge-execute-ui", e);
      toast({ title: "Merge failed", description: "Try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p>Those households could not be loaded — the link may be stale.</p>
        </CardContent>
      </Card>
    );
  }
  if (!pair) return <p>Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm flex gap-2">
        <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
        <p>
          Merging households is a permanent identity decision. Compare the
          member lists and ownership carefully — if you&apos;re not sure
          these are the same household, go back and mark the pair
          &quot;not duplicates&quot; instead. The record you don&apos;t
          keep is retired, not deleted: its members and ownership history
          move to the record you keep.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <HouseholdCard
          side={pair.a}
          chosen={survivorId === aId}
          onChoose={() => {
            setSurvivorId(aId);
            setPreview(null);
          }}
        />
        <HouseholdCard
          side={pair.b}
          chosen={survivorId === bId}
          onChoose={() => {
            setSurvivorId(bId);
            setPreview(null);
          }}
        />
      </div>

      <div>
        <Button disabled={!survivorId || busy} onClick={runPreview}>
          {busy && !preview ? "Analyzing…" : "Preview merge"}
        </Button>
        {previewError && (
          <p role="alert" className="text-sm text-red-600 mt-2">
            {previewError}
          </p>
        )}
      </div>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <GitMerge className="h-5 w-5" />
              Merge plan — retire {preview.retired.household.name} into{" "}
              {preview.survivor.household.name}
            </CardTitle>
            <CardDescription>
              Computed on the server — re-checked when you confirm.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {preview.blockers.length > 0 ? (
              <div role="alert" className="space-y-2">
                {preview.blockers.map((b) => (
                  <p
                    key={b.code}
                    className="flex gap-2 rounded-md border border-red-500/50 bg-red-50 dark:bg-red-950/30 p-3"
                  >
                    <CircleAlert className="h-4 w-4 mt-0.5 shrink-0 text-red-600" />
                    {b.message}
                  </p>
                ))}
              </div>
            ) : (
              <>
                {preview.fieldConflicts.length > 0 && (
                  <div className="space-y-3">
                    <p className="font-medium">
                      The records disagree — pick the right value:
                    </p>
                    {preview.fieldConflicts.map((c) => (
                      <div
                        key={c.field}
                        className="grid gap-2 sm:grid-cols-[10rem_1fr] items-center"
                      >
                        <Label>{c.label}</Label>
                        <Select
                          value={choices[c.field] ?? ""}
                          onValueChange={(v) =>
                            setChoices({
                              ...choices,
                              [c.field]: v as "survivor" | "retired",
                            })
                          }
                        >
                          <SelectTrigger aria-label={`${c.label} value`}>
                            <SelectValue placeholder="Choose…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="survivor">
                              Keep {preview.survivor.household.name}: {c.survivorValue}
                            </SelectItem>
                            <SelectItem value="retired">
                              Use {preview.retired.household.name}: {c.retiredValue}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
                {preview.autoNotes.length > 0 && (
                  <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                    {preview.autoNotes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                {preview.reparentCounts.length > 0 && (
                  <div>
                    <p className="font-medium mb-1">
                      Moving to {preview.survivor.household.name}:
                    </p>
                    <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                      {preview.reparentCounts.map((c) => (
                        <li key={c.domain}>
                          {c.label}: {c.count}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="merge-note">Note for the record (optional)</Label>
                  <Input
                    id="merge-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Why these are the same household"
                  />
                </div>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  Merge — retire {preview.retired.household.name}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        title="Merge these records?"
        description={
          preview ? (
            <>
              This retires{" "}
              <strong>{preview.retired.household.name}</strong> and moves its
              members and history onto{" "}
              <strong>{preview.survivor.household.name}</strong>. The retired
              record remains as lineage and cannot be edited or merged again.
              This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Merge"
        pendingLabel="Merging…"
        pending={busy}
        onConfirm={runMerge}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

export default function HouseholdMergePage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Review duplicate households</h1>
        <p className="text-muted-foreground mt-1">
          <Link href="/admin/data-quality" className="underline">
            ← Back to data quality
          </Link>
        </p>
      </div>
      <Suspense fallback={<p>Loading…</p>}>
        <HouseholdMergeReview />
      </Suspense>
    </div>
  );
}
