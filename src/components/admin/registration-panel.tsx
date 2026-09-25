"use client";

// Registrations panel (#169) — the animal's authoritative registration
// history: one row per period, preserved forever. The panel shows the
// CURRENT-period state prominently (registered / not registered), the
// assessed amount and its derived payment state (from the payments
// ledger — never a status), waiver/complimentary resolutions, and
// cancelled rows as history. All mutations are audited server actions;
// corrections and cancellations keep the row.

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
import type { RegistrationRecord } from "@/lib/registry/registrations";
import {
  REGISTRATION_PAYMENT_STATE_LABELS,
  REGISTRATION_RESOLUTION_LABELS,
  registrationPeriodLabel,
} from "@/lib/registrations";
import {
  cancelRegistrationAction,
  correctRegistrationAmountAction,
  createRegistrationAction,
  recordRegistrationPaymentAction,
  resolveRegistrationFeeAction,
  updateRegistrationNotesAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import { logError } from "@/lib/logger";
import { CircleAlert, Plus } from "lucide-react";

type Editor =
  | { kind: "register" }
  | { kind: "payment"; record: RegistrationRecord }
  | { kind: "resolve"; record: RegistrationRecord }
  | { kind: "cancel"; record: RegistrationRecord }
  | { kind: "correct-amount"; record: RegistrationRecord }
  | { kind: "notes"; record: RegistrationRecord };

const CANCELLATION_LABELS: Record<string, string> = {
  correction: "Corrected — recorded in error",
  withdrawn: "Withdrawn",
};

function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function RegistrationPanel({
  animalId,
  registrations = [],
  currentYear,
  today,
  onChanged,
}: {
  animalId: string;
  registrations?: RegistrationRecord[];
  currentYear: number;
  today: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);

  const [amountDollars, setAmountDollars] = useState("");
  const [method, setMethod] = useState<string>("cash");
  const [occurredOn, setOccurredOn] = useState(today);
  const [resolution, setResolution] = useState<"waived" | "complimentary">(
    "waived",
  );
  const [cancelReason, setCancelReason] = useState<
    "correction" | "withdrawn"
  >("correction");
  const [note, setNote] = useState("");

  const open = (e: Editor) => {
    setEditor(e);
    setNote("");
    setMethod("cash");
    setOccurredOn(today);
    setResolution("waived");
    setCancelReason("correction");
    if (e.kind === "payment") {
      const outstanding = e.record.amountDueCents - e.record.paidCents;
      setAmountDollars((Math.max(outstanding, 0) / 100).toFixed(2));
    } else if (e.kind === "correct-amount") {
      setAmountDollars((e.record.amountDueCents / 100).toFixed(2));
    } else if (e.kind === "notes") {
      setNote(e.record.notes ?? "");
    } else {
      setAmountDollars("");
    }
  };

  const fail = (result?: SaveResult) => {
    const reason = result?.reason;
    toast({
      title: "Couldn't save",
      description:
        reason === "conflict"
          ? "A registration for this period already exists, or the record changed — reload and try again."
          : `Failed (${reason ?? "error"}).`,
      variant: "destructive",
    });
  };

  const dollarsToCents = (v: string): number | null => {
    const n = Number(v);
    if (!v.trim() || Number.isNaN(n) || n < 0) return null;
    return Math.round(n * 100);
  };

  const submit = async () => {
    if (!editor) return;
    setBusy(true);
    try {
      let result: SaveResult | undefined;
      switch (editor.kind) {
        case "register":
          result = await createRegistrationAction(animalId, {
            year: currentYear,
            notes: note || null,
          });
          break;
        case "payment": {
          const cents = dollarsToCents(amountDollars);
          if (cents === null || cents <= 0) {
            toast({
              title: "Enter a payment amount",
              variant: "destructive",
            });
            return;
          }
          result = await recordRegistrationPaymentAction(editor.record.id, {
            amountCents: cents,
            method: method as "cash" | "bank-transfer" | "other",
            occurredOn: occurredOn || undefined,
            note: note || null,
          });
          break;
        }
        case "resolve":
          result = await resolveRegistrationFeeAction(
            editor.record.id,
            resolution,
            note || null,
          );
          break;
        case "cancel":
          result = await cancelRegistrationAction(
            editor.record.id,
            cancelReason,
            note || null,
          );
          break;
        case "correct-amount": {
          const cents = dollarsToCents(amountDollars);
          if (cents === null) {
            toast({ title: "Enter an amount", variant: "destructive" });
            return;
          }
          result = await correctRegistrationAmountAction(
            editor.record.id,
            cents,
            note || null,
          );
          break;
        }
        case "notes":
          result = await updateRegistrationNotesAction(
            editor.record.id,
            note || null,
          );
          break;
      }
      if (result?.ok) {
        setEditor(null);
        onChanged();
      } else {
        fail(result);
      }
    } catch (error) {
      logError("registration", "registration-save-ui", error);
      fail();
    } finally {
      setBusy(false);
    }
  };

  const active = registrations.filter((r) => r.status === "active");
  const cancelled = registrations.filter((r) => r.status === "cancelled");
  const current = active.find((r) => r.year === currentYear);

  const row = (r: RegistrationRecord) => (
    <li key={r.id} className="text-sm border rounded-md p-2 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{registrationPeriodLabel(r.year)}</span>
        {r.status === "cancelled" ? (
          <Badge variant="outline">
            Cancelled —{" "}
            {CANCELLATION_LABELS[r.cancellationReason ?? ""] ?? "withdrawn"}
          </Badge>
        ) : (
          <Badge
            variant={
              r.paymentState === "unpaid" || r.paymentState === "partial"
                ? "destructive"
                : "secondary"
            }
          >
            {REGISTRATION_PAYMENT_STATE_LABELS[r.paymentState]}
          </Badge>
        )}
        {r.resolution && (
          <Badge variant="outline">
            {REGISTRATION_RESOLUTION_LABELS[
              r.resolution as keyof typeof REGISTRATION_RESOLUTION_LABELS
            ] ?? r.resolution}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground">
        {formatMoney(r.amountDueCents, r.currency)} due
        {r.paidCents > 0 &&
          ` · ${formatMoney(r.paidCents, r.currency)} recorded`}
        {r.registeredAt
          ? ` · registered ${r.registeredAt.slice(0, 10)}`
          : ""}
        {r.ownerLabel ? ` · registered to ${r.ownerLabel}` : " · no owner on record"}
      </p>
      {r.cancellationNote && (
        <p className="text-muted-foreground">{r.cancellationNote}</p>
      )}
      {r.resolutionNote && (
        <p className="text-muted-foreground">
          {r.resolution}: {r.resolutionNote}
        </p>
      )}
      {r.notes && <p className="text-muted-foreground">{r.notes}</p>}
      {r.status === "active" && (
        <div className="flex gap-2 flex-wrap">
          {(r.paymentState === "unpaid" || r.paymentState === "partial") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => open({ kind: "payment", record: r })}
            >
              Record payment
            </Button>
          )}
          {r.resolution === null && r.amountDueCents > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => open({ kind: "resolve", record: r })}
            >
              Waive / complimentary
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => open({ kind: "correct-amount", record: r })}
          >
            Correct amount
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => open({ kind: "notes", record: r })}
          >
            Notes
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => open({ kind: "cancel", record: r })}
          >
            Cancel registration
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Registrations</CardTitle>
          <CardDescription>
            One authoritative record per period — history is never
            overwritten. Amount paid is derived from the payments ledger.
          </CardDescription>
        </div>
        {!current && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => open({ kind: "register" })}
          >
            <Plus className="h-4 w-4 mr-1" /> Register for {currentYear}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-sm">
          {current ? (
            <>
              <Badge variant="secondary">
                {registrationPeriodLabel(currentYear)} — registered
              </Badge>
              <span className="text-muted-foreground">
                {REGISTRATION_PAYMENT_STATE_LABELS[current.paymentState]}
                {current.paidCents > 0 &&
                  ` (${formatMoney(current.paidCents, current.currency)} of ${formatMoney(current.amountDueCents, current.currency)})`}
              </span>
            </>
          ) : (
            <Badge variant="outline" className="gap-1">
              <CircleAlert className="h-3 w-3" />
              Not registered for {currentYear}
            </Badge>
          )}
        </div>

        {active.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Registrations</p>
            <ul className="space-y-2">{active.map(row)}</ul>
          </div>
        )}

        {cancelled.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Cancelled records</p>
            <ul className="space-y-2 opacity-75">{cancelled.map(row)}</ul>
          </div>
        )}

        {registrations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No registrations on record — the animal stays in the registry
            regardless; registration is per-period.
          </p>
        )}

        {editor && (
          <div className="border rounded-md p-3 space-y-3 text-sm bg-muted/30">
            <p className="font-medium">
              {editor.kind === "register" &&
                `Register animal — ${registrationPeriodLabel(currentYear)}`}
              {editor.kind === "payment" &&
                `Record payment — ${registrationPeriodLabel(editor.record.year)}`}
              {editor.kind === "resolve" &&
                `Waive / complimentary — ${registrationPeriodLabel(editor.record.year)}`}
              {editor.kind === "cancel" &&
                `Cancel registration — ${registrationPeriodLabel(editor.record.year)}`}
              {editor.kind === "correct-amount" &&
                `Correct assessed amount — ${registrationPeriodLabel(editor.record.year)}`}
              {editor.kind === "notes" &&
                `Staff notes — ${registrationPeriodLabel(editor.record.year)}`}
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {editor.kind === "payment" && (
                <>
                  <div className="space-y-1">
                    <Label>Amount received ({editor.record.currency})</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={amountDollars}
                      onChange={(e) => setAmountDollars(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Method</Label>
                    <Select value={method} onValueChange={setMethod}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cash">Cash</SelectItem>
                        <SelectItem value="bank-transfer">
                          Bank transfer
                        </SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Received on</Label>
                    <Input
                      type="date"
                      value={occurredOn}
                      onChange={(e) => setOccurredOn(e.target.value)}
                    />
                  </div>
                </>
              )}

              {editor.kind === "resolve" && (
                <div className="space-y-1">
                  <Label>Resolution</Label>
                  <Select
                    value={resolution}
                    onValueChange={(v) =>
                      setResolution(v as "waived" | "complimentary")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="waived">Fee waived</SelectItem>
                      <SelectItem value="complimentary">
                        Complimentary — no fee applies
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {editor.kind === "cancel" && (
                <div className="space-y-1">
                  <Label>Why is this registration being cancelled?</Label>
                  <Select
                    value={cancelReason}
                    onValueChange={(v) =>
                      setCancelReason(v as "correction" | "withdrawn")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="correction">
                        Correction — the record was wrong
                      </SelectItem>
                      <SelectItem value="withdrawn">
                        Withdrawn — registration ended
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {editor.kind === "correct-amount" && (
                <div className="space-y-1">
                  <Label>Correct amount due ({editor.record.currency})</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amountDollars}
                    onChange={(e) => setAmountDollars(e.target.value)}
                  />
                </div>
              )}

              <div className="space-y-1 sm:col-span-2">
                <Label>
                  {editor.kind === "cancel"
                    ? "Reason (required for corrections)"
                    : editor.kind === "notes"
                      ? "Notes"
                      : "Note (optional)"}
                </Label>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={
                    editor.kind === "cancel"
                      ? "What was wrong / why withdrawn"
                      : undefined
                  }
                />
              </div>
            </div>

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
