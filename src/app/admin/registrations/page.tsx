"use client";

// Registrations (#169) — the exception-first staff surface. The page is
// organized as queues around the CURRENT registration period rather
// than a flat list:
//   1. animals that should be registered for this period but aren't
//      (lifecycle 'active'/'unconfirmed' — deceased/moved animals never
//      appear as ordinary gaps);
//   2. intake submissions awaiting staff review;
//   3. current-period registrations with an outstanding balance
//      (derived from the payments ledger — real payment truth only);
//   4. completed current-period registrations.
// Every row links to the canonical animal profile, where full
// registration history and edits live.

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { LoadError } from "@/components/admin/load-error";
import { AnimalRegistration } from "@/lib/types";
import { Eye, CircleCheckBig, Download, CircleX, RotateCcw, Link2 } from "lucide-react";
import {
  createRegistrationFromSubmissionAction,
  getReceiptUrlAction,
  getRegistrationQueuesAction,
  listConfirmationsDueAction,
  listPendingPaymentsAction,
  listRegistrationsAction,
  searchAnimalsForLinkAction,
  setRegistrationStatusAction,
} from "./actions";
import type { PendingPaymentItem } from "@/lib/registry/payments";
import type { ConfirmationEligibilityRow } from "@/lib/registry/ownership";
import {
  createRegistrationAction,
} from "@/app/admin/animals/[id]/actions";
import {
  formatRegistrationTimestamp,
  RegistrationStatus,
} from "@/lib/animal-registration";
import {
  REGISTRATION_PAYMENT_STATE_LABELS,
  registrationPeriodLabel,
} from "@/lib/registrations";
import type {
  RegistrationQueues,
} from "@/lib/registry/registrations";
import type { AnimalSearchHit } from "@/lib/registry/animals";
import { RegistrationStatusBadge } from "@/components/admin/registration-status-badge";
import { logError } from "@/lib/logger";

function cents(v: number, currency = "USD"): string {
  return `${(v / 100).toFixed(2)} ${currency}`;
}

export default function RegistrationsPage() {
  const [registrations, setRegistrations] = useState<AnimalRegistration[]>([]);
  const [queues, setQueues] = useState<RegistrationQueues | null>(null);
  const [pendingPayments, setPendingPayments] = useState<PendingPaymentItem[]>([]);
  const [confirmations, setConfirmations] = useState<ConfirmationEligibilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<AnimalRegistration | null>(null);
  // Submission → animal linking dialog state.
  const [linking, setLinking] = useState<AnimalRegistration | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<AnimalSearchHit[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);
  // One mutation at a time: status changes and receipt lookups are
  // serialized so a double-click can never fire the same write twice.
  const mutation = useMutation();
  const { toast } = useToast();

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      // Postgres returns submissions newest-first (submitted_at DESC);
      // every stored row has a timestamp, so nothing is silently hidden.
      const [subs, q, pending, confs] = await Promise.all([
        listRegistrationsAction(),
        getRegistrationQueuesAction(),
        listPendingPaymentsAction(),
        listConfirmationsDueAction(),
      ]);
      setRegistrations(subs);
      setQueues(q);
      setPendingPayments(pending);
      setConfirmations(confs);
    } catch (error) {
      logError("admin", "registrations-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const setStatus = (id: string, status: RegistrationStatus) => {
    mutation.run(async () => {
      try {
        const result = await setRegistrationStatusAction(id, status);
        if (!result.ok) {
          toast({
            title: "Error",
            description: "Failed to update registration status. Try again.",
            variant: "destructive",
          });
          return;
        }

        setRegistrations((prev) =>
          prev.map((reg) => (reg.id === id ? { ...reg, status } : reg)),
        );

        toast({
          title: "Registration Updated",
          description: `Status changed to ${status}.`,
        });
      } catch (error) {
        logError("admin", "registration-update", error);
        toast({
          title: "Error",
          description: "Failed to update registration status. Try again.",
          variant: "destructive",
        });
      }
    }, `status-${id}`);
  };

  const handleViewReceipt = (registration: AnimalRegistration) => {
    const receipt = registration.paymentReceipt;
    if (!receipt) {
      toast({
        title: "No Receipt",
        description: "No payment receipt was uploaded for this registration.",
        variant: "destructive",
      });
      return;
    }

    mutation.run(async () => {
      try {
        // Postgres stores the object path ("receipts/<submissionId>");
        // the server action mints a short-lived signed URL so the
        // object itself stays private.
        const result = receipt.startsWith("http")
          ? { ok: true, url: receipt }
          : await getReceiptUrlAction(receipt);
        if (!result.ok || !result.url) throw new Error("no signed url");
        window.open(result.url, "_blank");
      } catch (error) {
        logError("admin", "receipt-view", error);
        toast({
          title: "Error",
          description: "Could not load the payment receipt. Try again.",
          variant: "destructive",
        });
      }
    }, `receipt-${registration.id}`);
  };

  const registerAnimal = (animalId: string) => {
    mutation.run(async () => {
      try {
        const result = await createRegistrationAction(animalId, {});
        if (!result.ok) {
          toast({
            title: "Couldn't register",
            description:
              result.reason === "conflict"
                ? "This animal already has a registration for this period."
                : "Failed to create the registration. Try again.",
            variant: "destructive",
          });
          return;
        }
        toast({ title: "Registration created" });
        await loadAll();
      } catch (error) {
        logError("registration", "registration-create", error);
        toast({
          title: "Error",
          description: "Failed to create the registration. Try again.",
          variant: "destructive",
        });
      }
    }, `register-${animalId}`);
  };

  const runLinkSearch = async () => {
    setLinkSearching(true);
    try {
      setLinkResults(await searchAnimalsForLinkAction(linkQuery));
    } catch (error) {
      logError("registration", "animal-search", error);
      setLinkResults([]);
    } finally {
      setLinkSearching(false);
    }
  };

  const linkSubmission = (animalId: string) => {
    if (!linking) return;
    mutation.run(async () => {
      try {
        const result = await createRegistrationFromSubmissionAction(
          animalId,
          linking.id,
        );
        if (!result.ok) {
          toast({
            title: "Couldn't register",
            description:
              result.reason === "conflict"
                ? "That animal already has a registration for this period."
                : "Failed to create the registration. Try again.",
            variant: "destructive",
          });
          return;
        }
        setLinking(null);
        toast({ title: "Registration created and linked" });
        await loadAll();
      } catch (error) {
        logError("registration", "registration-link", error);
        toast({
          title: "Error",
          description: "Failed to create the registration. Try again.",
          variant: "destructive",
        });
      }
    }, `link-${linking.id}`);
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  if (loadError) {
    return (
      <div className="p-8">
        <LoadError label="registrations" onRetry={loadAll} />
      </div>
    );
  }

  const year = queues?.year ?? new Date().getFullYear();

  return (
    <div className="p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Animal Registrations</h1>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Not registered ({year})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {queues?.unregistered.length ?? 0}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Awaiting review
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {queues?.pendingSubmissions ??
                  registrations.filter((r) => r.status === "pending").length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Outstanding balance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {queues?.outstanding.length ?? 0}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                Completed {year}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {queues?.completed.length ?? 0}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Queue: animals missing a current-period registration.
            The id is the dashboard's anchored destination — keep it. */}
        <Card id="unregistered" className="mb-8 scroll-mt-6 target:ring-2 target:ring-primary/40">
          <CardHeader>
            <CardTitle>Needs {year} registration</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Animal</TableHead>
                  <TableHead>Registry ref</TableHead>
                  <TableHead>Species</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(queues?.unregistered.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      Every active animal is registered for {year}.
                    </TableCell>
                  </TableRow>
                )}
                {queues?.unregistered.map((a) => (
                  <TableRow key={a.animalId}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/animals/${a.animalId}`}
                        className="text-primary underline"
                      >
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {a.registryRef}
                    </TableCell>
                    <TableCell className="capitalize">
                      {a.species} · {a.sex}
                    </TableCell>
                    <TableCell>{a.ownerLabel ?? "—"}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        disabled={mutation.pending}
                        onClick={() => registerAnimal(a.animalId)}
                      >
                        Register
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Queues: current-period registrations by derived payment state */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>{registrationPeriodLabel(year)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {[
              {
                title: "Outstanding balance",
                anchor: "outstanding",
                items: queues?.outstanding ?? [],
                empty: "Nothing outstanding.",
              },
              {
                title: "Completed",
                anchor: "completed",
                items: queues?.completed ?? [],
                empty: "No completed registrations yet.",
              },
            ].map((section) => (
              <div
                key={section.title}
                id={section.anchor}
                className="scroll-mt-6 rounded-md target:ring-2 target:ring-primary/40"
              >
                <h3 className="font-medium mb-2">{section.title}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Animal</TableHead>
                      <TableHead>Registered to</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead>Paid</TableHead>
                      <TableHead>Outstanding</TableHead>
                      <TableHead>State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {section.items.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          {section.empty}
                        </TableCell>
                      </TableRow>
                    )}
                    {section.items.map((r) => (
                      <TableRow key={r.registrationId}>
                        <TableCell className="font-medium">
                          <Link
                            href={`/admin/animals/${r.animalId}`}
                            className="text-primary underline"
                          >
                            {r.animalName}
                          </Link>
                          <div className="font-mono text-xs text-muted-foreground">
                            {r.registryRef}
                          </div>
                        </TableCell>
                        <TableCell>{r.ownerLabel ?? "—"}</TableCell>
                        <TableCell>{cents(r.amountDueCents, r.currency)}</TableCell>
                        <TableCell>{cents(r.paidCents, r.currency)}</TableCell>
                        <TableCell>{cents(r.outstandingCents, r.currency)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              r.paymentState === "unpaid" ||
                              r.paymentState === "partial"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {REGISTRATION_PAYMENT_STATE_LABELS[r.paymentState]}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Ownership relationships past their annual re-affirmation —
            #177 dashboard destination (#confirmations). Staff record the
            confirmation on the animal's profile ownership panel. */}
        <Card id="confirmations" className="mb-8 scroll-mt-6 target:ring-2 target:ring-primary/40">
          <CardHeader>
            <CardTitle>Ownership confirmations overdue</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Animal</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Confirmation due</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {confirmations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      Every current ownership is confirmed for the year.
                    </TableCell>
                  </TableRow>
                )}
                {confirmations.map((c) => (
                  <TableRow key={c.ownershipId}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/admin/animals/${c.animalId}`}
                        className="text-primary underline"
                      >
                        {c.animalName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {c.personName ?? c.householdName ?? "—"}
                    </TableCell>
                    <TableCell>{c.dueOn}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" asChild>
                        <Link href={`/admin/animals/${c.animalId}`}>
                          Open profile
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Declared money awaiting reconciliation (#170) — pending
            transfers never settle a balance until staff confirm them.
            #177 dashboard destination (#awaiting-confirmation). */}
        <Card id="awaiting-confirmation" className="mb-8 scroll-mt-6 target:ring-2 target:ring-primary/40">
          <CardHeader>
            <CardTitle>Payments awaiting confirmation</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Animal</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Declared</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingPayments.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No unconfirmed payments.
                    </TableCell>
                  </TableRow>
                )}
                {pendingPayments.map((p) => (
                  <TableRow key={p.paymentId}>
                    <TableCell className="font-medium">
                      {p.animalId ? (
                        <Link
                          href={`/admin/animals/${p.animalId}`}
                          className="text-primary underline"
                        >
                          {p.animalName ?? "—"}
                        </Link>
                      ) : (
                        "—"
                      )}
                      {p.registryRef && (
                        <div className="font-mono text-xs text-muted-foreground">
                          {p.registryRef}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{cents(p.amountCents, p.currency)}</TableCell>
                    <TableCell className="capitalize">
                      {p.method.replace("-", " ")}
                    </TableCell>
                    <TableCell>{p.reference ?? "—"}</TableCell>
                    <TableCell>{p.occurredAt.slice(0, 10)}</TableCell>
                    <TableCell>
                      {p.animalId ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/admin/animals/${p.animalId}`}>
                            Review
                          </Link>
                        </Button>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Intake submissions — public-form claims awaiting staff review.
            #177 dashboard destination (#submissions). */}
        <Card id="submissions" className="scroll-mt-6 target:ring-2 target:ring-primary/40">
          <CardHeader>
            <CardTitle>Intake submissions</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Animals</TableHead>
                  <TableHead>Total Fee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registrations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No submissions yet.
                    </TableCell>
                  </TableRow>
                )}
                {registrations.map((registration) => (
                  <TableRow key={registration.id}>
                    <TableCell>
                      {formatRegistrationTimestamp(registration.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{registration.ownerInfo?.name ?? "—"}</div>
                        <div className="text-sm text-muted-foreground">{registration.ownerInfo?.phone ?? ""}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        {(registration.animals ?? []).map((animal, index) => (
                          <div key={index} className="text-sm">
                            <div className="font-medium">{animal.name}</div>
                            <div className="text-muted-foreground">
                              {animal.type} • {animal.sex} • {animal.isFixed === "yes" ? "Fixed" : "Not Fixed"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>${registration.totalFee ?? "—"}</TableCell>
                    <TableCell>
                      <RegistrationStatusBadge status={registration.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label="View registration details"
                          onClick={() => setSelected(registration)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label="Register a claimed animal"
                          disabled={mutation.pending}
                          onClick={() => {
                            setLinking(registration);
                            setLinkQuery("");
                            setLinkResults([]);
                          }}
                        >
                          <Link2 className="h-4 w-4" />
                        </Button>
                        {registration.paymentReceipt && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="View payment receipt"
                            disabled={mutation.pending}
                            onClick={() => handleViewReceipt(registration)}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                        {registration.status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              aria-label="Verify registration"
                              disabled={mutation.pending}
                              onClick={() => setStatus(registration.id, "approved")}
                            >
                              <CircleCheckBig className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              aria-label="Reject registration"
                              disabled={mutation.pending}
                              onClick={() => setStatus(registration.id, "rejected")}
                            >
                              <CircleX className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {(registration.status === "approved" || registration.status === "rejected") && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Reopen registration as pending"
                            disabled={mutation.pending}
                            onClick={() => setStatus(registration.id, "pending")}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Submission → animal linking */}
        <Dialog
          open={linking !== null}
          onOpenChange={(open) => !open && setLinking(null)}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Register a claimed animal</DialogTitle>
              <DialogDescription>
                Pick the registry animal this submission covers. The
                registration keeps a link to the submission; matching is
                always your choice — intake text never auto-matches.
              </DialogDescription>
            </DialogHeader>
            {linking && (
              <div className="space-y-3 text-sm">
                <div>
                  <p className="font-medium">Claimed animals</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {(linking.animals ?? []).map((a, i) => (
                      <li key={i}>
                        {a.name} — {a.type}, {a.sex}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={linkQuery}
                    onChange={(e) => setLinkQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        runLinkSearch();
                      }
                    }}
                    placeholder="Search by name, registry ref, owner, or chip"
                    aria-label="Search registry animals"
                  />
                  <Button
                    variant="outline"
                    onClick={runLinkSearch}
                    disabled={linkSearching}
                  >
                    Search
                  </Button>
                </div>
                <ul className="divide-y max-h-64 overflow-y-auto">
                  {linkResults.map((hit) => (
                    <li
                      key={hit.animal.id}
                      className="py-2 flex items-center justify-between gap-3"
                    >
                      <div>
                        <p className="font-medium">
                          {hit.animal.name}
                          <span className="font-mono text-xs text-muted-foreground ml-2">
                            {hit.animal.registryRef}
                          </span>
                        </p>
                        <p className="text-muted-foreground capitalize">
                          {hit.animal.species} · {hit.animal.sex}
                          {hit.owners.length > 0 &&
                            ` · ${hit.owners.join(", ")}`}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        disabled={mutation.pending}
                        onClick={() => linkSubmission(hit.animal.id)}
                      >
                        Register
                      </Button>
                    </li>
                  ))}
                  {linkResults.length === 0 && linkQuery && !linkSearching && (
                    <li className="py-3 text-muted-foreground">
                      No matching animals — if the animal isn&apos;t in the
                      registry yet, create it from the animals page first.
                    </li>
                  )}
                </ul>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Registration detail */}
        <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Submission Details</DialogTitle>
              <DialogDescription>
                Submitted {formatRegistrationTimestamp(selected?.createdAt)}
                {" · "}Last updated {formatRegistrationTimestamp(selected?.updatedAt)}
              </DialogDescription>
            </DialogHeader>
            {selected && (
              <div className="space-y-4 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Status:</span>
                  <RegistrationStatusBadge status={selected.status} />
                </div>
                <div>
                  <h4 className="font-medium mb-1">Owner</h4>
                  <p>{selected.ownerInfo?.name ?? "—"}</p>
                  <p className="text-muted-foreground">{selected.ownerInfo?.address ?? ""}</p>
                  <p className="text-muted-foreground">
                    {selected.ownerInfo?.phone ?? ""}
                    {selected.ownerInfo?.phone && selected.ownerInfo?.email ? " · " : ""}
                    {selected.ownerInfo?.email ?? ""}
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-1">Animals ({(selected.animals ?? []).length})</h4>
                  <ul className="list-disc pl-5 space-y-1">
                    {(selected.animals ?? []).map((animal, index) => (
                      <li key={index}>
                        {animal.name} — {animal.type}, {animal.sex},{" "}
                        {animal.isFixed === "yes" ? "spayed/neutered" : "not fixed"}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center justify-between border-t pt-3">
                  <span className="font-medium">Quoted fee: ${selected.totalFee ?? "—"}</span>
                  {selected.paymentReceipt && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={mutation.pending}
                      onClick={() => handleViewReceipt(selected)}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      {mutation.pendingKey === `receipt-${selected.id}`
                        ? "Loading…"
                        : "View Receipt"}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
