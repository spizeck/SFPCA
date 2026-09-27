"use client";

// Veterinary work queue (#175, +#194) — one action list for the
// rotating vet and volunteers: open rechecks, expected clinic animals,
// vaccinations due/overdue, and active important/critical alerts.
// Items arrive pre-sorted by urgency from listVetQueue (overdue → due
// today → upcoming → alerts); this page only filters the canonical
// list — it never re-derives due state.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getVetQueueAction } from "./actions";
import type { VetQueueItem } from "@/lib/registry/vet-queue";
import { addDaysToIsoDate, todayIsoDate } from "@/lib/vaccinations";
import {
  ALERT_KIND_LABELS,
  ALERT_SEVERITY_LABELS,
  type AlertKind,
  type AlertSeverity,
} from "@/lib/medical";
import { VaccinationStatusBadge } from "@/components/admin/vaccination-status-badge";
import {
  FollowUpResolveButtons,
  FollowUpStateBadge,
} from "@/components/admin/medical/follow-up-controls";
import {
  ClinicExpectationResolveButtons,
  ClinicExpectationStateBadge,
} from "@/components/admin/medical/clinic-expectation-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadError } from "@/components/admin/load-error";
import { logError } from "@/lib/logger";

type KindFilter = "all" | VetQueueItem["kind"];
// The window filter narrows dated work (rechecks, vaccinations).
// Alerts are standing items — they have no due date and stay visible
// under every window so a critical alert can never be filtered away.
type WindowFilter = "all" | "overdue" | "today" | "week";

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "follow-up", label: "Rechecks" },
  { value: "clinic", label: "Expected" },
  { value: "vaccination", label: "Vaccinations" },
  { value: "alert", label: "Alerts" },
];

const WINDOW_FILTERS: { value: WindowFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Next 7 days" },
];

const KIND_VALUES = new Set<string>(KIND_FILTERS.map((f) => f.value));
const WINDOW_VALUES = new Set<string>(WINDOW_FILTERS.map((f) => f.value));

// URL params are the dashboard's deep links (/admin/vet?window=overdue)
// and must be bookmarkable — validate strictly against the allowlists;
// anything else falls back to the full list.
function parseKind(raw: string | null): KindFilter {
  return raw && KIND_VALUES.has(raw) ? (raw as KindFilter) : "all";
}
function parseWindow(raw: string | null): WindowFilter {
  return raw && WINDOW_VALUES.has(raw) ? (raw as WindowFilter) : "all";
}

function itemDate(item: VetQueueItem): string {
  switch (item.kind) {
    case "follow-up":
      return item.dueOn;
    case "vaccination":
      return item.effectiveDate;
    case "clinic":
      return item.expectedOn;
    case "alert":
      return item.recordedOn;
  }
}

function matchesWindow(
  item: VetQueueItem,
  filter: WindowFilter,
  today: string,
): boolean {
  if (item.kind === "alert") return true;
  const date = itemDate(item);
  switch (filter) {
    case "all":
      return true;
    case "overdue":
      return date < today;
    case "today":
      return date <= today;
    case "week":
      return date <= addDaysToIsoDate(today, 7);
  }
}

function TypeBadge({ item }: { item: VetQueueItem }) {
  const label =
    item.kind === "follow-up"
      ? "Recheck"
      : item.kind === "vaccination"
        ? "Vaccination"
        : item.kind === "clinic"
          ? "Expected"
          : "Alert";
  return <Badge variant="outline">{label}</Badge>;
}

function StateBadge({ item }: { item: VetQueueItem }) {
  if (item.kind === "follow-up") return <FollowUpStateBadge state={item.state} />;
  if (item.kind === "vaccination")
    return <VaccinationStatusBadge state={item.state} />;
  if (item.kind === "clinic")
    return <ClinicExpectationStateBadge state={item.state} />;
  return (
    <Badge variant={item.severity === "critical" ? "destructive" : "secondary"}>
      {ALERT_SEVERITY_LABELS[item.severity as AlertSeverity] ?? item.severity}
    </Badge>
  );
}

function ItemDetails({ item }: { item: VetQueueItem }) {
  switch (item.kind) {
    case "follow-up":
      return (
        <div>
          <div className="font-medium">{item.reason ?? "Recheck"}</div>
          {item.notes && (
            <div className="text-xs text-muted-foreground">{item.notes}</div>
          )}
          {item.encounterOn && (
            <div className="text-xs text-muted-foreground">
              From visit on {item.encounterOn}
            </div>
          )}
        </div>
      );
    case "vaccination":
      return <div className="font-medium">{item.vaccineName}</div>;
    case "clinic":
      return (
        <div>
          <div className="font-medium">{item.reason}</div>
          <div className="text-xs text-muted-foreground space-x-2">
            {item.sessionLabel && <span>{item.sessionLabel}</span>}
            {item.state === "overdue" && (
              <span>Expected date passed — mark seen or no-show</span>
            )}
          </div>
          {item.notes && (
            <div className="text-xs text-muted-foreground">{item.notes}</div>
          )}
        </div>
      );
    case "alert":
      return (
        <div>
          <div className="font-medium">{item.summary}</div>
          <div className="text-xs text-muted-foreground">
            {ALERT_KIND_LABELS[item.alertKind as AlertKind] ?? "Alert"} · since{" "}
            {item.recordedOn}
          </div>
        </div>
      );
  }
}

export default function VetQueuePage() {
  const [items, setItems] = useState<VetQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Filters live in the URL (useSearchParams) so dashboard links and
  // bookmarks land on the filtered queue; clicks rewrite the params.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  // The URL is the entry point (dashboard deep links, bookmarks) — it
  // initializes and stays in sync with local filter state, which drives
  // the render. Buttons write both.
  const [kindFilter, setKindFilter] = useState<KindFilter>(() =>
    parseKind(searchParams.get("kind")),
  );
  const [windowFilter, setWindowFilter] = useState<WindowFilter>(() =>
    parseWindow(searchParams.get("window")),
  );
  useEffect(() => {
    setKindFilter(parseKind(searchParams.get("kind")));
    setWindowFilter(parseWindow(searchParams.get("window")));
  }, [searchParams]);
  const setFilters = (kind: KindFilter, window: WindowFilter) => {
    setKindFilter(kind);
    setWindowFilter(window);
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    if (window !== "all") params.set("window", window);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  // Derived states are date-relative; fix "today" at load so rows don't
  // shift mid-session.
  const [today] = useState(() => todayIsoDate());

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setItems(await getVetQueueAction());
    } catch (error) {
      logError("medical", "admin-queue-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  if (loading) {
    return <div>Loading...</div>;
  }
  if (loadError) {
    return <LoadError label="veterinary queue" onRetry={loadQueue} />;
  }

  const all = items;
  const filtered = all.filter(
    (item) =>
      (kindFilter === "all" || item.kind === kindFilter) &&
      matchesWindow(item, windowFilter, today),
  );
  const overdueCount = all.filter(
    (i) => i.kind !== "alert" && itemDate(i) < today,
  ).length;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Veterinary work queue</h1>
        <p className="text-muted-foreground mt-1">
          What needs attention: overdue and upcoming rechecks, animals
          expected at clinic, vaccinations due, and active medical alerts.
          Sorted by urgency — work the list top to bottom.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-4">
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Filter by type"
        >
          <span className="text-sm text-muted-foreground mr-1">Show:</span>
          {KIND_FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={kindFilter === f.value ? "default" : "outline"}
              aria-pressed={kindFilter === f.value}
              onClick={() => setFilters(f.value, windowFilter)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Filter by due window"
        >
          <span className="text-sm text-muted-foreground mr-1">Window:</span>
          {WINDOW_FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={windowFilter === f.value ? "default" : "outline"}
              aria-pressed={windowFilter === f.value}
              onClick={() => setFilters(kindFilter, f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        {overdueCount > 0 && (
          <span className="text-sm font-medium text-red-700">
            {overdueCount} overdue
          </span>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Action items</CardTitle>
          <CardDescription>
            {filtered.length === 1
              ? "1 item needs attention"
              : `${filtered.length} items need attention`}
            {windowFilter !== "all" || kindFilter !== "all"
              ? " (filtered)"
              : ""}
            . Open the animal&apos;s record to act, or complete a recheck
            directly here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-28">Due</TableHead>
                <TableHead>Animal</TableHead>
                <TableHead className="w-28">Type</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="w-32">Owner</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500">
                    {all.length === 0
                      ? "Nothing needs attention — no open veterinary work."
                      : "No items match this filter."}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((item) => (
                  <TableRow key={`${item.kind}-${item.id}`}>
                    <TableCell className="align-top">
                      <StateBadge item={item} />
                    </TableCell>
                    <TableCell className="align-top whitespace-nowrap">
                      {item.kind === "alert" ? "—" : itemDate(item)}
                    </TableCell>
                    <TableCell className="align-top">
                      <Link
                        href={`/admin/animals/${item.animal.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {item.animal.name}
                      </Link>
                      <span className="text-muted-foreground capitalize">
                        {" "}
                        · {item.animal.species}
                      </span>
                    </TableCell>
                    <TableCell className="align-top">
                      <TypeBadge item={item} />
                    </TableCell>
                    <TableCell className="align-top">
                      <ItemDetails item={item} />
                    </TableCell>
                    <TableCell className="align-top">
                      {item.kind === "alert"
                        ? "—"
                        : (item.currentOwnerName ?? "—")}
                    </TableCell>
                    <TableCell className="align-top text-right">
                      {item.kind === "follow-up" && (
                        <FollowUpResolveButtons
                          followUpId={item.id}
                          updatedAt={item.updatedAt}
                          label={`${item.reason ?? "recheck"} — ${item.animal.name}`}
                          onResolved={loadQueue}
                        />
                      )}
                      {item.kind === "clinic" && (
                        <ClinicExpectationResolveButtons
                          expectationId={item.id}
                          updatedAt={item.updatedAt}
                          label={`${item.reason} — ${item.animal.name}`}
                          onResolved={loadQueue}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
