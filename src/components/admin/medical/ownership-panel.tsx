"use client";

// Ownership panel (#166) — the staff view of an animal's ownership
// history plus the write path for corrections. Every interval is
// listed, open and closed; nothing here deletes history. A transfer
// closes the old interval and opens the new one atomically; "End"
// closes without a successor (animal becomes ownerless until staff
// record the next owner). Staff confirmations feed the same
// annual-confirmation state the portal writes.

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
import type { OwnershipConfirmation, OwnershipRecord } from "@/lib/registry/ownership";
import type { HouseholdRecord, PersonRecord } from "@/lib/registry/persons";
import {
  closeOwnershipAction,
  correctOwnershipAction,
  recordOwnershipConfirmationAction,
  saveOwnershipAction,
  transferOwnershipAction,
} from "@/app/admin/animals/[id]/actions";
import { logError } from "@/lib/logger";
import { Plus } from "lucide-react";

// Which editor is open for a row (or 'new' for the create form).
type Editor =
  | { kind: "new" }
  | { kind: "close"; ownership: OwnershipRecord }
  | { kind: "transfer"; ownership: OwnershipRecord }
  | { kind: "correct"; ownership: OwnershipRecord }
  | { kind: "confirm"; ownership: OwnershipRecord };

function OwnerPicker({
  persons,
  households,
  personId,
  householdId,
  onChange,
}: {
  persons: PersonRecord[];
  households: HouseholdRecord[];
  personId: string;
  householdId: string;
  onChange: (v: { personId: string; householdId: string }) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label>Owner (person)</Label>
        <Select
          value={personId}
          onValueChange={(v) => onChange({ personId: v, householdId: "" })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Person…" />
          </SelectTrigger>
          <SelectContent>
            {persons.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>…or household</Label>
        <Select
          value={householdId}
          onValueChange={(v) => onChange({ personId: "", householdId: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Household…" />
          </SelectTrigger>
          <SelectContent>
            {households.map((h) => (
              <SelectItem key={h.id} value={h.id}>
                {h.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function OwnershipPanel({
  animalId,
  ownerships,
  confirmations,
  persons,
  households,
  today,
  onChanged,
}: {
  animalId: string;
  ownerships: OwnershipRecord[];
  confirmations: OwnershipConfirmation[];
  persons: PersonRecord[];
  households: HouseholdRecord[];
  today: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  // Shared form state — fields are interpreted per editor kind.
  const [personId, setPersonId] = useState("");
  const [householdId, setHouseholdId] = useState("");
  const [validFrom, setValidFrom] = useState(today);
  const [validTo, setValidTo] = useState("");
  const [note, setNote] = useState("");
  const [confirmPersonId, setConfirmPersonId] = useState("");

  const open = (e: Editor) => {
    setEditor(e);
    setPersonId("");
    setHouseholdId("");
    setValidFrom(e.kind === "correct" ? e.ownership.validFrom : today);
    setValidTo(e.kind === "correct" ? (e.ownership.validTo ?? "") : today);
    setNote(e.kind === "correct" ? (e.ownership.note ?? "") : "");
    setConfirmPersonId(e.kind === "confirm" ? (e.ownership.personId ?? "") : "");
  };

  const fail = (reason?: string) =>
    toast({
      title: "Couldn't save",
      description:
        reason === "conflict"
          ? "This record changed — reload and try again."
          : reason === "overlap"
            ? "That interval overlaps an existing one for the same owner."
            : `Failed (${reason ?? "error"}).`,
      variant: "destructive",
    });

  const submit = async () => {
    if (!editor) return;
    setBusy(true);
    try {
      let result;
      switch (editor.kind) {
        case "new":
          result = await saveOwnershipAction({
            animalId,
            personId: personId || null,
            householdId: householdId || null,
            validFrom,
            validTo: validTo || null,
            note: note || null,
          });
          break;
        case "close":
          result = await closeOwnershipAction(editor.ownership.id, validTo);
          break;
        case "transfer":
          result = await transferOwnershipAction(
            editor.ownership.id,
            validTo,
            { personId: personId || null, householdId: householdId || null },
            note || null,
          );
          break;
        case "correct":
          result = await correctOwnershipAction(
            editor.ownership.id,
            { validFrom, validTo: validTo || null, note: note || null },
            editor.ownership.createdAt,
          );
          break;
        case "confirm":
          result = await recordOwnershipConfirmationAction(
            editor.ownership.id,
            confirmPersonId,
            note || null,
          );
          break;
      }
      if (result?.ok) {
        setEditor(null);
        onChanged();
      } else {
        fail(result?.reason);
      }
    } catch (error) {
      logError("owners", "ownership-save-ui", error);
      fail();
    } finally {
      setBusy(false);
    }
  };

  const current = ownerships.filter((o) => o.validTo === null || o.validTo > today);
  const past = ownerships.filter((o) => o.validTo !== null && o.validTo <= today);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Ownership</CardTitle>
          <CardDescription>
            Effective-dated owner history — intervals are never rewritten,
            transfers close one and open the next.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => open({ kind: "new" })}>
          <Plus className="h-4 w-4 mr-1" /> Record owner
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {ownerships.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No ownership records — this animal has no registered owner.
          </p>
        )}

        {current.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Current</p>
            <ul className="space-y-2">
              {current.map((o) => (
                <li
                  key={o.id}
                  className="text-sm border rounded-md p-2 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span>
                      {o.ownerName}
                      <Badge variant="secondary" className="ml-2">
                        {o.ownerKind}
                      </Badge>
                      <span className="text-muted-foreground ml-2">
                        {o.validFrom} → {o.validTo ?? "current"}
                      </span>
                    </span>
                  </div>
                  {o.note && (
                    <p className="text-muted-foreground">{o.note}</p>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <Button size="sm" variant="outline" onClick={() => open({ kind: "transfer", ownership: o })}>
                      Transfer
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => open({ kind: "close", ownership: o })}>
                      End
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => open({ kind: "confirm", ownership: o })}>
                      Record confirmation
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => open({ kind: "correct", ownership: o })}>
                      Correct
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {past.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">History</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {past.map((o) => (
                <li key={o.id}>
                  {o.ownerName} ({o.ownerKind}) — {o.validFrom} → {o.validTo}
                  {o.note ? ` · ${o.note}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {confirmations.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Annual confirmations</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {confirmations.slice(0, 5).map((c) => (
                <li key={c.id}>
                  {c.confirmedOn} — {c.personName ?? "Unknown"} via{" "}
                  {c.method === "owner-portal" ? "portal" : "staff"}
                  {c.notes ? ` · ${c.notes}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {editor && (
          <div className="border rounded-md p-3 space-y-3 text-sm bg-muted/30">
            <p className="font-medium">
              {editor.kind === "new" && "Record ownership"}
              {editor.kind === "close" && `End ownership — ${editor.ownership.ownerName}`}
              {editor.kind === "transfer" && `Transfer — ${editor.ownership.ownerName}`}
              {editor.kind === "correct" && `Correct interval — ${editor.ownership.ownerName}`}
              {editor.kind === "confirm" && `Record confirmation — ${editor.ownership.ownerName}`}
            </p>

            {(editor.kind === "new" || editor.kind === "transfer") && (
              <OwnerPicker
                persons={persons}
                households={households}
                personId={personId}
                householdId={householdId}
                onChange={({ personId, householdId }) => {
                  setPersonId(personId);
                  setHouseholdId(householdId);
                }}
              />
            )}

            {editor.kind === "confirm" && (
              <div className="space-y-1">
                <Label>Confirmed by (person)</Label>
                <Select value={confirmPersonId} onValueChange={setConfirmPersonId}>
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder="Person…" />
                  </SelectTrigger>
                  <SelectContent>
                    {persons.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.fullName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {(editor.kind === "new" || editor.kind === "correct") && (
                <div className="space-y-1">
                  <Label>Valid from</Label>
                  <Input
                    type="date"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                  />
                </div>
              )}
              {(editor.kind === "new" ||
                editor.kind === "close" ||
                editor.kind === "transfer" ||
                editor.kind === "correct") && (
                <div className="space-y-1">
                  <Label>
                    {editor.kind === "close" || editor.kind === "transfer"
                      ? "Effective / ends on"
                      : "Valid to (blank = current)"}
                  </Label>
                  <Input
                    type="date"
                    value={validTo}
                    onChange={(e) => setValidTo(e.target.value)}
                  />
                </div>
              )}
            </div>

            {editor.kind !== "close" && (
              <div className="space-y-1">
                <Label>Note (optional)</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
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
