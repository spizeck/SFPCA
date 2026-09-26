"use client";

// Lost/found case detail (#176) — one case end to end: what was
// reported, the linked animal (or the link form when unmatched), the
// owner contact projection for reunions, the append-only chronology,
// and the close-out actions. All private staff data; the only public
// surface any of this feeds is the allowlisted /lost-pets DTO.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  addCaseUpdateAction,
  cancelCaseAction,
  getCaseDetailAction,
  linkCaseToAnimalAction,
  publishCaseAction,
  reopenCaseAction,
  resolveCaseAction,
  searchLinkCandidatesAction,
  unpublishCaseAction,
  type CaseActionResult,
  type LinkCandidate,
} from "./actions";
import type {
  LostFoundCaseDetail,
} from "@/lib/registry/lost-found";
import type { AnimalOwnerContacts } from "@/lib/registry/ownership";
import {
  LOST_FOUND_CASE_TYPE_LABELS,
  LOST_FOUND_OUTCOMES,
  LOST_FOUND_OUTCOME_LABELS,
  LOST_FOUND_STATUS_LABELS,
  LOST_FOUND_UPDATE_KIND_LABELS,
} from "@/lib/lost-found";
import type {
  LostFoundOutcome,
  LostFoundUpdateKind,
} from "@/lib/lost-found";
import { todayIsoDate } from "@/lib/vaccinations";
import { logError } from "@/lib/logger";
import { LoadError } from "@/components/admin/load-error";
import { ArrowLeft, PawPrint } from "lucide-react";

function OwnerBlock({ owner }: { owner: AnimalOwnerContacts }) {
  return (
    <li className="text-sm border rounded-md p-2 space-y-1">
      <p className="font-medium">
        {owner.name}
        {owner.kind === "household" ? " (household)" : ""}
      </p>
      {owner.householdAddress && (
        <p className="text-muted-foreground">{owner.householdAddress}</p>
      )}
      {owner.contacts.length === 0 ? (
        <p className="text-muted-foreground">No contact details on file.</p>
      ) : (
        <ul className="space-y-0.5">
          {owner.contacts.map((c) => (
            <li key={c.personId}>
              {c.name}
              {c.role === "primary" ? " (primary)" : ""} —{" "}
              {[
                c.phone,
                c.email,
                c.address,
                c.preferredChannel ? `prefers ${c.preferredChannel}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "no contact details"}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function LostFoundCasePage() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;
  const { toast } = useToast();

  const [detail, setDetail] = useState<LostFoundCaseDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [today] = useState(() => todayIsoDate());

  // --- Update form
  const [updateKind, setUpdateKind] = useState<LostFoundUpdateKind | "">("");
  const [updateLocation, setUpdateLocation] = useState("");
  const [updateNote, setUpdateNote] = useState("");
  const [updateReporterName, setUpdateReporterName] = useState("");
  const [updateReporterContact, setUpdateReporterContact] = useState("");

  // --- Link form
  const [linkQuery, setLinkQuery] = useState("");
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);

  // --- Close-out form
  const [closing, setClosing] = useState<"resolve" | "cancel" | null>(null);
  const [outcome, setOutcome] = useState<LostFoundOutcome | "">("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [deceasedOn, setDeceasedOn] = useState(today);

  // --- Publish form
  const [publishing, setPublishing] = useState(false);
  const [publicNote, setPublicNote] = useState("");

  const load = async () => {
    setLoadError(false);
    try {
      const result = await getCaseDetailAction(caseId);
      if (!result) {
        setNotFound(true);
        setDetail(null);
      } else {
        setNotFound(false);
        setDetail(result);
      }
    } catch (error) {
      logError("lost-found", "admin-load", error);
      setLoadError(true);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const run = async (
    op: () => Promise<CaseActionResult>,
    success: string,
    after?: () => void,
  ) => {
    setBusy(true);
    try {
      const result = await op();
      if (result.ok) {
        toast({ title: success });
        after?.();
        load();
      } else {
        toast({
          title: "Couldn't save",
          description: `Failed (${result.reason ?? "error"}${result.field ? `, ${result.field}` : ""}).`,
          variant: "destructive",
        });
      }
    } catch (error) {
      logError("lost-found", "admin-save-ui", error);
      toast({
        title: "Couldn't save",
        description: "Failed to save. Try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const submitUpdate = () => {
    if (!updateKind) return;
    run(
      () =>
        addCaseUpdateAction(caseId, {
          kind: updateKind,
          location: updateLocation || null,
          note: updateNote || null,
          reporterName: updateReporterName || null,
          reporterContact: updateReporterContact || null,
        }),
      "Update recorded",
      () => {
        setUpdateKind("");
        setUpdateLocation("");
        setUpdateNote("");
        setUpdateReporterName("");
        setUpdateReporterContact("");
      },
    );
  };

  const searchLink = async () => {
    setBusy(true);
    try {
      setCandidates(await searchLinkCandidatesAction(linkQuery));
    } catch (error) {
      logError("lost-found", "link-search-ui", error);
      setCandidates([]);
    } finally {
      setBusy(false);
    }
  };

  if (!detail && loadError) {
    return <LoadError label="case" onRetry={load} />;
  }
  if (!detail && !notFound) {
    return <div>Loading...</div>;
  }
  if (notFound || !detail) {
    return (
      <div className="max-w-4xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Case not found</CardTitle>
            <CardDescription>
              This lost/found case doesn&apos;t exist.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin/lost-found">Back to lost &amp; found</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const c = detail.case;
  const isOpen = c.status === "open";

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
          <Link href="/admin/lost-found">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to lost &amp; found
          </Link>
        </Button>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight">
            {LOST_FOUND_CASE_TYPE_LABELS[c.caseType]} case
          </h1>
          <Badge variant={isOpen ? "destructive" : "secondary"}>
            {LOST_FOUND_STATUS_LABELS[c.status]}
          </Badge>
          {c.publishedAt && <Badge variant="outline">listed publicly</Badge>}
          {c.reportedVia === "owner-portal" && (
            <Badge variant="secondary">reported by owner</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Reported {c.reportedAt.slice(0, 10)}
          {c.actorLabel ? ` by ${c.actorLabel}` : ""}
          {c.resolvedAt
            ? ` · closed ${c.resolvedAt.slice(0, 10)} by ${c.resolvedBy ?? "staff"}${c.outcome ? ` — ${LOST_FOUND_OUTCOME_LABELS[c.outcome as LostFoundOutcome]}` : ""}`
            : ""}
        </p>
      </div>

      {/* Case facts */}
      <Card>
        <CardHeader>
          <CardTitle>What was reported</CardTitle>
          <CardDescription>
            Reporter details are private — they never appear on public
            pages.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {c.caseType === "missing" && (
              <>
                <div>
                  <dt className="text-muted-foreground">Last seen</dt>
                  <dd>
                    {c.lastSeenOn ?? "unknown"}
                    {c.lastSeenLocation ? ` — ${c.lastSeenLocation}` : ""}
                  </dd>
                </div>
              </>
            )}
            {c.caseType === "found" && (
              <div>
                <dt className="text-muted-foreground">Found</dt>
                <dd>
                  {c.foundOn ?? "date unknown"}
                  {c.foundLocation ? ` — ${c.foundLocation}` : ""}
                </dd>
              </div>
            )}
            {c.chipDisplay && (
              <div>
                <dt className="text-muted-foreground">Scanned chip</dt>
                <dd className="font-mono">{c.chipDisplay}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Reported by</dt>
              <dd>
                {c.reporterName ?? "—"}
                {c.reporterContact ? ` (${c.reporterContact})` : ""}
              </dd>
            </div>
            {c.linkedAt && (
              <div>
                <dt className="text-muted-foreground">Matched to registry</dt>
                <dd>
                  {c.linkedAt.slice(0, 10)} by {c.linkedBy}
                  <span className="text-muted-foreground">
                    {" "}
                    — case began unmatched
                  </span>
                </dd>
              </div>
            )}
          </dl>
          {c.description && (
            <p>
              <span className="text-muted-foreground">Description: </span>
              {c.description}
            </p>
          )}
          {c.publicNote && (
            <p>
              <span className="text-muted-foreground">Public note: </span>
              {c.publicNote}
            </p>
          )}
          {c.notes && (
            <p>
              <span className="text-muted-foreground">Staff notes: </span>
              {c.notes}
            </p>
          )}
          {c.resolutionNote && (
            <p>
              <span className="text-muted-foreground">Resolution note: </span>
              {c.resolutionNote}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Linked animal OR link form */}
      {c.animalId ? (
        <Card>
          <CardHeader>
            <CardTitle>Registry animal</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-3">
            <div className="flex items-center gap-4">
              {c.animalPhotoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={c.animalPhotoUrl}
                  alt={c.animalName ?? ""}
                  className="h-16 w-16 rounded-md object-cover flex-shrink-0"
                />
              ) : (
                <div className="h-16 w-16 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                  <PawPrint className="h-6 w-6 text-muted-foreground" />
                </div>
              )}
              <div>
                <p className="font-medium">
                  {c.animalName}{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.animalRegistryRef}
                  </span>
                </p>
                <p className="text-muted-foreground capitalize">
                  {c.animalSpecies} · {c.animalSex} · registry status:{" "}
                  {c.animalLifecycleStatus}
                </p>
                <Button size="sm" variant="outline" asChild className="mt-1">
                  <Link href={`/admin/animals/${c.animalId}`}>
                    Open animal profile
                  </Link>
                </Button>
              </div>
            </div>
            <div>
              <p className="font-medium mb-1">Owner contact</p>
              {detail.ownershipAmbiguous && (
                <p className="text-amber-600 text-xs mb-2">
                  Multiple current owners on record — verify before
                  releasing the animal.
                </p>
              )}
              {detail.owners.length === 0 ? (
                <p className="text-muted-foreground">
                  No registered owner for this animal.
                </p>
              ) : (
                <ul className="space-y-2">
                  {detail.owners.map((o) => (
                    <OwnerBlock key={o.ownershipId} owner={o} />
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Unmatched — link to a registry animal</CardTitle>
            <CardDescription>
              No animal record is attached. Search the registry and link
              the right one — a chip scan through Chip Lookup does this
              automatically when the chip matches. Nothing creates an
              animal record from here.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-3">
            {isOpen ? (
              <>
                <div className="flex gap-2">
                  <Input
                    value={linkQuery}
                    onChange={(e) => setLinkQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchLink()}
                    placeholder="Name, registry ref, chip number…"
                    className="max-w-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={searchLink}
                    disabled={busy || !linkQuery.trim()}
                  >
                    Search
                  </Button>
                </div>
                {candidates !== null &&
                  (candidates.length === 0 ? (
                    <p className="text-muted-foreground">
                      No registry animals matched that search.
                    </p>
                  ) : (
                    <ul className="divide-y border rounded-md">
                      {candidates.map((a) => (
                        <li
                          key={a.id}
                          className="p-2 flex items-center justify-between gap-3"
                        >
                          <div>
                            <span className="font-medium">{a.name}</span>{" "}
                            <span className="font-mono text-xs text-muted-foreground">
                              {a.registryRef}
                            </span>
                            <p className="text-xs text-muted-foreground capitalize">
                              {a.species} · {a.sex} · {a.lifecycleStatus}
                              {a.owners.length
                                ? ` · owner: ${a.owners.join(", ")}`
                                : ""}
                              {a.microchips.length
                                ? ` · chip ${a.microchips.join(", ")}`
                                : ""}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => linkCaseToAnimalAction(caseId, a.id),
                                `Linked to ${a.name}`,
                                () => setCandidates(null),
                              )
                            }
                          >
                            Link
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ))}
              </>
            ) : (
              <p className="text-muted-foreground">
                This case closed before it was matched to an animal.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Public listing — missing cases only */}
      {isOpen && c.caseType === "missing" && (
        <Card>
          <CardHeader>
            <CardTitle>Public listing</CardTitle>
            <CardDescription>
              Publishing shows this animal on the public lost-pets page —
              name, photo, species/sex, your approved note, and
              last-seen details only. Owner contact, reporter details,
              notes, and chip numbers are never public. The listing
              disappears automatically when the case closes.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-3">
            {publishing ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="public-note">
                    Approved public note (optional — this text is public)
                  </Label>
                  <Textarea
                    id="public-note"
                    rows={2}
                    value={publicNote}
                    onChange={(e) => setPublicNote(e.target.value)}
                    placeholder="e.g. Answers to Fluffy, shy around strangers"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          publishCaseAction(caseId, {
                            publicNote: publicNote || null,
                          }),
                        "Published to the lost-pets page",
                        () => setPublishing(false),
                      )
                    }
                  >
                    Publish
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPublishing(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : c.publishedAt ? (
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-muted-foreground">
                  Listed publicly since {c.publishedAt.slice(0, 10)} by{" "}
                  {c.publishedBy ?? "staff"} —{" "}
                  <Link href="/lost-pets" className="underline">
                    view the public page
                  </Link>
                  .
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => publishCaseAction(caseId, { publicNote }),
                      "Public listing updated",
                    )
                  }
                >
                  Update note
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(() => unpublishCaseAction(caseId), "Listing removed")
                  }
                >
                  Unpublish
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPublicNote(c.publicNote ?? "");
                  setPublishing(true);
                }}
              >
                Publish to the lost-pets page…
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Chronology */}
      <Card>
        <CardHeader>
          <CardTitle>Chronology</CardTitle>
          <CardDescription>
            Sightings, scans, and notes in order — append-only history.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          {detail.updates.length === 0 ? (
            <p className="text-muted-foreground">
              No updates recorded yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {detail.updates.map((u) => (
                <li key={u.id} className="border-l-2 pl-3 py-0.5">
                  <p>
                    <span className="text-muted-foreground">
                      {u.occurredAt.slice(0, 16).replace("T", " ")} ·{" "}
                      {LOST_FOUND_UPDATE_KIND_LABELS[u.kind]}
                      {u.source === "public" ? " (public report)" : ""}
                      {u.actorLabel ? ` — ${u.actorLabel}` : ""}
                    </span>
                  </p>
                  {u.location && <p>Location: {u.location}</p>}
                  {u.note && <p>{u.note}</p>}
                  {(u.reporterName || u.reporterContact) && (
                    <p className="text-muted-foreground">
                      Reported by {u.reporterName ?? "someone"}
                      {u.reporterContact ? ` (${u.reporterContact})` : ""}{" "}
                      — private
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isOpen && (
            <div className="border rounded-md p-3 space-y-3 bg-muted/30">
              <p className="font-medium">Add an update</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="update-kind">Kind</Label>
                  <Select
                    value={updateKind}
                    onValueChange={(v) =>
                      setUpdateKind(v as LostFoundUpdateKind)
                    }
                  >
                    <SelectTrigger id="update-kind">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sighting">
                        Sighting — somebody saw it
                      </SelectItem>
                      <SelectItem value="scan">Chip scan</SelectItem>
                      <SelectItem value="update">Other update</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="update-location">Location (optional)</Label>
                  <Input
                    id="update-location"
                    value={updateLocation}
                    onChange={(e) => setUpdateLocation(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="update-reporter">Reported by (optional)</Label>
                  <Input
                    id="update-reporter"
                    value={updateReporterName}
                    onChange={(e) => setUpdateReporterName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="update-contact">Their contact (optional)</Label>
                  <Input
                    id="update-contact"
                    value={updateReporterContact}
                    onChange={(e) => setUpdateReporterContact(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="update-note">Note</Label>
                  <Textarea
                    id="update-note"
                    rows={2}
                    value={updateNote}
                    onChange={(e) => setUpdateNote(e.target.value)}
                  />
                </div>
              </div>
              <Button
                size="sm"
                onClick={submitUpdate}
                disabled={busy || !updateKind || (!updateNote && !updateLocation)}
              >
                Add update
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Close-out */}
      {isOpen ? (
        <Card>
          <CardHeader>
            <CardTitle>Close the case</CardTitle>
            <CardDescription>
              Resolving preserves the full case as history — nothing is
              deleted. If the animal has another open case of the other
              type, it closes with the same outcome. Cancelling means the
              case itself was wrong and only affects this case.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-3">
            {closing === null ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setClosing("resolve")}
                >
                  Resolve…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setClosing("cancel")}
                >
                  Cancel case…
                </Button>
              </div>
            ) : closing === "resolve" ? (
              <div className="border rounded-md p-3 space-y-3 bg-muted/30">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="resolve-outcome">Outcome</Label>
                    <Select
                      value={outcome}
                      onValueChange={(v) => setOutcome(v as LostFoundOutcome)}
                    >
                      <SelectTrigger id="resolve-outcome">
                        <SelectValue placeholder="Choose…" />
                      </SelectTrigger>
                      <SelectContent>
                        {LOST_FOUND_OUTCOMES.map((o) => (
                          <SelectItem key={o} value={o}>
                            {LOST_FOUND_OUTCOME_LABELS[o]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {outcome === "deceased" && (
                    <div className="space-y-1">
                      <Label htmlFor="deceased-on">
                        Date of death (registry record)
                      </Label>
                      <Input
                        id="deceased-on"
                        type="date"
                        value={deceasedOn}
                        onChange={(e) => setDeceasedOn(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="resolution-note">
                      Resolution note (optional)
                    </Label>
                    <Textarea
                      id="resolution-note"
                      rows={2}
                      value={resolutionNote}
                      onChange={(e) => setResolutionNote(e.target.value)}
                    />
                  </div>
                </div>
                {outcome === "deceased" && c.animalId && (
                  <p className="text-amber-600 text-xs">
                    This also records the animal as deceased in the
                    permanent registry — the canonical lifecycle
                    transition, with its own history entry.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !outcome}
                    onClick={() =>
                      run(
                        () =>
                          resolveCaseAction(caseId, {
                            outcome: outcome as LostFoundOutcome,
                            resolutionNote: resolutionNote || null,
                            deceasedEffectiveOn:
                              outcome === "deceased" ? deceasedOn : null,
                          }),
                        "Case resolved",
                        () => setClosing(null),
                      )
                    }
                  >
                    Resolve case
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setClosing(null)}
                    disabled={busy}
                  >
                    Back
                  </Button>
                </div>
              </div>
            ) : (
              <div className="border rounded-md p-3 space-y-3 bg-muted/30">
                <div className="space-y-1">
                  <Label htmlFor="cancel-note">
                    Why is this case cancelled? (optional)
                  </Label>
                  <Textarea
                    id="cancel-note"
                    rows={2}
                    value={resolutionNote}
                    onChange={(e) => setResolutionNote(e.target.value)}
                    placeholder="e.g. duplicate report, entered by mistake"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          cancelCaseAction(caseId, {
                            note: resolutionNote || null,
                          }),
                        "Case cancelled",
                        () => setClosing(null),
                      )
                    }
                  >
                    Cancel case
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setClosing(null)}
                    disabled={busy}
                  >
                    Back
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Closed</CardTitle>
            <CardDescription>
              The case is preserved as history. Reopen only if it was
              closed by mistake.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(() => reopenCaseAction(caseId), "Case reopened")
              }
            >
              Reopen case
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
