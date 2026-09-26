"use client";

// Lost/found panel (#176) — the animal profile's view of the case
// layer: open missing/found cases first, then the retained history.
// Case state is deliberately NOT lifecycle state — the panel says so up
// front so nobody reads "missing" as a registry status. Day-to-day case
// work (sightings, linking, publish, resolution) happens on the
// /admin/lost-found workspace; this panel only opens a missing case and
// links through.

import { useState } from "react";
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
import type { LostFoundCaseRecord } from "@/lib/registry/lost-found";
import {
  LOST_FOUND_CASE_TYPE_LABELS,
  LOST_FOUND_OUTCOME_LABELS,
} from "@/lib/lost-found";
import type { LostFoundOutcome } from "@/lib/lost-found";
import { reportMissingAction } from "@/app/admin/animals/[id]/actions";
import { logError } from "@/lib/logger";
import { Plus } from "lucide-react";

export function LostFoundPanel({
  animalId,
  cases = [],
  today,
  onChanged,
}: {
  animalId: string;
  cases?: LostFoundCaseRecord[];
  today: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastSeenOn, setLastSeenOn] = useState(today);
  const [lastSeenLocation, setLastSeenLocation] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [reporterContact, setReporterContact] = useState("");
  const [notes, setNotes] = useState("");

  const openCases = cases.filter((c) => c.status === "open");
  const history = cases.filter((c) => c.status !== "open");
  const hasOpenMissing = openCases.some((c) => c.caseType === "missing");

  const submit = async () => {
    setBusy(true);
    try {
      const result = await reportMissingAction(animalId, {
        lastSeenOn: lastSeenOn || null,
        lastSeenLocation: lastSeenLocation || null,
        reporterName: reporterName || null,
        reporterContact: reporterContact || null,
        notes: notes || null,
      });
      if (result.ok) {
        setReporting(false);
        setLastSeenLocation("");
        setReporterName("");
        setReporterContact("");
        setNotes("");
        toast({ title: "Missing case opened" });
        onChanged();
      } else {
        toast({
          title: "Couldn't open the case",
          description: `Failed (${result.reason ?? "error"}).`,
          variant: "destructive",
        });
      }
    } catch (error) {
      logError("lost-found", "report-missing-ui", error);
      toast({
        title: "Couldn't open the case",
        description: "Failed to save. Try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Lost &amp; found</CardTitle>
          <CardDescription>
            Case workflow, separate from the permanent registry status —
            an open missing case does not change the animal&apos;s
            lifecycle. Full case work happens on the lost/found
            workspace.
          </CardDescription>
        </div>
        {!hasOpenMissing && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReporting(true)}
          >
            <Plus className="h-4 w-4 mr-1" /> Report missing
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {openCases.length === 0 && !reporting && (
          <p className="text-sm text-muted-foreground">
            No open lost/found cases for this animal.
          </p>
        )}

        {openCases.length > 0 && (
          <ul className="space-y-2">
            {openCases.map((c) => (
              <li
                key={c.id}
                className="text-sm border border-amber-500/50 rounded-md p-2 space-y-1"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary">
                    {LOST_FOUND_CASE_TYPE_LABELS[c.caseType]}
                  </Badge>
                  <span className="text-muted-foreground">
                    reported {c.reportedAt.slice(0, 10)}
                    {c.reportedVia === "owner-portal" ? " by the owner" : ""}
                  </span>
                  {c.publishedAt && (
                    <Badge variant="outline">publicly listed</Badge>
                  )}
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/admin/lost-found/${c.id}`}>Open case</Link>
                  </Button>
                </div>
                {c.caseType === "missing" && c.lastSeenOn && (
                  <p className="text-muted-foreground">
                    Last seen {c.lastSeenOn}
                    {c.lastSeenLocation ? ` at ${c.lastSeenLocation}` : ""}
                  </p>
                )}
                {c.caseType === "found" && (
                  <p className="text-muted-foreground">
                    Found {c.foundOn ?? "date unknown"}
                    {c.foundLocation ? ` at ${c.foundLocation}` : ""}
                    {c.chipDisplay ? ` · chip ${c.chipDisplay}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {reporting && (
          <div className="border rounded-md p-3 space-y-3 text-sm bg-muted/30">
            <p className="font-medium">Report this animal missing</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="lf-last-seen-on">Last seen on</Label>
                <Input
                  id="lf-last-seen-on"
                  type="date"
                  value={lastSeenOn}
                  onChange={(e) => setLastSeenOn(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lf-last-seen-location">
                  Last seen location (optional)
                </Label>
                <Input
                  id="lf-last-seen-location"
                  value={lastSeenLocation}
                  onChange={(e) => setLastSeenLocation(e.target.value)}
                  placeholder="e.g. Windwardside, near the trail"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lf-reporter">Reported by (optional)</Label>
                <Input
                  id="lf-reporter"
                  value={reporterName}
                  onChange={(e) => setReporterName(e.target.value)}
                  placeholder="Who told staff"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lf-contact">Their contact (optional)</Label>
                <Input
                  id="lf-contact"
                  value={reporterContact}
                  onChange={(e) => setReporterContact(e.target.value)}
                  placeholder="Phone or email — staff only"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="lf-notes">Notes (optional)</Label>
                <Textarea
                  id="lf-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything useful — staff only, never public"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submit} disabled={busy}>
                Open missing case
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReporting(false)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Case history</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {history.slice(0, 8).map((c) => (
                <li key={c.id}>
                  {c.reportedAt.slice(0, 10)} —{" "}
                  {LOST_FOUND_CASE_TYPE_LABELS[c.caseType].toLowerCase()} case{" "}
                  {c.status === "resolved" ? (
                    <>
                      resolved {c.resolvedAt?.slice(0, 10)}
                      {c.outcome
                        ? ` (${LOST_FOUND_OUTCOME_LABELS[c.outcome as LostFoundOutcome] ?? c.outcome})`
                        : ""}
                    </>
                  ) : (
                    "cancelled"
                  )}
                  {" · "}
                  <Link
                    href={`/admin/lost-found/${c.id}`}
                    className="underline"
                  >
                    view
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
