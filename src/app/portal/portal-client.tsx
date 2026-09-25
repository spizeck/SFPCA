"use client";

// Owner portal (#166) — the owner-facing surface. Everything on this
// page comes from owner-scoped DTOs (PortalAnimal / OwnerRequestRecord /
// PersonRecord): no staff fields, no other owners' data, nothing a
// public animal DTO wouldn't already show plus the owner's own contact
// details. Mutations go through portal/actions.ts, which re-authorize
// every call server-side.

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
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
  submitOwnerReportAction,
  updateOwnerProfileAction,
} from "./actions";
import {
  OWNER_REQUEST_KIND_LABELS,
  OWNER_SUBMITTABLE_KINDS,
} from "@/lib/registry/owner-request-kinds";
import type {
  PortalAnimal,
  PortalPastAnimal,
} from "@/lib/registry/ownership";
import { getAnimalLifecycleLabel } from "@/lib/animal-lifecycle";
import type { HouseholdRecord, PersonRecord } from "@/lib/registry/persons";
import type { OwnerRequestRecord, OwnerRequestKind } from "@/lib/registry/owner-requests";
import { CheckCircle2, PawPrint, CircleAlert } from "lucide-react";

const REPORTABLE_KINDS = OWNER_SUBMITTABLE_KINDS;

function AnimalCard({ animal }: { animal: PortalAnimal }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [reportKind, setReportKind] = useState<OwnerRequestKind | "">("");
  const [detail, setDetail] = useState("");
  const [targetName, setTargetName] = useState("");
  const [targetContact, setTargetContact] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");

  const confirm = () => {
    startTransition(async () => {
      const result = await confirmAnimalAction(animal.ownershipId);
      toast({
        title: result.ok ? "Confirmed" : "Couldn't confirm",
        description: result.ok
          ? `Thanks — ${animal.name} is confirmed for this year.`
          : result.error,
        variant: result.ok ? "default" : "destructive",
      });
    });
  };

  const submitReport = () => {
    if (!reportKind) return;
    startTransition(async () => {
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
              className="h-16 w-16 rounded-md object-cover flex-shrink-0"
            />
          ) : (
            <div className="h-16 w-16 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
              <PawPrint className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-medium">{animal.name}</h3>
              {animal.basis === "household" && (
                <Badge variant="secondary">{animal.householdName}</Badge>
              )}
              {animal.confirmationDue ? (
                <Badge variant="destructive" className="gap-1">
                  <CircleAlert className="h-3 w-3" />
                  Confirmation due
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Confirmed {animal.lastConfirmedOn ?? animal.validFrom}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground capitalize">
              {animal.species} · {animal.sex}
              {animal.approxAge ? ` · ${animal.approxAge}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Registered with you since {animal.validFrom}
            </p>
            {animal.chipNumber && (
              <p className="text-xs text-muted-foreground">
                Microchip: <span className="font-mono">{animal.chipNumber}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={confirm} disabled={pending || !animal.confirmationDue}>
            {animal.confirmationDue
              ? "Confirm still living on Saba with me"
              : "Confirmed for this year"}
          </Button>
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

        {reportKind && (
          <div className="border rounded-md p-3 space-y-3 text-sm">
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
              <Button size="sm" onClick={submitReport} disabled={pending}>
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
  const [fullName, setFullName] = useState(person.fullName);
  const [email, setEmail] = useState(person.email ?? "");
  const [phone, setPhone] = useState(person.phone ?? "");
  const [address, setAddress] = useState(person.address ?? "");
  const [channel, setChannel] = useState(person.preferredChannel ?? "");

  const saveProfile = () => {
    startTransition(async () => {
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
    });
  };

  const cancelRequest = (requestId: string) => {
    startTransition(async () => {
      const result = await cancelOwnerRequestAction(requestId);
      toast({
        title: result.ok ? "Request cancelled" : "Couldn't cancel",
        description: result.ok ? undefined : result.error,
        variant: result.ok ? "default" : "destructive",
      });
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
            <AnimalCard key={animal.ownershipId} animal={animal} />
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
                        className="h-10 w-10 rounded-md object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
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
            <Button onClick={saveProfile} disabled={pending}>
              Save details
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
