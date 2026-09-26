"use client";

// Staff chip lookup / found-animal tool (#168) — the physical workflow:
// a volunteer standing next to an animal with a USB/Bluetooth scanner
// (keyboard wedge) scans or types a chip number and presses Enter.
// One exact normalized lookup, minimal clicks, no mouse required
// between scans: the field is autofocused, cleared, and refocused after
// every result. Owner contact data is staff-authorized — it arrives via
// the server action response only, never in page source or public DTOs.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listOpenChipConflictsAction,
  lookupChipAction,
  recordFoundScanAction,
  resolveOpenCaseAction,
  type FoundScanActionResult,
} from "./actions";
import type {
  ChipConflictRecord,
  ChipLookupOwner,
  ChipLookupResult,
  MicrochipRecord,
} from "@/lib/registry/microchips";
import type { LostFoundCaseRecord } from "@/lib/registry/lost-found";
import type { LostFoundOutcome } from "@/lib/lost-found";
import { normalizeChipNumber, isValidChipNumber } from "@/lib/microchips";
import { formatAnimalAge } from "@/lib/animal-lifecycle";
import { AnimalLifecycleBadge } from "@/components/admin/animal-status-badge";
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
import { logError } from "@/lib/logger";
import {
  CircleAlert,
  Copy,
  PawPrint,
  ScanLine,
  TriangleAlert,
} from "lucide-react";

type MatchResult = Extract<ChipLookupResult, { status: "match" }>;

const OUTCOME_LABELS: Record<LostFoundOutcome, string> = {
  reunited: "Reunited with owner",
  "owner-located": "Owner located",
  "in-care": "Taken into care",
  deceased: "Deceased",
  other: "Other resolution",
};

function ChipLine({
  record,
  label,
}: {
  record: MicrochipRecord;
  label: string;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-mono text-base">{record.chipDisplay}</p>
      <p className="text-muted-foreground text-xs">
        {[
          record.manufacturer,
          record.implantedOn ? `implanted ${record.implantedOn}` : null,
          record.implantedBy,
        ]
          .filter(Boolean)
          .join(" · ") || `on record since ${record.assignedFrom}`}
      </p>
    </div>
  );
}

function OwnerBlock({ owner }: { owner: ChipLookupOwner }) {
  return (
    <div className="border rounded-md p-3 space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-medium">{owner.name}</span>
        <Badge variant="secondary">{owner.kind}</Badge>
      </div>
      {owner.householdAddress && (
        <p className="text-sm text-muted-foreground">
          Household: {owner.householdAddress}
        </p>
      )}
      {owner.contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No contact details on record — resolve through the people page.
        </p>
      ) : (
        <ul className="text-sm space-y-1">
          {owner.contacts.map((c) => (
            <li key={c.personId}>
              <span className="font-medium">{c.name}</span>
              {c.role === "primary" && (
                <span className="text-muted-foreground"> (primary)</span>
              )}
              <span className="text-muted-foreground">
                {" — "}
                {[c.phone, c.email, c.address].filter(Boolean).join(" · ") ||
                  "no contact details"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Record the scan as a lost/found case event (#176): an open missing
// case surfaces as the reunion signal and the scan lands on it as
// evidence; an open found case gets a rescan note; otherwise a new
// found case opens — or resolves immediately when an outcome is chosen.
function FoundScanForm({
  match,
  onSaved,
}: {
  match: MatchResult;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [outcome, setOutcome] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<Record<string, string>>({});

  const saveNew = async () => {
    setBusy(true);
    try {
      const result: FoundScanActionResult = await recordFoundScanAction({
        animalId: match.animal.id,
        microchipRecordId: match.chip.id,
        chipNumber: match.normalized,
        // 'open' is the log-only choice — no outcome recorded.
        outcome: outcome && outcome !== "open" ? outcome : null,
        notes: notes || null,
      });
      if (!result.ok) {
        toast({
          title: "Couldn't record",
          description: "The scan was not saved. Try again.",
          variant: "destructive",
        });
        return;
      }
      setOutcome("");
      setNotes("");
      toast({
        title: result.matchedMissing
          ? "Added to the missing case"
          : result.existing
            ? "Added to the open case"
            : outcome && outcome !== "open"
              ? "Found case resolved"
              : "Found case opened",
      });
      onSaved();
    } catch (error) {
      logError("microchips", "found-scan-save-ui", error);
      toast({
        title: "Couldn't record",
        description: "The scan was not saved. Try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (openCase: LostFoundCaseRecord) => {
    const chosen = resolving[openCase.id];
    if (!chosen) return;
    setBusy(true);
    try {
      const result = await resolveOpenCaseAction(
        openCase.id,
        chosen as LostFoundOutcome,
        notes || null,
      );
      if (!result.ok) {
        toast({
          title: "Couldn't resolve",
          description: "The case was not updated. Try again.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Case resolved" });
      onSaved();
    } catch (error) {
      logError("microchips", "case-resolve-ui", error);
      toast({
        title: "Couldn't resolve",
        description: "The case was not updated. Try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {match.openCases.length > 0 && (
        <div>
          <p className="text-sm font-medium mb-1">Open cases</p>
          <ul className="space-y-2">
            {match.openCases.map((r) => (
              <li
                key={r.id}
                className={`rounded-md p-2 text-sm space-y-2 border ${
                  r.caseType === "missing"
                    ? "border-amber-500/60 bg-amber-50 dark:bg-amber-950/30"
                    : ""
                }`}
              >
                <p>
                  {r.caseType === "missing" ? (
                    <>
                      <strong>Reported missing</strong> {r.reportedAt.slice(0, 10)}
                      {r.lastSeenOn
                        ? ` — last seen ${r.lastSeenOn}${r.lastSeenLocation ? ` at ${r.lastSeenLocation}` : ""}`
                        : ""}
                    </>
                  ) : (
                    <>
                      Found case open since {r.reportedAt.slice(0, 10)}
                      {r.foundLocation ? ` — ${r.foundLocation}` : ""}
                    </>
                  )}
                  {r.actorLabel ? ` (${r.actorLabel})` : ""}
                  {r.notes ? ` — ${r.notes}` : ""}
                  {" · "}
                  <Link
                    href={`/admin/lost-found/${r.id}`}
                    className="underline"
                  >
                    case
                  </Link>
                </p>
                <div className="flex items-center gap-2">
                  <Select
                    value={resolving[r.id] ?? ""}
                    onValueChange={(v) =>
                      setResolving({ ...resolving, [r.id]: v })
                    }
                  >
                    <SelectTrigger
                      className="w-56"
                      aria-label="Resolution outcome"
                    >
                      <SelectValue placeholder="Outcome…" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(OUTCOME_LABELS).map(([v, l]) => (
                        <SelectItem key={v} value={v}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !resolving[r.id]}
                    onClick={() => resolve(r)}
                  >
                    Resolve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-[16rem_1fr_auto] items-end">
        <div className="space-y-1">
          <Label htmlFor="found-outcome">Record outcome</Label>
          <Select value={outcome} onValueChange={setOutcome}>
            <SelectTrigger id="found-outcome">
              <SelectValue placeholder="Still unresolved…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Still unresolved (log only)</SelectItem>
              {Object.entries(OUTCOME_LABELS).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="found-note">Note (optional)</Label>
          <Input
            id="found-note"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Where found, who was called…"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={saveNew}
        >
          Record
        </Button>
      </div>
    </div>
  );
}

function MatchCard({
  match,
  onRefresh,
}: {
  match: MatchResult;
  onRefresh: () => void;
}) {
  const { animal } = match;
  const chipIsCurrent = match.chip.assignedTo === null;
  const disputedAnimals = [
    ...new Map(match.matches.map((m) => [m.animalId, m])).values(),
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-4">
          {animal.photoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={animal.photoUrl}
              alt=""
              className="h-16 w-16 rounded-md object-cover flex-shrink-0"
            />
          )}
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/admin/animals/${animal.id}`}
                className="hover:underline"
              >
                {animal.name}
              </Link>
              <AnimalLifecycleBadge status={animal.lifecycleStatus} />
            </CardTitle>
            <CardDescription>
              <span className="font-mono">{animal.registryRef}</span> ·{" "}
              {animal.species} · {animal.sex}
              {formatAnimalAge(animal.birthDate, animal.birthDateEstimated)
                ? ` · ${formatAnimalAge(animal.birthDate, animal.birthDateEstimated)}`
                : ""}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {animal.lifecycleStatus !== "active" && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3"
          >
            <TriangleAlert className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-600" />
            <p>
              The registry lists this animal as{" "}
              <strong>{animal.lifecycleStatus}</strong>
              {animal.lifecycleEffectiveOn
                ? ` since ${animal.lifecycleEffectiveOn}`
                : ""}
              . Verify the animal&apos;s identity — the registry record may
              be stale and needs staff review.
            </p>
          </div>
        )}

        {disputedAnimals.length > 1 && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3"
          >
            <TriangleAlert className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-600" />
            <p>
              This chip number appears on{" "}
              <strong>{disputedAnimals.length} animals</strong>:{" "}
              {disputedAnimals.map((m) => m.animalName).join(", ")}. Verify
              carefully — the registry needs this conflict resolved.
            </p>
          </div>
        )}

        {match.openConflicts.length > 0 && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3"
          >
            <TriangleAlert className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-600" />
            <p>
              This chip number has an unresolved conflict (
              {match.openConflicts.length} open). Resolve it on the animal
              profile before relying on this match alone.
            </p>
          </div>
        )}

        {animal.identifyingNotes && (
          <div>
            <p className="text-muted-foreground text-xs">
              Identifying notes
            </p>
            <p>{animal.identifyingNotes}</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <ChipLine
            record={match.chip}
            label={
              chipIsCurrent
                ? "Scanned chip — current"
                : `Scanned chip — no longer current (${match.chip.closedReason ?? "closed"} ${match.chip.assignedTo ?? ""})`
            }
          />
          {!chipIsCurrent && match.currentChip && (
            <ChipLine record={match.currentChip} label="Current chip" />
          )}
        </div>

        <div>
          <p className="font-medium mb-2">Owner contact</p>
          {match.owners.length === 0 ? (
            <p className="text-muted-foreground">
              No registered owner for this animal — SFPCA cannot return it
              through the registry.
            </p>
          ) : (
            <div className="space-y-2">
              {match.ownershipAmbiguous && (
                <p className="flex items-center gap-1 text-amber-700 dark:text-amber-500">
                  <CircleAlert className="h-4 w-4" />
                  Multiple current owners on record — verify before
                  releasing the animal.
                </p>
              )}
              {match.owners.map((o) => (
                <OwnerBlock key={o.ownershipId} owner={o} />
              ))}
            </div>
          )}
        </div>

        <FoundScanForm match={match} onSaved={onRefresh} />
      </CardContent>
    </Card>
  );
}

export default function ChipLookupPage() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<ChipLookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const normalizedPreview = normalizeChipNumber(input);

  // The scanner is the pointing device: keep the field focused at all
  // times so a scan + Enter needs zero mouse interaction.
  useEffect(() => {
    inputRef.current?.focus();
  }, [result]);

  const runLookup = async () => {
    if (!isValidChipNumber(normalizedPreview)) {
      setResult({ status: "invalid", normalized: normalizedPreview });
      return;
    }
    setBusy(true);
    try {
      const r = await lookupChipAction(input);
      setResult(r);
      // Ready for the next scan: the submitted number is preserved in
      // the result card; the field clears and refocuses.
      setInput("");
    } catch (error) {
      logError("microchips", "chip-lookup-ui", error);
      toast({
        title: "Lookup failed",
        description: "The registry lookup failed. Try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const refreshMatch = () => {
    // Re-run the last lookup so resolution state updates in place.
    if (result && result.status !== "error") {
      setBusy(true);
      lookupChipAction(result.normalized)
        .then(setResult)
        .catch((error) => logError("microchips", "chip-lookup-refresh", error))
        .finally(() => setBusy(false));
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <ScanLine className="h-7 w-7" />
          Chip Lookup
        </h1>
        <p className="text-muted-foreground mt-1">
          Found an animal? Scan or type the microchip and press Enter —
          the scanner behaves like a keyboard.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runLookup();
            }}
          >
            <Label htmlFor="chip-input">Microchip number</Label>
            <Input
              ref={inputRef}
              id="chip-input"
              className="font-mono text-lg mt-1"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. 985 112 345 678 901"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
              aria-describedby="chip-input-hint"
            />
            <p id="chip-input-hint" className="text-xs text-muted-foreground mt-1">
              {normalizedPreview
                ? `Looks up: ${normalizedPreview}`
                : "Spaces and separators are ignored — scan or type, then Enter."}
            </p>
            {/* A real submit button exists for pointer users — the
                scanner path only needs Enter. */}
            <Button type="submit" className="mt-3" disabled={busy}>
              Look up
            </Button>
          </form>
        </CardContent>
      </Card>

      {busy && <p className="text-muted-foreground">Looking up…</p>}

      {result?.status === "invalid" && (
        <Card>
          <CardContent className="pt-6">
            <p>
              <strong>&quot;{input || normalizedPreview || "—"}&quot;</strong>{" "}
              is not a recognizable chip number — check the scanner or
              paperwork and try again.
            </p>
          </CardContent>
        </Card>
      )}

      {result?.status === "error" && (
        <Card>
          <CardContent className="pt-6">
            <p>
              The registry lookup failed. Try again — if it keeps failing,
              the registry database may be unreachable.
            </p>
          </CardContent>
        </Card>
      )}

      {result?.status === "not-found" && (
        <Card>
          <CardHeader>
            <CardTitle>No registered animal for this chip</CardTitle>
            <CardDescription>
              Chip{" "}
              <span className="font-mono font-medium text-foreground">
                {result.display}
              </span>{" "}
              (normalized <span className="font-mono">{result.normalized}</span>)
              is not in the SFPCA registry.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.openCases.length > 0 && (
              <div
                role="alert"
                className="rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm"
              >
                <p className="font-medium">
                  This chip is already on the lost/found board:
                </p>
                <ul className="mt-1 space-y-1">
                  {result.openCases.map((c) => (
                    <li key={c.id}>
                      Found case open since {c.reportedAt.slice(0, 10)}
                      {c.foundLocation ? ` — ${c.foundLocation}` : ""} ·{" "}
                      <Link
                        href={`/admin/lost-found/${c.id}`}
                        className="underline"
                      >
                        open case
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(result.normalized);
                    toast({ title: "Copied", description: result.normalized });
                  } catch {
                    toast({
                      title: "Copy failed",
                      description: result.normalized,
                    });
                  }
                }}
              >
                <Copy className="h-4 w-4 mr-1" />
                Copy number
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/admin/animals">
                  <PawPrint className="h-4 w-4 mr-1" />
                  Search the registry
                </Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await recordFoundScanAction({
                      chipNumber: result.normalized,
                    });
                    toast(
                      r.ok
                        ? {
                            title: r.existing
                              ? "Added to the open case"
                              : "Flagged for follow-up",
                            description: r.existing
                              ? "This chip already has an open found case — the scan was added to it."
                              : "An open found case was logged for this unknown chip.",
                          }
                        : {
                            title: "Couldn't record",
                            description: "Try again.",
                            variant: "destructive",
                          },
                    );
                  } catch (error) {
                    logError("microchips", "found-scan-flag-ui", error);
                    toast({
                      title: "Couldn't record",
                      description: "Try again.",
                      variant: "destructive",
                    });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Flag for follow-up
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              The animal may still belong to someone — check the registry
              by name/description, or register it and add this chip on the
              animal profile. An animal is never created automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {result?.status === "match" && (
        <MatchCard match={result} onRefresh={refreshMatch} />
      )}

      <ConflictsSection />
    </div>
  );
}

// Open chip conflicts — the registry-integrity follow-up queue the #177
// dashboard links to (#conflicts). Rows link to the claimed animal's
// profile, where the microchip panel resolves the conflict.
function ConflictsSection() {
  const [conflicts, setConflicts] = useState<ChipConflictRecord[] | null>(
    null,
  );

  useEffect(() => {
    listOpenChipConflictsAction()
      .then(setConflicts)
      .catch((error) => {
        logError("microchips", "conflicts-load", error);
        setConflicts([]);
      });
  }, []);

  if (conflicts === null) return null;

  return (
    <Card
      id="conflicts"
      className="scroll-mt-6 target:ring-2 target:ring-primary/40"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Open chip conflicts
          {conflicts.length > 0 && (
            <Badge variant="secondary">{conflicts.length}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          The same chip number is claimed on two records — resolve it on
          the animal&apos;s profile before relying on a scan match.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {conflicts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open conflicts — every chip maps to at most one animal.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {conflicts.map((c) => (
              <li
                key={c.id}
                className="py-3 flex items-start justify-between gap-3"
              >
                <div>
                  <span className="font-mono font-medium">
                    {c.chipNumber}
                  </span>
                  <p className="text-muted-foreground">
                    Claimed on {c.claimedAnimalName ?? "an animal"}
                    {c.existingAnimalName
                      ? ` — already recorded on ${c.existingAnimalName}`
                      : ""}
                  </p>
                  {c.detail && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {c.detail}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  className="flex-shrink-0"
                >
                  <Link href={`/admin/animals/${c.claimedAnimalId}`}>
                    Resolve
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
