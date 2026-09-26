// The #177 exception dashboard's single composition seam. Every domain
// keeps its own definition of "an exception" — this module only GATHERS
// the canonical summaries and normalizes their presentation. No SQL or
// business rules live here; the queries are in the domain services.
//
// Actionability rule: an item appears only when a volunteer can act on
// it at its destination. Every item links to the filtered list or
// anchored queue section where the work happens — never a dead-end
// count.
//
// Failure isolation: each domain summary is gathered independently
// (allSettled). A failed source lands in `failures` and renders as an
// explicit "couldn't load" row — NEVER as a zero count. Zero and
// broken are different answers.
//
// Urgency is presentation-only. The domain decides what is overdue
// (due-date rules live in vaccinations/follow-ups/confirmations); the
// dashboard maps each item to one of three states:
//   overdue — the domain's own deadline has passed (or standing critical)
//   action  — needs a volunteer now, but not date-overdue
//   soon    — legitimately upcoming; visible, not alarming
//
// Role filtering: admin_users defines 'admin' and 'editor', but today
// every admin-area workflow authorizes both identically — there are no
// per-role queues to invent. The role is threaded through
// composeDashboard so a future per-role surface filters in one place
// rather than retrofitting the composition. Destination routes stay
// server-authorized regardless.
//
// #178 extension seam: when the duplicate/data-quality work lands, it
// adds ONE summary source (e.g. countDuplicateFlags) to
// gatherDashboardSummaries and one block in composeDashboard — the
// dashboard page and this plumbing don't change.

import "server-only";

import type { AdminRole } from "./admin-users";
import type { RegistryDb } from "./public-animals";
import { getRegistryDb } from "../db/client";
import { logError } from "../logger";
import {
  getRegistrationQueues,
  type RegistrationQueues,
} from "./registrations";
import { listPendingPayments } from "./payments";
import { listOwnershipsRequiringConfirmation } from "./ownership";
import {
  communicationSummary,
  type CommunicationSummary,
} from "./communications";
import { vetQueueSummary, type VetQueueSummary } from "./vet-queue";
import { getOpenCaseCounts } from "./lost-found";
import { countPendingOwnerRequests } from "./owner-requests";
import { countOpenChipConflicts } from "./microchips";

// --- Presentation model ----------------------------------------------------------

export type DashboardUrgency = "overdue" | "action" | "soon";

export const DASHBOARD_URGENCY_LABELS: Record<DashboardUrgency, string> = {
  overdue: "Overdue",
  action: "Needs action",
  soon: "Coming up",
};

export interface DashboardWorkItem {
  key: string;
  domain: string;
  // Display-ready line, e.g. "3 animals missing 2026 registration".
  label: string;
  count: number;
  urgency: DashboardUrgency;
  // The filtered list or anchored queue section where the work happens.
  href: string;
}

// A domain whose summary could not be loaded. Rendered explicitly —
// silence would look like "all clear" and that's a lie.
export interface DashboardFailure {
  key: string;
  domain: string;
  // Where the volunteer can still check this area by hand.
  href: string;
}

export interface DashboardWork {
  needsAttention: DashboardWorkItem[]; // overdue first, then action
  comingUp: DashboardWorkItem[]; // soon
  // Labels of domains whose summary loaded AND produced no work —
  // rendered as one quiet line so a calm day reads as calm, not as
  // nine zero-count cards.
  allClear: string[];
  failures: DashboardFailure[];
  generatedAt: string;
}

// --- Summaries --------------------------------------------------------------------

// Result wrapper so composeDashboard stays pure: unit tests inject
// failures directly instead of breaking a real database.
export type DomainResult<T> = { ok: true; value: T } | { ok: false };

export interface DashboardSummaries {
  registrations: DomainResult<RegistrationQueues>;
  pendingPayments: DomainResult<number>;
  confirmations: DomainResult<number>;
  communications: DomainResult<CommunicationSummary>;
  vetQueue: DomainResult<VetQueueSummary>;
  lostFound: DomainResult<{
    missing: number;
    foundUnmatched: number;
    foundMatched: number;
  }>;
  ownerRequests: DomainResult<number>;
  chipConflicts: DomainResult<number>;
}

// Gather every domain's canonical summary concurrently. A rejected
// promise becomes {ok:false} for its domain only — the rest still land.
export async function gatherDashboardSummaries(
  db: RegistryDb = getRegistryDb(),
): Promise<DashboardSummaries> {
  async function attempt<T>(
    domain: string,
    load: () => Promise<T>,
  ): Promise<DomainResult<T>> {
    try {
      return { ok: true, value: await load() };
    } catch (error) {
      logError("dashboard", `${domain}-summary`, error);
      return { ok: false };
    }
  }

  const [
    registrations,
    pendingPayments,
    confirmations,
    communications,
    vetQueue,
    lostFound,
    ownerRequests,
    chipConflicts,
  ] = await Promise.all([
    attempt("registrations", () => getRegistrationQueues({}, db)),
    attempt("payments", async () => (await listPendingPayments({}, db)).length),
    attempt(
      "confirmations",
      async () => (await listOwnershipsRequiringConfirmation({}, db)).length,
    ),
    attempt("communications", () => communicationSummary(db)),
    attempt("vet-queue", () => vetQueueSummary({}, db)),
    attempt("lost-found", () => getOpenCaseCounts(db)),
    attempt("owner-requests", () => countPendingOwnerRequests(db)),
    attempt("chip-conflicts", () => countOpenChipConflicts(db)),
  ]);

  return {
    registrations,
    pendingPayments,
    confirmations,
    communications,
    vetQueue,
    lostFound,
    ownerRequests,
    chipConflicts,
  };
}

// --- Composition ------------------------------------------------------------------

function plural(n: number, one: string, many?: string): string {
  return n === 1 ? one : (many ?? `${one}s`);
}

function item(
  key: string,
  domain: string,
  count: number,
  label: string,
  urgency: DashboardUrgency,
  href: string,
): DashboardWorkItem {
  return { key, domain, label: `${count} ${label}`, count, urgency, href };
}

const FAILURE_DESTINATIONS: Record<keyof DashboardSummaries, { domain: string; href: string }> = {
  registrations: { domain: "Registrations", href: "/admin/registrations" },
  pendingPayments: { domain: "Payments", href: "/admin/registrations" },
  confirmations: { domain: "Confirmations", href: "/admin/registrations" },
  communications: { domain: "Communications", href: "/admin/communications" },
  vetQueue: { domain: "Veterinary queue", href: "/admin/vet" },
  lostFound: { domain: "Lost & found", href: "/admin/lost-found" },
  ownerRequests: { domain: "Owner requests", href: "/admin/requests" },
  chipConflicts: { domain: "Chip conflicts", href: "/admin/chip-lookup" },
};

// Map domain summaries to presentation items. Pure — no I/O — so the
// whole matrix (empty state, per-domain, urgency, failure-not-zero) is
// unit-testable.
export function composeDashboard(
  summaries: DashboardSummaries,
  _role: AdminRole = "admin",
): DashboardWork {
  const attention: DashboardWorkItem[] = [];
  const soon: DashboardWorkItem[] = [];
  const failures: DashboardFailure[] = [];

  const reg = summaries.registrations;
  let regHasWork = false;
  if (reg.ok) {
    const q = reg.value;
    if (q.unregistered.length > 0) {
      attention.push(
        item(
          "registrations-unregistered",
          "Registrations",
          q.unregistered.length,
          plural(q.unregistered.length, "animal") +
            ` missing ${q.year} registration`,
          "action",
          "/admin/registrations#unregistered",
        ),
      );
      regHasWork = true;
    }
    if (q.pendingSubmissions > 0) {
      attention.push(
        item(
          "registrations-submissions",
          "Registrations",
          q.pendingSubmissions,
          plural(q.pendingSubmissions, "registration submission") +
            " awaiting review",
          "action",
          "/admin/registrations#submissions",
        ),
      );
      regHasWork = true;
    }
    if (q.outstanding.length > 0) {
      attention.push(
        item(
          "registrations-outstanding",
          "Registrations",
          q.outstanding.length,
          plural(q.outstanding.length, "registration") +
            " with an unpaid balance",
          "action",
          "/admin/registrations#outstanding",
        ),
      );
      regHasWork = true;
    }
  }

  const pay = summaries.pendingPayments;
  if (pay.ok && pay.value > 0) {
    attention.push(
      item(
        "payments-pending",
        "Payments",
        pay.value,
        plural(pay.value, "payment") + " awaiting confirmation",
        "action",
        "/admin/registrations#awaiting-confirmation",
      ),
    );
  }

  const conf = summaries.confirmations;
  if (conf.ok && conf.value > 0) {
    attention.push(
      item(
        "confirmations-due",
        "Confirmations",
        conf.value,
        "overdue ownership " +
          plural(conf.value, "confirmation", "confirmations"),
        "overdue",
        "/admin/registrations#confirmations",
      ),
    );
  }

  const comms = summaries.communications;
  if (comms.ok && comms.value.needsAction > 0) {
    attention.push(
      item(
        "communications-exceptions",
        "Communications",
        comms.value.needsAction,
        "delivery " +
          plural(comms.value.needsAction, "exception", "exceptions") +
          " to review",
        "action",
        "/admin/communications#exceptions",
      ),
    );
  }

  const vet = summaries.vetQueue;
  if (vet.ok) {
    const v = vet.value;
    const overdue =
      v.overdueFollowUps + v.overdueExpectations + v.overdueVaccinations;
    if (overdue > 0) {
      attention.push(
        item(
          "vet-overdue",
          "Veterinary queue",
          overdue,
          plural(overdue, "vet item") + " overdue",
          "overdue",
          "/admin/vet?window=overdue",
        ),
      );
    }
    const alerts = v.criticalAlerts + v.importantAlerts;
    if (alerts > 0) {
      attention.push(
        item(
          "vet-alerts",
          "Veterinary queue",
          alerts,
          "active medical " + plural(alerts, "alert"),
          // A critical alert is standing-urgent; important-only is work.
          v.criticalAlerts > 0 ? "overdue" : "action",
          "/admin/vet?kind=alert",
        ),
      );
    }
    const dueToday = v.dueTodayFollowUps + v.expectedToday;
    if (dueToday > 0) {
      attention.push(
        item(
          "vet-today",
          "Veterinary queue",
          dueToday,
          plural(dueToday, "vet item") + " due today",
          "action",
          "/admin/vet?window=today",
        ),
      );
    }
    const upcoming =
      v.dueSoonVaccinations + v.upcomingFollowUps + v.upcomingExpectations;
    if (upcoming > 0) {
      soon.push(
        item(
          "vet-upcoming",
          "Veterinary queue",
          upcoming,
          plural(upcoming, "vet item") + " coming up",
          "soon",
          "/admin/vet?window=week",
        ),
      );
    }
  }

  const lf = summaries.lostFound;
  if (lf.ok) {
    if (lf.value.missing > 0) {
      attention.push(
        item(
          "lost-found-missing",
          "Lost & found",
          lf.value.missing,
          plural(lf.value.missing, "animal") + " reported missing",
          "action",
          "/admin/lost-found#missing",
        ),
      );
    }
    if (lf.value.foundUnmatched > 0) {
      attention.push(
        item(
          "lost-found-unmatched",
          "Lost & found",
          lf.value.foundUnmatched,
          plural(lf.value.foundUnmatched, "found animal") +
            " to match to the registry",
          "action",
          "/admin/lost-found#unmatched",
        ),
      );
    }
    if (lf.value.foundMatched > 0) {
      attention.push(
        item(
          "lost-found-matched",
          "Lost & found",
          lf.value.foundMatched,
          plural(lf.value.foundMatched, "found case") +
            " matched, awaiting resolution",
          "action",
          "/admin/lost-found#matched",
        ),
      );
    }
  }

  const req = summaries.ownerRequests;
  if (req.ok && req.value > 0) {
    attention.push(
      item(
        "owner-requests-pending",
        "Owner requests",
        req.value,
        "owner " + plural(req.value, "request") + " awaiting review",
        "action",
        "/admin/requests#pending",
      ),
    );
  }

  const chip = summaries.chipConflicts;
  if (chip.ok && chip.value > 0) {
    attention.push(
      item(
        "chip-conflicts",
        "Chip conflicts",
        chip.value,
        "microchip " + plural(chip.value, "conflict") + " to resolve",
        "action",
        "/admin/chip-lookup#conflicts",
      ),
    );
  }

  for (const [key, result] of Object.entries(summaries) as [
    keyof DashboardSummaries,
    DomainResult<unknown>,
  ][]) {
    if (!result.ok) {
      const dest = FAILURE_DESTINATIONS[key];
      failures.push({ key, domain: dest.domain, href: dest.href });
    }
  }

  // A domain is "clear" only when its summary loaded AND contributed no
  // items anywhere — a domain with coming-up work is neither clear nor
  // alarming, and a failed domain is never listed as clear.
  const allClear: string[] = [];
  if (reg.ok && !regHasWork) allClear.push("Registrations");
  if (pay.ok && pay.value === 0) allClear.push("Payments");
  if (conf.ok && conf.value === 0) allClear.push("Confirmations");
  if (comms.ok && comms.value.needsAction === 0)
    allClear.push("Communications");
  if (
    vet.ok &&
    vet.value.overdueFollowUps +
      vet.value.overdueExpectations +
      vet.value.overdueVaccinations +
      vet.value.criticalAlerts +
      vet.value.importantAlerts +
      vet.value.dueTodayFollowUps +
      vet.value.expectedToday +
      vet.value.dueSoonVaccinations +
      vet.value.upcomingFollowUps +
      vet.value.upcomingExpectations ===
      0
  )
    allClear.push("Veterinary queue");
  if (
    lf.ok &&
    lf.value.missing + lf.value.foundUnmatched + lf.value.foundMatched === 0
  )
    allClear.push("Lost & found");
  if (req.ok && req.value === 0) allClear.push("Owner requests");
  if (chip.ok && chip.value === 0) allClear.push("Chip conflicts");

  // Overdue floats to the top of needs-attention; declaration order
  // otherwise holds so the layout is predictable scan-to-scan.
  const overdue = attention.filter((i) => i.urgency === "overdue");
  const actionable = attention.filter((i) => i.urgency !== "overdue");

  return {
    needsAttention: [...overdue, ...actionable],
    comingUp: soon,
    allClear,
    failures,
    generatedAt: new Date().toISOString(),
  };
}

// The one call the admin home makes.
export async function getDashboardWork(
  role: AdminRole = "admin",
  db: RegistryDb = getRegistryDb(),
): Promise<DashboardWork> {
  return composeDashboard(await gatherDashboardSummaries(db), role);
}
