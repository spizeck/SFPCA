"use client";

// Microchip panel (#168) — the staff view of an animal's chip identity:
// the current chip, the closed/historical rows, open chip-number
// conflicts, and found-report history. Rows are never deleted: a chip
// leaving use is CLOSED with a reason ('replaced' keeps a successor
// link); wrong data is fixed in place by Correct — never by a fake
// replacement event. A duplicate chip claim is rejected and flagged as
// a conflict for human resolution, never silently moved.

import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type {
  ChipConflictRecord,
  FoundReportRecord,
  MicrochipRecord,
} from "@/lib/registry/microchips";
import {
  assignMicrochipAction,
  closeMicrochipAction,
  correctMicrochipAction,
  replaceMicrochipAction,
  resolveChipConflictAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import { logError } from "@/lib/logger";
import { Plus } from "lucide-react";

type Editor =
  | { kind: "add" }
  | { kind: "replace"; record: MicrochipRecord }
  | { kind: "close"; record: MicrochipRecord }
  | { kind: "correct"; record: MicrochipRecord }
  | { kind: "resolve-conflict"; conflict: ChipConflictRecord };

const CLOSED_REASON_LABELS: Record<string, string> = {
  replaced: "Replaced",
  removed: "No longer in use",
  corrected: "Corrected — recorded in error",
};

const FOUND_OUTCOME_LABELS: Record<string, string> = {
  reunited: "Reunited",
  "in-care": "In care",
  other: "Other",
};

export function MicrochipPanel({
  animalId,
  microchips = [],
  chipConflicts = [],
  foundReports = [],
  today,
  onChanged,
}: {
  animalId: string;
  microchips?: MicrochipRecord[];
  chipConflicts?: ChipConflictRecord[];
  foundReports?: FoundReportRecord[];
  today: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  // Shared form state — interpreted per editor kind.
  const [chipNumber, setChipNumber] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [implantedOn, setImplantedOn] = useState("");
  const [implantedBy, setImplantedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [assignedFrom, setAssignedFrom] = useState(today);
  const [effectiveOn, setEffectiveOn] = useState(today);
  const [closeReason, setCloseReason] = useState<"removed" | "corrected">(
    "removed",
  );
  const [resolveNote, setResolveNote] = useState("");

  const open = (e: Editor) => {
    setEditor(e);
    setChipNumber(
      e.kind === "correct" ? e.record.chipDisplay : "",
    );
    setManufacturer(e.kind === "correct" ? (e.record.manufacturer ?? "") : "");
    setImplantedOn(e.kind === "correct" ? (e.record.implantedOn ?? "") : "");
    setImplantedBy(e.kind === "correct" ? (e.record.implantedBy ?? "") : "");
    setNotes(e.kind === "correct" ? (e.record.notes ?? "") : "");
    setAssignedFrom(e.kind === "correct" ? e.record.assignedFrom : today);
    setEffectiveOn(today);
    setCloseReason("removed");
    setResolveNote("");
  };

  const fail = (result?: SaveResult) => {
    const reason = result?.reason;
    toast({
      title: "Couldn't save",
      description:
        reason === "chip-conflict"
          ? `That chip is already assigned to ${result?.chipConflict?.holderAnimalName ?? "another animal"} (${result?.chipConflict?.holderRegistryRef ?? ""}). A conflict was flagged for review.`
          : reason === "has-current"
            ? "This animal already has a current chip — use Replace instead."
            : reason === "conflict"
              ? "This record changed — reload and try again."
              : `Failed (${reason ?? "error"}).`,
      variant: "destructive",
    });
  };

  const submit = async () => {
    if (!editor) return;
    setBusy(true);
    try {
      let result: SaveResult | { ok: boolean } | undefined;
      switch (editor.kind) {
        case "add":
          result = await assignMicrochipAction(animalId, {
            chipNumber,
            manufacturer: manufacturer || null,
            implantedOn: implantedOn || null,
            implantedBy: implantedBy || null,
            notes: notes || null,
            assignedFrom: assignedFrom || undefined,
          });
          break;
        case "replace":
          result = await replaceMicrochipAction(editor.record.id, {
            chipNumber,
            manufacturer: manufacturer || null,
            implantedOn: implantedOn || null,
            implantedBy: implantedBy || null,
            notes: notes || null,
            effectiveOn: effectiveOn || undefined,
          });
          break;
        case "close":
          result = await closeMicrochipAction(
            editor.record.id,
            effectiveOn || null,
            closeReason,
          );
          break;
        case "correct":
          result = await correctMicrochipAction(
            editor.record.id,
            {
              chipNumber,
              manufacturer: manufacturer || null,
              implantedOn: implantedOn || null,
              implantedBy: implantedBy || null,
              notes: notes || null,
              assignedFrom: assignedFrom || undefined,
            },
            editor.record.createdAt,
          );
          break;
        case "resolve-conflict":
          result = await resolveChipConflictAction(
            editor.conflict.id,
            resolveNote || null,
          );
          break;
      }
      if (result && "ok" in result && result.ok) {
        setEditor(null);
        onChanged();
      } else {
        fail(result as SaveResult);
      }
    } catch (error) {
      logError("microchips", "microchip-save-ui", error);
      fail();
    } finally {
      setBusy(false);
    }
  };

  const current = microchips.filter((c) => c.assignedTo === null);
  const history = microchips.filter((c) => c.assignedTo !== null);
  const chipFields = (
    <>
      <div className="space-y-1 sm:col-span-2">
        <Label>Chip number</Label>
        <Input
          className="font-mono"
          value={chipNumber}
          onChange={(e) => setChipNumber(e.target.value)}
          placeholder="Scanned or typed — formatting is preserved"
        />
      </div>
      <div className="space-y-1">
        <Label>Manufacturer / type (optional)</Label>
        <Input
          value={manufacturer}
          onChange={(e) => setManufacturer(e.target.value)}
          placeholder="e.g. AVID, Datamars"
        />
      </div>
      <div className="space-y-1">
        <Label>Implanted on (optional)</Label>
        <Input
          type="date"
          value={implantedOn}
          onChange={(e) => setImplantedOn(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label>Implanted by (optional)</Label>
        <Input
          value={implantedBy}
          onChange={(e) => setImplantedBy(e.target.value)}
          placeholder="Clinic or vet"
        />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label>Notes (optional)</Label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Microchips</CardTitle>
          <CardDescription>
            Chip identity with history — closed rows are preserved, never
            deleted. A chip number that collides is flagged as a conflict,
            not moved.
          </CardDescription>
        </div>
        {current.length === 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => open({ kind: "add" })}
          >
            <Plus className="h-4 w-4 mr-1" /> Add chip
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {microchips.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No microchip recorded for this animal.
          </p>
        )}

        {current.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Current chip</p>
            <ul className="space-y-2">
              {current.map((c) => (
                <li key={c.id} className="text-sm border rounded-md p-2 space-y-2">
                  <div>
                    <span className="font-mono text-base">{c.chipDisplay}</span>
                    <span className="text-muted-foreground ml-2">
                      current since {c.assignedFrom}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    {[
                      c.manufacturer,
                      c.implantedOn ? `implanted ${c.implantedOn}` : null,
                      c.implantedBy,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {c.notes && <p className="text-muted-foreground">{c.notes}</p>}
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => open({ kind: "replace", record: c })}
                    >
                      Replace chip
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => open({ kind: "close", record: c })}
                    >
                      End use
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => open({ kind: "correct", record: c })}
                    >
                      Correct
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {history.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">History</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {history.map((c) => (
                <li key={c.id} className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{c.chipDisplay}</span>—{" "}
                  {CLOSED_REASON_LABELS[c.closedReason ?? ""] ?? "Closed"}{" "}
                  {c.assignedTo}
                  {c.replacedById &&
                    ` (successor: ${
                      microchips.find((m) => m.id === c.replacedById)
                        ?.chipDisplay ?? "on record"
                    })`}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={() => open({ kind: "correct", record: c })}
                  >
                    Correct
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {chipConflicts.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Open chip conflicts</p>
            <ul className="space-y-2">
              {chipConflicts.map((c) => (
                <li
                  key={c.id}
                  className="text-sm border border-amber-500/50 rounded-md p-2 space-y-1"
                >
                  <p>
                    <span className="font-mono">{c.chipNumber}</span> — claimed
                    for {c.claimedAnimalName ?? "this animal"} while held by{" "}
                    {c.existingAnimalName ?? "another animal"} ({c.source})
                    {c.detail ? ` — ${c.detail}` : ""}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      open({ kind: "resolve-conflict", conflict: c })
                    }
                  >
                    Resolve
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {foundReports.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Found reports</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {foundReports.slice(0, 8).map((r) => (
                <li key={r.id}>
                  {r.reportedOn} —{" "}
                  {r.status === "open" ? (
                    <Badge variant="secondary">open</Badge>
                  ) : (
                    <>
                      resolved {r.resolvedOn}
                      {r.outcome
                        ? ` (${FOUND_OUTCOME_LABELS[r.outcome] ?? r.outcome})`
                        : ""}
                    </>
                  )}
                  {r.notes ? ` — ${r.notes}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {editor && (
          <div className="border rounded-md p-3 space-y-3 text-sm bg-muted/30">
            <p className="font-medium">
              {editor.kind === "add" && "Add chip"}
              {editor.kind === "replace" &&
                `Replace chip — ${editor.record.chipDisplay}`}
              {editor.kind === "close" &&
                `End use — ${editor.record.chipDisplay}`}
              {editor.kind === "correct" &&
                `Correct record — ${editor.record.chipDisplay}`}
              {editor.kind === "resolve-conflict" &&
                `Resolve conflict — ${editor.conflict.chipNumber}`}
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {(editor.kind === "add" ||
                editor.kind === "replace" ||
                editor.kind === "correct") &&
                chipFields}

              {(editor.kind === "replace" || editor.kind === "close") && (
                <div className="space-y-1">
                  <Label>
                    {editor.kind === "replace"
                      ? "Replacement effective on"
                      : "Ended on"}
                  </Label>
                  <Input
                    type="date"
                    value={effectiveOn}
                    onChange={(e) => setEffectiveOn(e.target.value)}
                  />
                </div>
              )}

              {editor.kind === "close" && (
                <div className="space-y-1">
                  <Label>Why is this chip leaving use?</Label>
                  <Select
                    value={closeReason}
                    onValueChange={(v) =>
                      setCloseReason(v as "removed" | "corrected")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="removed">
                        Chip removed / no longer in use
                      </SelectItem>
                      <SelectItem value="corrected">
                        Recorded in error — never this animal&apos;s chip
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {(editor.kind === "add" || editor.kind === "correct") && (
                <div className="space-y-1">
                  <Label>Current since</Label>
                  <Input
                    type="date"
                    value={assignedFrom}
                    onChange={(e) => setAssignedFrom(e.target.value)}
                  />
                </div>
              )}
            </div>

            {editor.kind === "resolve-conflict" && (
              <div className="space-y-1">
                <Label>Resolution note (optional)</Label>
                <Input
                  value={resolveNote}
                  onChange={(e) => setResolveNote(e.target.value)}
                  placeholder="How it was resolved — e.g. corrected the other animal's record"
                />
              </div>
            )}

            <div className="flex gap-2">
              <Button size="sm" onClick={submit} disabled={busy}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditor(null)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
