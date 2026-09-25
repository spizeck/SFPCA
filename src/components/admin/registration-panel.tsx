"use client";

// Registrations panel (#169, ledger view #170) — the animal's
// authoritative registration history: one row per period, preserved
// forever. The panel shows the CURRENT-period state prominently
// (registered / not registered), the assessed amount and its derived
// payment state, waiver/complimentary resolutions, and cancelled rows
// as history — plus the full payment ledger per registration:
// payments, refunds, and adjustments with method/status/reference,
// and the staff actions that reconcile them (confirm, void, refund,
// adjustment). All mutations are audited server actions; confirmed
// money is never edited — corrections are new ledger rows.

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
import type {
  PaymentEventRecord,
  PaymentRecord,
} from "@/lib/registry/payments";
import {
  PAYMENT_EVENT_LABELS,
  PAYMENT_KIND_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
} from "@/lib/payments";
import {
  REGISTRATION_PAYMENT_STATE_LABELS,
  REGISTRATION_RESOLUTION_LABELS,
  registrationPeriodLabel,
} from "@/lib/registrations";
import {
  cancelRegistrationAction,
  confirmPaymentAction,
  correctRegistrationAmountAction,
  createRegistrationAction,
  recordPaymentAdjustmentAction,
  recordRegistrationPaymentAction,
  refundPaymentAction,
  resolveRegistrationFeeAction,
  updateRegistrationNotesAction,
  voidPaymentAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import { logError } from "@/lib/logger";
import { CircleAlert, Plus } from "lucide-react";

type Editor =
  | { kind: "register" }
  | { kind: "payment"; record: RegistrationRecord }
  | { kind: "confirm"; record: RegistrationRecord; payment: PaymentRecord }
  | { kind: "void"; record: RegistrationRecord; payment: PaymentRecord }
  | { kind: "refund"; record: RegistrationRecord; payment: PaymentRecord }
  | { kind: "adjustment"; record: RegistrationRecord; payment?: PaymentRecord }
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

// Ledger-line sign: payments and positive adjustments add settled
// money; refunds and negative adjustments subtract. Rendered so the
// arithmetic in the balance summary is readable off the list.
function signedAmount(p: PaymentRecord): string {
  if (p.kind === "refund") return `−${formatMoney(p.amountCents, p.currency)}`;
  if (p.kind === "adjustment") {
    const sign = p.amountCents >= 0 ? "+" : "−";
    return `${sign}${formatMoney(Math.abs(p.amountCents), p.currency)}`;
  }
  return `+${formatMoney(p.amountCents, p.currency)}`;
}

export function RegistrationPanel({
  animalId,
  registrations = [],
  payments = [],
  paymentEvents = [],
  currentYear,
  today,
  onChanged,
}: {
  animalId: string;
  registrations?: RegistrationRecord[];
  payments?: PaymentRecord[];
  paymentEvents?: PaymentEventRecord[];
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
  const [pending, setPending] = useState(false);
  const [reference, setReference] = useState("");
  const [resolution, setResolution] = useState<"waived" | "complimentary">(
    "waived",
  );
  const [cancelReason, setCancelReason] = useState<
    "correction" | "withdrawn"
  >("correction");
  const [note, setNote] = useState("");
  // Required-reason editors (void, refund, adjustment).
  const [reason, setReason] = useState("");
  // Client-generated dedupe handle per editor session — a retried
  // submission resolves to the row it already created server-side.
  const [idempotencyKey, setIdempotencyKey] = useState("");

  const open = (e: Editor) => {
    setEditor(e);
    setNote("");
    setReason("");
    setMethod("cash");
    setOccurredOn(today);
    setPending(false);
    setReference("");
    setResolution("waived");
    setCancelReason("correction");
    setIdempotencyKey(crypto.randomUUID());
    if (e.kind === "payment") {
      const outstanding = e.record.amountDueCents - e.record.paidCents;
      setAmountDollars((Math.max(outstanding, 0) / 100).toFixed(2));
    } else if (e.kind === "correct-amount") {
      setAmountDollars((e.record.amountDueCents / 100).toFixed(2));
    } else if (e.kind === "refund") {
      setAmountDollars((e.payment.amountCents / 100).toFixed(2));
    } else if (e.kind === "notes") {
      setNote(e.record.notes ?? "");
      setAmountDollars("");
    } else {
      setAmountDollars("");
    }
  };

  const fail = (result?: SaveResult) => {
    const reasonText = result?.reason;
    toast({
      title: "Couldn't save",
      description:
        reasonText === "conflict"
          ? "The record changed — reload and try again."
          : reasonText === "exceeds-refundable"
            ? "That would refund more than this payment's refundable amount."
            : `Failed (${reasonText ?? "error"}).`,
      variant: "destructive",
    });
  };

  const dollarsToCents = (v: string): number | null => {
    const n = Number(v);
    if (!v.trim() || Number.isNaN(n)) return null;
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
            reference: reference || null,
            note: note || null,
            // Only a bank transfer can honestly be "claimed but not
            // yet arrived" — cash/other are either in hand or not.
            pending: pending && method === "bank-transfer",
            idempotencyKey,
          });
          break;
        }
        case "confirm":
          result = await confirmPaymentAction(editor.payment.id, {
            note: note || null,
            reference: reference || null,
          });
          break;
        case "void": {
          if (!reason.trim()) {
            toast({
              title: "A reason is required to void a payment",
              variant: "destructive",
            });
            return;
          }
          result = await voidPaymentAction(editor.payment.id, reason.trim());
          break;
        }
        case "refund": {
          const cents = dollarsToCents(amountDollars);
          if (cents === null || cents <= 0) {
            toast({
              title: "Enter a refund amount",
              variant: "destructive",
            });
            return;
          }
          if (!reason.trim()) {
            toast({
              title: "A reason is required to refund",
              variant: "destructive",
            });
            return;
          }
          result = await refundPaymentAction(editor.payment.id, {
            amountCents: cents,
            reason: reason.trim(),
            occurredOn: occurredOn || undefined,
            reference: reference || null,
            note: note || null,
          });
          break;
        }
        case "adjustment": {
          const cents = dollarsToCents(amountDollars);
          if (cents === null || cents === 0) {
            toast({
              title:
                "Enter a signed amount — positive adds settled money, negative subtracts",
              variant: "destructive",
            });
            return;
          }
          if (!reason.trim()) {
            toast({
              title: "A reason is required to adjust the ledger",
              variant: "destructive",
            });
            return;
          }
          result = await recordPaymentAdjustmentAction(editor.record.id, {
            amountCents: cents,
            reason: reason.trim(),
            relatedPaymentId: editor.payment?.id ?? null,
            occurredOn: occurredOn || undefined,
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
          if (cents === null || cents < 0) {
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

  const eventsFor = (paymentId: string) =>
    paymentEvents.filter((e) => e.paymentId === paymentId);

  const ledgerRows = (r: RegistrationRecord) => {
    const rows = payments.filter((p) => p.registrationId === r.id);
    if (rows.length === 0) return null;
    return (
      <div className="border-l-2 border-muted pl-3 space-y-2">
        {rows.map((p) => {
          const events = eventsFor(p.id);
          return (
            <div key={p.id} className="text-sm space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium tabular-nums">
                  {signedAmount(p)}
                </span>
                <span>{PAYMENT_KIND_LABELS[p.kind as keyof typeof PAYMENT_KIND_LABELS] ?? p.kind}</span>
                <Badge
                  variant={
                    p.status === "confirmed"
                      ? "secondary"
                      : p.status === "pending"
                        ? "outline"
                        : "destructive"
                  }
                >
                  {PAYMENT_STATUS_LABELS[p.status as keyof typeof PAYMENT_STATUS_LABELS] ?? p.status}
                </Badge>
                <span className="text-muted-foreground">
                  {PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method}
                  {" · "}
                  {p.occurredAt.slice(0, 10)}
                  {p.provider ? ` · ${p.provider}` : ""}
                </span>
              </div>
              {(p.reference || p.note || p.recordedBy) && (
                <p className="text-muted-foreground">
                  {p.reference ? `Ref ${p.reference}` : ""}
                  {p.reference && p.note ? " · " : ""}
                  {p.note ?? ""}
                  {(p.reference || p.note) && p.recordedBy ? " · " : ""}
                  {p.recordedBy ? `recorded by ${p.recordedBy}` : ""}
                </p>
              )}
              {events.length > 1 && (
                <p className="text-muted-foreground">
                  {events
                    .map(
                      (e) =>
                        `${PAYMENT_EVENT_LABELS[e.event as keyof typeof PAYMENT_EVENT_LABELS] ?? e.event} ${e.createdAt.slice(0, 10)}${e.actorLabel ? ` (${e.actorLabel})` : ""}`,
                    )
                    .join(" · ")}
                </p>
              )}
              {r.status === "active" && (
                <div className="flex gap-2 flex-wrap">
                  {p.status === "pending" && p.kind === "payment" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          open({ kind: "confirm", record: r, payment: p })
                        }
                      >
                        Confirm received
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          open({ kind: "void", record: r, payment: p })
                        }
                      >
                        Void
                      </Button>
                    </>
                  )}
                  {p.status === "confirmed" && p.kind === "payment" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          open({ kind: "refund", record: r, payment: p })
                        }
                      >
                        Refund
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          open({ kind: "adjustment", record: r, payment: p })
                        }
                      >
                        Adjust
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const row = (r: RegistrationRecord) => (
    <li key={r.id} className="text-sm border rounded-md p-2 space-y-2">
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
          ` · ${formatMoney(r.paidCents, r.currency)} settled`}
        {r.outstandingCents > 0 &&
          ` · ${formatMoney(r.outstandingCents, r.currency)} outstanding`}
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
      {ledgerRows(r)}
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
            onClick={() => open({ kind: "adjustment", record: r })}
          >
            Ledger adjustment
          </Button>
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

  const editorTitle = () => {
    if (!editor) return "";
    switch (editor.kind) {
      case "register":
        return `Register animal — ${registrationPeriodLabel(currentYear)}`;
      case "payment":
        return `Record payment — ${registrationPeriodLabel(editor.record.year)}`;
      case "confirm":
        return `Confirm payment received — ${signedAmount(editor.payment)}`;
      case "void":
        return `Void pending payment — ${signedAmount(editor.payment)}`;
      case "refund":
        return `Refund payment — ${signedAmount(editor.payment)}`;
      case "adjustment":
        return `Ledger adjustment — ${registrationPeriodLabel(editor.record.year)}`;
      case "resolve":
        return `Waive / complimentary — ${registrationPeriodLabel(editor.record.year)}`;
      case "cancel":
        return `Cancel registration — ${registrationPeriodLabel(editor.record.year)}`;
      case "correct-amount":
        return `Correct assessed amount — ${registrationPeriodLabel(editor.record.year)}`;
      case "notes":
        return `Staff notes — ${registrationPeriodLabel(editor.record.year)}`;
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Registrations</CardTitle>
          <CardDescription>
            One authoritative record per period — history is never
            overwritten. Balances derive from the payment ledger: only
            confirmed transactions settle money.
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
            <p className="font-medium">{editorTitle()}</p>

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
                    <Select
                      value={method}
                      onValueChange={(v) => {
                        setMethod(v);
                        if (v !== "bank-transfer") setPending(false);
                      }}
                    >
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
                  {method === "bank-transfer" && (
                    <label className="flex items-center gap-2 sm:col-span-2">
                      <input
                        type="checkbox"
                        checked={pending}
                        onChange={(e) => setPending(e.target.checked)}
                      />
                      <span>
                        Transfer claimed but not yet received — records a
                        pending entry that must be confirmed before it
                        counts
                      </span>
                    </label>
                  )}
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

              {(editor.kind === "refund" || editor.kind === "adjustment") && (
                <>
                  <div className="space-y-1">
                    <Label>
                      {editor.kind === "refund"
                        ? `Refund amount (${editor.payment.currency})`
                        : `Signed amount (${editor.record.currency}) — positive adds, negative subtracts`}
                    </Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={amountDollars}
                      onChange={(e) => setAmountDollars(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Effective date</Label>
                    <Input
                      type="date"
                      value={occurredOn}
                      onChange={(e) => setOccurredOn(e.target.value)}
                    />
                  </div>
                </>
              )}

              {(editor.kind === "payment" ||
                editor.kind === "confirm" ||
                editor.kind === "refund") && (
                <div className="space-y-1">
                  <Label>
                    {editor.kind === "confirm"
                      ? "Reference (e.g. bank confirmation — optional)"
                      : "Reference (optional)"}
                  </Label>
                  <Input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Bank ref, receipt no."
                  />
                </div>
              )}

              {(editor.kind === "void" ||
                editor.kind === "refund" ||
                editor.kind === "adjustment") && (
                <div className="space-y-1 sm:col-span-2">
                  <Label>Reason (required)</Label>
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={
                      editor.kind === "void"
                        ? "Why this pending entry is being cancelled"
                        : editor.kind === "refund"
                          ? "Why money is being returned"
                          : "What was wrong and what this corrects"
                    }
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
