"use client";

// Owner portal (#166) — the owner-facing surface. Everything on this
// page comes from owner-scoped DTOs (PortalAnimal / OwnerRequestRecord /
// PersonRecord): no staff fields, no other owners' data, nothing a
// public animal DTO wouldn't already show plus the owner's own contact
// details. Mutations go through portal/actions.ts, which re-authorize
// every call server-side.

import { useState, useTransition } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { PortalSignOut } from "./portal-sign-out";
import {
  cancelOwnerRequestAction,
  confirmAnimalAction,
  reportMissingAction,
  requestRegistrationAction,
  submitOwnerReportAction,
  updateOwnerProfileAction,
} from "./actions";
import { isReceiptFile, RECEIPT_MAX_BYTES } from "@/lib/animal-registration";
import { logError } from "@/lib/logger";
import {
  OWNER_REQUEST_KIND_LABELS,
  OWNER_SUBMITTABLE_KINDS,
} from "@/lib/registry/owner-request-kinds";
import type {
  PortalAnimal,
  PortalPastAnimal,
} from "@/lib/registry/ownership";
import { getAnimalLifecycleLabel } from "@/lib/animal-lifecycle";
import { useMotionTransition } from "@/lib/animations";
import {
  OUTSTANDING_PAYMENT_STATES,
  REGISTRATION_PAYMENT_STATE_LABELS,
  registrationPeriodLabel,
} from "@/lib/registrations";
import type { HouseholdRecord, PersonRecord } from "@/lib/registry/persons";
import type { OwnerRequestRecord, OwnerRequestKind } from "@/lib/registry/owner-requests";
import { CheckCircle2, PawPrint, CircleAlert } from "lucide-react";

const REPORTABLE_KINDS = OWNER_SUBMITTABLE_KINDS;

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

// ISO date (YYYY-MM-DD) → "Oct 4, 2026". Formatted from the parts, not
// through Date, so a date-only string never shifts a day across zones.
function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
}

// Owner-facing money display: USD (the only currency registrations are
// assessed in today) reads "$95.00"; anything else keeps its code.
function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

// Exported for component tests — the status presentation carries the
// confirmation-vs-registration distinction owners must understand.
export function AnimalCard({
  animal,
  owner,
}: {
  animal: PortalAnimal;
  // The signed-in owner's own contact snapshot — shown read-only in the
  // registration request dialog. Optional so card tests can omit it.
  owner?: Pick<
    PersonRecord,
    "fullName" | "email" | "phone" | "address"
  > | null;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const statusTransition = useMotionTransition({
    duration: 0.25,
    ease: "easeOut",
  });
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestNote, setRequestNote] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  // Which action is in flight — pending already locks every control,
  // but the spinner belongs on the button the owner actually pressed
  // (#280).
  const [busyAction, setBusyAction] = useState<
    "confirm" | "report" | "missing" | "request" | null
  >(null);
  const [reportKind, setReportKind] = useState<OwnerRequestKind | "">("");
  const [detail, setDetail] = useState("");
  const [targetName, setTargetName] = useState("");
  const [targetContact, setTargetContact] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [missingOpen, setMissingOpen] = useState(false);
  const [missingReported, setMissingReported] = useState(false);
  const [missingLocation, setMissingLocation] = useState("");
  const [missingDetail, setMissingDetail] = useState("");

  // Historical registration years only — the current-period year is
  // already the status area's subject, so listing it again as history
  // would blur it.
  const priorRegistrationYears = animal.registrationYears.filter(
    (y) => y !== animal.registration?.year,
  );

  // The receipt is a second write AFTER the request row lands — the
  // same bounded upload route as the public form (claim + byte
  // validation + create-only storage). A failed upload must not undo
  // the request, only warn about the file.
  const submitRequest = () => {
    if (receiptFile && !isReceiptFile(receiptFile)) {
      setReceiptError(
        `Receipt must be a PDF or image up to ${Math.round(RECEIPT_MAX_BYTES / (1024 * 1024))} MB.`,
      );
      return;
    }
    startTransition(async () => {
      setBusyAction("request");
      try {
        const submissionId = crypto.randomUUID();
        const result = await requestRegistrationAction({
          ownershipId: animal.ownershipId,
          submissionId,
          note: requestNote || undefined,
          wantsReceipt: receiptFile !== null,
        });
        if (!result.ok) {
          toast({
            title: "Couldn't submit the request",
            description: result.error,
            variant: "destructive",
          });
          return;
        }
        let receiptDelivered = true;
        if (receiptFile) {
          try {
            const upload = await fetch(`/api/receipts/${submissionId}`, {
              method: "POST",
              headers: { "Content-Type": receiptFile.type },
              body: receiptFile,
            });
            if (!upload.ok) {
              if (upload.status !== 429) {
                logError(
                  "registration",
                  "receipt-upload",
                  new Error(`upload ${upload.status}`),
                );
              }
              receiptDelivered = false;
            }
          } catch (uploadError) {
            receiptDelivered = false;
            logError("registration", "receipt-upload", uploadError);
          }
        }
        toast({
          title: "Request submitted",
          description:
            receiptFile && !receiptDelivered
              ? `Your ${animal.registrationYear} request went through, but the receipt could not be uploaded — staff can still review the request.`
              : `SFPCA staff will review your ${animal.registrationYear} request for ${animal.name}.`,
        });
        setRequestOpen(false);
        setRequestNote("");
        setReceiptFile(null);
        setReceiptError(null);
      } finally {
        setBusyAction(null);
      }
    });
  };

  const confirm = () => {
    startTransition(async () => {
      setBusyAction("confirm");
      try {
        const result = await confirmAnimalAction(animal.ownershipId);
        toast({
          title: result.ok ? "Confirmed" : "Couldn't confirm",
          description: result.ok
            ? `Thanks — ${animal.name} is confirmed as still living on Saba with you.`
            : result.error,
          variant: result.ok ? "default" : "destructive",
        });
      } finally {
        setBusyAction(null);
      }
    });
  };

  const submitReport = () => {
    if (!reportKind) return;
    startTransition(async () => {
      setBusyAction("report");
      try {
        const result = await submitOwnerReportAction({
          ownershipId: animal.ownershipId,
          kind: reportKind,
          detail: detail || undefined,
          targetName: targetName || undefined,
          targetContact: targetContact || undefined,
          effectiveOn: effectiveOn || undefined,
        });
        toast({
          title: result.ok ? "Request submitted" : "Couldn't submit",
          description: result.ok
            ? "Staff will review your report and follow up if needed."
            : result.error,
          variant: result.ok ? "default" : "destructive",
        });
        if (result.ok) {
          setReportKind("");
          setDetail("");
          setTargetName("");
          setTargetContact("");
          setEffectiveOn("");
        }
      } finally {
        setBusyAction(null);
      }
    });
  };

  const reportMissing = () => {
    startTransition(async () => {
      setBusyAction("missing");
      try {
        const result = await reportMissingAction({
          ownershipId: animal.ownershipId,
          lastSeenLocation: missingLocation || undefined,
          detail: missingDetail || undefined,
        });
        if (result.ok) {
          setMissingReported(true);
          setMissingOpen(false);
          toast({
            title: "Missing report sent",
            description:
              "SFPCA staff have been notified and will start looking. We'll contact you if the animal is found.",
          });
        } else {
          toast({
            title: "Couldn't send the report",
            description: result.error,
            variant: "destructive",
          });
        }
      } finally {
        setBusyAction(null);
      }
    });
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div className="flex items-start gap-4">
          {animal.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={animal.photoUrl}
              alt={animal.name}
              className="h-16 w-16 rounded-md object-cover shrink-0"
            />
          ) : (
            <div className="h-16 w-16 rounded-md bg-muted flex items-center justify-center shrink-0">
              <PawPrint className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-medium">{animal.name}</h3>
              {animal.basis === "household" && (
                <Badge variant="secondary">{animal.householdName}</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground capitalize">
              {animal.species} · {animal.sex}
              {animal.approxAge ? ` · ${animal.approxAge}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              With you since {formatIsoDate(animal.validFrom)}
            </p>
            {animal.chipNumber && (
              <p className="text-xs text-muted-foreground">
                Microchip: <span className="font-mono">{animal.chipNumber}</span>
              </p>
            )}
          </div>
        </div>

        {/* Two separate annual obligations live on this card (#295):
            - the annual confirmation is an ownership/residency
              attestation — "still living on Saba with me" (#166) —
              self-served by the button below;
            - the yearly registration is the authoritative registry
              record (#169) with a ledger-derived fee (#170), reached
              through the public intake form.
            Each gets its own labelled status area so one can never be
            mistaken for the other. */}
        <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Annual confirmation
            </p>
            {/* The keyed remount animates due → confirmed on success
                while the registration area stays visibly untouched. */}
            <motion.div
              key={animal.confirmationDue ? "due" : "confirmed"}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={statusTransition}
            >
              {animal.confirmationDue ? (
                <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                  <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Due now
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  Confirmed{" "}
                  {formatIsoDate(animal.lastConfirmedOn ?? animal.validFrom)}
                </p>
              )}
            </motion.div>
            <p className="text-xs text-muted-foreground">
              Confirms {animal.name} still lives on Saba with you.
            </p>
            {animal.confirmationDue && (
              <Button
                size="sm"
                onClick={confirm}
                loading={busyAction === "confirm"}
                disabled={pending}
              >
                Confirm still living on Saba with me
              </Button>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {registrationPeriodLabel(animal.registrationYear)}
            </p>
            {animal.registration === null ? (
              animal.registrationRequest ? (
                /* In-flight portal request (#297) — the honest in-between
                   state: not yet registered, no second request allowed. */
                <>
                  <p className="text-sm font-medium">
                    {animal.registrationRequest.status === "rejected"
                      ? "Request declined"
                      : animal.registrationRequest.status === "approved"
                        ? "Approved"
                        : "Request submitted"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {animal.registrationRequest.status === "rejected" ? (
                      <>
                        Staff declined the request —{" "}
                        <Link
                          href="/contact"
                          className="text-primary underline"
                        >
                          contact us
                        </Link>{" "}
                        if you have questions.
                      </>
                    ) : animal.registrationRequest.status === "approved" ? (
                      "SFPCA is finalizing the registration."
                    ) : (
                      `Awaiting SFPCA review · sent ${formatIsoDate(animal.registrationRequest.submittedAt)}`
                    )}
                  </p>
                </>
              ) : animal.registrationCancelled ? (
                /* A cancelled row still holds the (animal, year) slot —
                   staff resolve it; an owner request can never fulfil it. */
                <>
                  <p className="text-sm font-medium">Not registered</p>
                  <p className="text-xs text-muted-foreground">
                    <Link href="/contact" className="text-primary underline">
                      Contact us
                    </Link>{" "}
                    about {animal.name}&apos;s {animal.registrationYear}{" "}
                    registration.
                  </p>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                    <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                    Not registered
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Required for every animal each year.
                  </p>
                  {/* Portal-native request (#297): prefilled from canonical
                      data, lands in the same staff review queue as the
                      public intake — never a direct registration. */}
                  <Button size="sm" onClick={() => setRequestOpen(true)}>
                    Register {animal.name} for {animal.registrationYear}
                  </Button>
                </>
              )
            ) : OUTSTANDING_PAYMENT_STATES.includes(
                animal.registration.paymentState,
              ) ? (
              <>
                <p className="text-sm font-medium text-destructive">
                  {formatMoney(
                    animal.registration.outstandingCents,
                    animal.registration.currency,
                  )}{" "}
                  outstanding
                </p>
                {animal.registration.paidCents > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(
                      animal.registration.paidCents,
                      animal.registration.currency,
                    )}{" "}
                    of{" "}
                    {formatMoney(
                      animal.registration.amountDueCents,
                      animal.registration.currency,
                    )}{" "}
                    paid
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  <Link href="/contact" className="text-primary underline">
                    Contact us
                  </Link>{" "}
                  to arrange payment.
                </p>
              </>
            ) : (
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <CheckCircle2
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                {
                  REGISTRATION_PAYMENT_STATE_LABELS[
                    animal.registration.paymentState
                  ]
                }
              </p>
            )}
            {priorRegistrationYears.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Previously registered: {priorRegistrationYears.join(", ")}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Missing is a direct lost/found case (#176), not a
              staff-reviewed change request — no ambiguity to
              adjudicate, and speed matters when an animal is lost. */}
          {missingReported ? (
            <Badge variant="secondary">Reported missing</Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMissingOpen((v) => !v)}
              disabled={pending}
            >
              {animal.name} is missing
            </Button>
          )}
          <Select
            value={reportKind}
            onValueChange={(v) => setReportKind(v as OwnerRequestKind)}
          >
            <SelectTrigger className="w-48" aria-label="Report a change">
              <SelectValue placeholder="Report a change…" />
            </SelectTrigger>
            <SelectContent>
              {REPORTABLE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {OWNER_REQUEST_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {missingOpen && (
          <div className="animate-in fade-in-0 slide-in-from-top-1 duration-ui border rounded-md p-3 space-y-3 text-sm">
            <p className="font-medium">Report {animal.name} missing</p>
            <div className="space-y-1">
              <Label htmlFor={`missing-where-${animal.ownershipId}`}>
                Where last seen (optional)
              </Label>
              <Input
                id={`missing-where-${animal.ownershipId}`}
                value={missingLocation}
                onChange={(e) => setMissingLocation(e.target.value)}
                placeholder="e.g. Windwardside, near home"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`missing-detail-${animal.ownershipId}`}>
                Anything else (optional)
              </Label>
              <Textarea
                id={`missing-detail-${animal.ownershipId}`}
                value={missingDetail}
                onChange={(e) => setMissingDetail(e.target.value)}
                rows={2}
                placeholder="When it went missing, collar colour…"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={reportMissing}
                loading={busyAction === "missing"}
                disabled={pending}
              >
                Send missing report
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMissingOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Staff will see this immediately. If {animal.name} is found
              or scanned, we&apos;ll contact you.
            </p>
          </div>
        )}

        {reportKind && (
          <div className="animate-in fade-in-0 slide-in-from-top-1 duration-ui border rounded-md p-3 space-y-3 text-sm">
            <p className="font-medium">{OWNER_REQUEST_KIND_LABELS[reportKind]}</p>
            {reportKind === "transfer" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`target-name-${animal.ownershipId}`}>
                    New owner&apos;s name
                  </Label>
                  <Input
                    id={`target-name-${animal.ownershipId}`}
                    value={targetName}
                    onChange={(e) => setTargetName(e.target.value)}
                    placeholder="Who is the animal going to?"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`target-contact-${animal.ownershipId}`}>
                    Their contact (optional)
                  </Label>
                  <Input
                    id={`target-contact-${animal.ownershipId}`}
                    value={targetContact}
                    onChange={(e) => setTargetContact(e.target.value)}
                    placeholder="Phone or email"
                  />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor={`effective-${animal.ownershipId}`}>
                Date (optional — leave blank for today)
              </Label>
              <Input
                id={`effective-${animal.ownershipId}`}
                type="date"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value)}
                className="w-48"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`detail-${animal.ownershipId}`}>
                Details for staff (optional)
              </Label>
              <Textarea
                id={`detail-${animal.ownershipId}`}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                rows={2}
                placeholder="Anything staff should know"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={submitReport}
                loading={busyAction === "report"}
                disabled={pending}
              >
                Submit request
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReportKind("")}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Reports are reviewed by staff before they take effect — your
              ownership record stays unchanged until then.
            </p>
          </div>
        )}

        {/* Registration request dialog (#297) — prefilled from the
            canonical records the portal already knows; nothing typed
            here mutates them. */}
        <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                Register {animal.name} for {animal.registrationYear}
              </DialogTitle>
              <DialogDescription>
                We&apos;ll use the information already on file. SFPCA staff
                will review the request before the registration is
                finalized.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div>
                <p className="font-medium">Animal on file</p>
                <p className="text-muted-foreground capitalize">
                  {animal.name} · {animal.species} · {animal.sex}
                  {animal.chipNumber ? ` · Microchip ${animal.chipNumber}` : ""}
                </p>
              </div>
              {owner && (
                <div>
                  <p className="font-medium">Your details on file</p>
                  <p className="text-muted-foreground">
                    {owner.fullName}
                    {owner.address ? ` · ${owner.address}` : ""}
                  </p>
                  <p className="text-muted-foreground">
                    {[owner.phone, owner.email].filter(Boolean).join(" · ") ||
                      "No contact details on file"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Out of date? Update your profile below before
                    submitting.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`request-note-${animal.ownershipId}`}>
                  Anything changed? (optional)
                </Label>
                <Textarea
                  id={`request-note-${animal.ownershipId}`}
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder="e.g. spayed/neutered recently, new phone number"
                />
                <p className="text-xs text-muted-foreground">
                  Staff see this note with your request — it doesn&apos;t
                  change your records by itself.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`request-receipt-${animal.ownershipId}`}>
                  Payment receipt (optional)
                </Label>
                <Input
                  id={`request-receipt-${animal.ownershipId}`}
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => {
                    setReceiptFile(e.target.files?.[0] ?? null);
                    setReceiptError(null);
                  }}
                />
                {receiptError ? (
                  <p className="text-xs text-destructive">{receiptError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    PDF or image, up to{" "}
                    {Math.round(RECEIPT_MAX_BYTES / (1024 * 1024))} MB —
                    only if you&apos;ve already paid.
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={submitRequest}
                  loading={busyAction === "request"}
                  disabled={pending}
                >
                  Submit request
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRequestOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The annual registration fee is set by staff when they
                review your request — you&apos;ll see it once it&apos;s
                registered.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export function PortalClient({
  person,
  animals,
  pastAnimals,
  households,
  requests,
}: {
  person: PersonRecord;
  animals: PortalAnimal[];
  pastAnimals: PortalPastAnimal[];
  households: HouseholdRecord[];
  requests: OwnerRequestRecord[];
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [fullName, setFullName] = useState(person.fullName);
  const [email, setEmail] = useState(person.email ?? "");
  const [phone, setPhone] = useState(person.phone ?? "");
  const [address, setAddress] = useState(person.address ?? "");
  const [channel, setChannel] = useState(person.preferredChannel ?? "");

  const saveProfile = () => {
    startTransition(async () => {
      setBusyAction("profile");
      try {
        const result = await updateOwnerProfileAction({
          fullName,
          email: email || null,
          phone: phone || null,
          address: address || null,
          preferredChannel: channel || null,
        });
        toast({
          title: result.ok ? "Profile saved" : "Couldn't save",
          description: result.ok ? undefined : result.error,
          variant: result.ok ? "default" : "destructive",
        });
      } finally {
        setBusyAction(null);
      }
    });
  };

  const cancelRequest = (requestId: string) => {
    startTransition(async () => {
      setBusyAction(`withdraw-${requestId}`);
      try {
        const result = await cancelOwnerRequestAction(requestId);
        toast({
          title: result.ok ? "Request cancelled" : "Couldn't cancel",
          description: result.ok ? undefined : result.error,
          variant: result.ok ? "default" : "destructive",
        });
      } finally {
        setBusyAction(null);
      }
    });
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Owner Portal</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {person.fullName}
          </p>
        </div>
        <PortalSignOut />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your animals</h2>
        <p className="text-sm text-muted-foreground">
          Each animal needs two separate things every year — a confirmation
          that it still lives on Saba with you, and its annual registration.
        </p>
        {animals.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              <p>
                No animals are currently registered to you. If you believe
                this is wrong, contact us through the{" "}
                <Link href="/contact" className="text-primary underline">
                  contact page
                </Link>
                .
              </p>
            </CardContent>
          </Card>
        ) : (
          animals.map((animal) => (
            <AnimalCard
              key={animal.ownershipId}
              animal={animal}
              owner={person}
            />
          ))
        )}
      </section>

      {pastAnimals.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Previously with you</h2>
          <Card>
            <CardContent className="pt-6">
              <ul className="divide-y">
                {pastAnimals.map((a) => (
                  <li
                    key={a.animalId}
                    className="py-3 flex items-center gap-3 text-sm"
                  >
                    {a.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.photoUrl}
                        alt={a.name}
                        className="h-10 w-10 rounded-md object-cover shrink-0"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0">
                        <PawPrint className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div>
                      <p className="font-medium">
                        {a.name}
                        {a.basis === "household" && a.householdName
                          ? ` (${a.householdName})`
                          : ""}
                      </p>
                      <p className="text-muted-foreground capitalize">
                        {a.species} · {a.sex}
                        {a.approxAge ? ` · ${a.approxAge}` : ""} ·{" "}
                        {getAnimalLifecycleLabel(a.lifecycleStatus)} · with you{" "}
                        {a.validFrom} → {a.validTo}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}

      {requests.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Your requests</h2>
          <Card>
            <CardContent className="pt-6">
              <ul className="divide-y">
                {requests.map((r) => (
                  <li
                    key={r.id}
                    className="py-3 flex items-center justify-between gap-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {OWNER_REQUEST_KIND_LABELS[r.kind as OwnerRequestKind] ??
                          r.kind}
                        {r.animalName ? ` — ${r.animalName}` : ""}
                      </p>
                      <p className="text-muted-foreground">
                        Submitted {r.createdAt.slice(0, 10)}
                        {r.status !== "pending" &&
                          ` · ${r.status} ${r.resolvedAt?.slice(0, 10) ?? ""}`}
                      </p>
                    </div>
                    {r.status === "pending" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancelRequest(r.id)}
                        loading={busyAction === `withdraw-${r.id}`}
                        disabled={pending}
                      >
                        Withdraw
                      </Button>
                    ) : (
                      <Badge variant="outline">{r.status}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}

      {households.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Household</h2>
          {households.map((h) => (
            <Card key={h.id}>
              <CardHeader>
                <h3 className="font-medium">{h.name}</h3>
                {h.address && (
                  <CardDescription>{h.address}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-1">
                  {h.members.map((m) => (
                    <li key={m.personId}>
                      {m.fullName}
                      {m.role === "primary" && (
                        <span className="text-muted-foreground">
                          {" "}
                          (primary contact)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your contact details</h2>
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="fullName">Full name</Label>
                <Input
                  id="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="phone">Phone / WhatsApp</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="preferredChannel">Preferred contact</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger id="preferredChannel">
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="phone">Phone</SelectItem>
                    <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    <SelectItem value="sms">SMS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            <Button
              onClick={saveProfile}
              loading={busyAction === "profile"}
              disabled={pending}
            >
              Save details
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
