"use client";

// Lost/found workspace (#176) — the exception-first volunteer queue for
// missing and found animal cases: what needs action first, history
// second. This is the #176 surface, not #177's generic exception
// dashboard — #177 should compose the same queue reads rather than
// this page's internals.
//
// Open work is partitioned into the three states a volunteer actually
// acts on: animals reported missing, found animals nobody has matched
// yet, and found animals already linked to a registry record awaiting
// resolution.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  getLostFoundWorkspaceAction,
  openFoundCaseAction,
  type LostFoundWorkspace,
} from "./actions";
import {
  LOST_FOUND_CASE_TYPE_LABELS,
  LOST_FOUND_OUTCOME_LABELS,
} from "@/lib/lost-found";
import type { LostFoundCaseRecord, } from "@/lib/registry/lost-found";
import type { LostFoundOutcome } from "@/lib/lost-found";
import { todayIsoDate } from "@/lib/vaccinations";
import { logError } from "@/lib/logger";
import { LoadError } from "@/components/admin/load-error";
import { Plus } from "lucide-react";

function CaseRow({ c }: { c: LostFoundCaseRecord }) {
  return (
    <li className="py-3 flex items-start justify-between gap-3 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">
            {c.animalName ??
              c.description?.slice(0, 60) ??
              "Unidentified animal"}
          </span>
          {c.animalRegistryRef && (
            <span className="font-mono text-xs text-muted-foreground">
              {c.animalRegistryRef}
            </span>
          )}
          {c.publishedAt && <Badge variant="outline">listed publicly</Badge>}
        </div>
        <p className="text-muted-foreground">
          Reported {c.reportedAt.slice(0, 10)}
          {c.reportedVia === "owner-portal" ? " by the owner" : ""}
          {c.caseType === "missing" && c.lastSeenOn
            ? ` · last seen ${c.lastSeenOn}${c.lastSeenLocation ? ` — ${c.lastSeenLocation}` : ""}`
            : ""}
          {c.caseType === "found"
            ? ` · found ${c.foundOn ?? "date unknown"}${c.foundLocation ? ` — ${c.foundLocation}` : ""}${c.chipDisplay ? ` · chip ${c.chipDisplay}` : ""}`
            : ""}
          {c.linkedAt ? " · matched to registry" : ""}
          {c.status === "resolved" && c.outcome
            ? ` · ${LOST_FOUND_OUTCOME_LABELS[c.outcome as LostFoundOutcome] ?? c.outcome} ${c.resolvedAt?.slice(0, 10) ?? ""}`
            : ""}
          {c.status === "cancelled" ? " · cancelled" : ""}
        </p>
      </div>
      <Button size="sm" variant="outline" asChild className="flex-shrink-0">
        <Link href={`/admin/lost-found/${c.id}`}>
          {c.status === "open" ? "Work case" : "View"}
        </Link>
      </Button>
    </li>
  );
}

function QueueSection({
  title,
  description,
  cases,
  empty,
}: {
  title: string;
  description: string;
  cases: LostFoundCaseRecord[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          {cases.length > 0 && (
            <Badge variant="secondary">{cases.length}</Badge>
          )}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {cases.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">
            {cases.map((c) => (
              <CaseRow key={c.id} c={c} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function LostFoundWorkspacePage() {
  const { toast } = useToast();
  const [data, setData] = useState<LostFoundWorkspace | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [intake, setIntake] = useState(false);
  const [busy, setBusy] = useState(false);
  // Found-animal intake form state.
  const [chipNumber, setChipNumber] = useState("");
  const [foundOn, setFoundOn] = useState(() => todayIsoDate());
  const [foundLocation, setFoundLocation] = useState("");
  const [description, setDescription] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [reporterContact, setReporterContact] = useState("");
  const [notes, setNotes] = useState("");

  const load = async () => {
    setLoadError(false);
    try {
      setData(await getLostFoundWorkspaceAction());
    } catch (error) {
      logError("lost-found", "admin-load", error);
      setLoadError(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submitIntake = async () => {
    setBusy(true);
    try {
      const result = await openFoundCaseAction({
        chipNumber: chipNumber || null,
        foundOn: foundOn || null,
        foundLocation: foundLocation || null,
        description: description || null,
        reporterName: reporterName || null,
        reporterContact: reporterContact || null,
        notes: notes || null,
      });
      if (result.ok) {
        setIntake(false);
        setChipNumber("");
        setFoundLocation("");
        setDescription("");
        setReporterName("");
        setReporterContact("");
        setNotes("");
        toast({ title: "Found case opened" });
        load();
      } else {
        toast({
          title: "Couldn't open the case",
          description:
            result.field === "chipNumber"
              ? "That isn't a recognizable chip number."
              : `Failed (${result.reason ?? "error"}).`,
          variant: "destructive",
        });
      }
    } catch (error) {
      logError("lost-found", "found-intake-ui", error);
      toast({
        title: "Couldn't open the case",
        description: "Failed to save. Try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  if (!data && loadError) {
    return <LoadError label="lost/found cases" onRetry={load} />;
  }
  if (!data) {
    return <div>Loading...</div>;
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Lost &amp; found
          </h1>
          <p className="text-sm text-muted-foreground">
            Missing animals and found animals, open work first. Case state
            is separate from the animal&apos;s registry status.
          </p>
        </div>
        <Button size="sm" onClick={() => setIntake(true)}>
          <Plus className="h-4 w-4 mr-1" /> Report a found animal
        </Button>
      </div>

      {intake && (
        <Card>
          <CardHeader>
            <CardTitle>Report a found animal</CardTitle>
            <CardDescription>
              For an animal found WITHOUT a registry match — a stray, or
              an unknown chip. If a chip was scanned, run it through Chip
              Lookup instead: that path attaches the scan to the right
              record automatically. Nothing here creates an animal
              record.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="fc-chip">
                  Chip number, if one was scanned (optional)
                </Label>
                <Input
                  id="fc-chip"
                  className="font-mono"
                  value={chipNumber}
                  onChange={(e) => setChipNumber(e.target.value)}
                  placeholder="Scanned number — normalized automatically"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fc-found-on">Found on</Label>
                <Input
                  id="fc-found-on"
                  type="date"
                  value={foundOn}
                  onChange={(e) => setFoundOn(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fc-location">Found location (optional)</Label>
                <Input
                  id="fc-location"
                  value={foundLocation}
                  onChange={(e) => setFoundLocation(e.target.value)}
                  placeholder="e.g. Windwardside, near the trail"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fc-reporter">Reported by (optional)</Label>
                <Input
                  id="fc-reporter"
                  value={reporterName}
                  onChange={(e) => setReporterName(e.target.value)}
                  placeholder="Who brought it in"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fc-contact">Their contact (optional)</Label>
                <Input
                  id="fc-contact"
                  value={reporterContact}
                  onChange={(e) => setReporterContact(e.target.value)}
                  placeholder="Phone or email — staff only"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="fc-description">
                  Description (what does it look like?)
                </Label>
                <Textarea
                  id="fc-description"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Species, colours, size, collar — staff only"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="fc-notes">Notes (optional)</Label>
                <Textarea
                  id="fc-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submitIntake} disabled={busy}>
                Open found case
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setIntake(false)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <QueueSection
        title="Missing animals"
        description="Registered animals reported missing — work the case, publish if approved, resolve when reunited."
        cases={data.missing}
        empty="No animals reported missing right now."
      />
      <QueueSection
        title="Found — needs matching"
        description="Found animals with no registry animal attached yet. Match by chip lookup or manual registry search on the case."
        cases={data.foundUnmatched}
        empty="No unmatched found animals."
      />
      <QueueSection
        title="Found — matched"
        description="Found animals linked to a registry record, awaiting reunion or resolution."
        cases={data.foundMatched}
        empty="No matched found cases waiting."
      />
      <QueueSection
        title="Recently closed"
        description="Resolved and cancelled cases — history, never deleted."
        cases={data.recentlyClosed}
        empty="No closed cases yet."
      />
    </div>
  );
}
