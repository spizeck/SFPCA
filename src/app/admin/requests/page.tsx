"use client";

// Staff owner-request queue (#166) — the focused review surface for
// everything owners submit through the portal: account claims,
// transfers, "no longer mine", deceased and moved-off-Saba reports.
// Resolving applies the real change (link identity, close/transfer the
// ownership interval) transactionally with the status flip — an
// approval can never read as done without its effect landing.
//
// Deliberately scoped: this is the #166 surface, not #177's generic
// exception dashboard — #177 should compose listOwnerRequests rather
// than this page's internals.

import { useEffect, useState } from "react";
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
import { getOwnerRequestsAction, resolveOwnerRequestAction } from "./actions";
import type { OwnerRequestRecord, OwnerRequestKind } from "@/lib/registry/owner-requests";
import { OWNER_REQUEST_KIND_LABELS } from "@/lib/registry/owner-request-kinds";
import type { HouseholdRecord, PersonRecord } from "@/lib/registry/persons";
import { logError } from "@/lib/logger";
import { LoadError } from "@/components/admin/load-error";

type ResolveDecision = "approved" | "rejected";

interface ResolveForm {
  request: OwnerRequestRecord;
  decision: ResolveDecision;
  resolutionNote: string;
  targetPersonId: string;
  targetHouseholdId: string;
  effectiveOn: string;
}

function RequestRow({
  request,
  persons,
  households,
  onResolved,
}: {
  request: OwnerRequestRecord;
  persons: PersonRecord[];
  households: HouseholdRecord[];
  onResolved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<ResolveForm | null>(null);
  const [busy, setBusy] = useState(false);
  const open = (decision: ResolveDecision) =>
    setForm({
      request,
      decision,
      resolutionNote: "",
      targetPersonId: "",
      targetHouseholdId: "",
      effectiveOn: "",
    });

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const result = await resolveOwnerRequestAction(request.id, {
        decision: form.decision,
        resolutionNote: form.resolutionNote || null,
        targetPersonId: form.targetPersonId || null,
        targetHouseholdId: form.targetHouseholdId || null,
        effectiveOn: form.effectiveOn || null,
      });
      if (result.ok) {
        toast({
          title:
            form.decision === "approved" ? "Request approved" : "Request rejected",
        });
        setForm(null);
        onResolved();
      } else {
        toast({
          title: "Resolution failed",
          description:
            result.reason === "conflict"
              ? "The underlying record changed — reload and try again."
              : result.reason === "invalid"
                ? "Check the required fields for this request type."
                : "Could not resolve the request. It stays pending.",
          variant: "destructive",
        });
      }
    } catch (error) {
      logError("owners", "resolve-request-ui", error);
      toast({ title: "Resolution failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const needsPersonTarget =
    form?.decision === "approved" && request.kind === "account-claim";
  const needsOwnerTarget =
    form?.decision === "approved" && request.kind === "transfer";
  const candidateIds = (request.payload?.candidatePersonIds as string[]) ?? [];

  return (
    <li className="py-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="text-sm space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge>{OWNER_REQUEST_KIND_LABELS[request.kind as OwnerRequestKind]}</Badge>
            {request.animalName && (
              <span className="font-medium">{request.animalName}</span>
            )}
          </div>
          <p className="text-muted-foreground">
            {request.personName
              ? `From ${request.personName}`
              : request.submitterEmail
                ? `From account ${request.submitterEmail}`
                : "From an unlinked account"}
            {" · "}
            {request.createdAt.slice(0, 10)}
          </p>
          {request.detail && <p>{request.detail}</p>}
          {request.kind === "transfer" && request.payload && (
            <p className="text-muted-foreground">
              Suggested new owner:{" "}
              {(request.payload.targetName as string) ?? "—"}
              {(request.payload.targetContact as string)
                ? ` (${request.payload.targetContact as string})`
                : ""}
            </p>
          )}
          {request.kind === "account-claim" && candidateIds.length > 0 && (
            <p className="text-muted-foreground">
              Matching owner records:{" "}
              {candidateIds
                .map(
                  (id) => persons.find((p) => p.id === id)?.fullName ?? id,
                )
                .join(", ")}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => open("approved")} disabled={busy}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => open("rejected")}
            disabled={busy}
          >
            Reject
          </Button>
        </div>
      </div>

      {form && (
        <div className="border rounded-md p-3 space-y-3 text-sm bg-muted/30">
          <p className="font-medium">
            {form.decision === "approved" ? "Approve" : "Reject"} —{" "}
            {OWNER_REQUEST_KIND_LABELS[request.kind as OwnerRequestKind]}
          </p>

          {needsPersonTarget && (
            <div className="space-y-1">
              <Label>Link account to owner record</Label>
              <Select
                value={form.targetPersonId}
                onValueChange={(v) =>
                  setForm({ ...form, targetPersonId: v })
                }
              >
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Choose the owner record…" />
                </SelectTrigger>
                <SelectContent>
                  {persons.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.fullName}
                      {p.email ? ` (${p.email})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {needsOwnerTarget && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>New owner (person)</Label>
                <Select
                  value={form.targetPersonId}
                  onValueChange={(v) =>
                    setForm({ ...form, targetPersonId: v, targetHouseholdId: "" })
                  }
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
                  value={form.targetHouseholdId}
                  onValueChange={(v) =>
                    setForm({ ...form, targetHouseholdId: v, targetPersonId: "" })
                  }
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
          )}

          {form.decision === "approved" && request.kind !== "account-claim" && (
            <div className="space-y-1">
              <Label>Effective date (defaults to today)</Label>
              <Input
                type="date"
                className="w-48"
                value={form.effectiveOn}
                onChange={(e) =>
                  setForm({ ...form, effectiveOn: e.target.value })
                }
              />
            </div>
          )}

          <div className="space-y-1">
            <Label>Resolution note (optional)</Label>
            <Input
              value={form.resolutionNote}
              onChange={(e) =>
                setForm({ ...form, resolutionNote: e.target.value })
              }
            />
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={submit} disabled={busy}>
              Confirm {form.decision === "approved" ? "approval" : "rejection"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setForm(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function OwnerRequestsPage() {
  const [data, setData] = useState<{
    pending: OwnerRequestRecord[];
    resolved: OwnerRequestRecord[];
    persons: PersonRecord[];
    households: HouseholdRecord[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setData(await getOwnerRequestsAction());
    } catch (error) {
      logError("owners", "load-requests", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) return <div>Loading...</div>;
  if (loadError || !data) {
    return <LoadError label="owner requests" onRetry={load} />;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Owner requests</h1>
        <p className="text-muted-foreground">
          Claims, transfers, and reports submitted through the owner portal.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pending</CardTitle>
          <CardDescription>
            Approving applies the underlying change — linking an account,
            closing or transferring an ownership — in the same transaction.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing pending.</p>
          ) : (
            <ul className="divide-y">
              {data.pending.map((r) => (
                <RequestRow
                  key={r.id}
                  request={r}
                  persons={data.persons}
                  households={data.households}
                  onResolved={load}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resolved</CardTitle>
        </CardHeader>
        <CardContent>
          {data.resolved.length === 0 ? (
            <p className="text-sm text-muted-foreground">No resolved requests.</p>
          ) : (
            <ul className="divide-y">
              {data.resolved.map((r) => (
                <li key={r.id} className="py-3 text-sm flex justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {OWNER_REQUEST_KIND_LABELS[r.kind as OwnerRequestKind]}
                      {r.animalName ? ` — ${r.animalName}` : ""}
                    </p>
                    <p className="text-muted-foreground">
                      {r.personName ?? r.submitterEmail ?? "Unknown"} · resolved{" "}
                      {r.resolvedAt?.slice(0, 10)} by {r.resolvedBy ?? "staff"}
                      {r.resolutionNote ? ` — ${r.resolutionNote}` : ""}
                    </p>
                  </div>
                  <Badge
                    variant={r.status === "approved" ? "default" : "secondary"}
                  >
                    {r.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
