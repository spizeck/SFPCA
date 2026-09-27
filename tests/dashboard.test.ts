// Dashboard composition tests (#177) — pure mapping from domain
// summaries to presentation items. The domain services own the "is this
// an exception" logic; these tests pin the contract the dashboard page
// renders:
//   - every item is actionable: label + count + urgency + destination;
//   - overdue floats above ordinary work; due-soon never alarms;
//   - a failed source is a failure row, NEVER a zero;
//   - roles are equivalent today (admin and editor see the same work);
//   - items carry no PII — count, label, href only.
//
// No database: composeDashboard is pure by design so the whole matrix
// is unit-testable. The gather side is covered by tests/db/dashboard.

import { describe, test, expect } from "vitest";
import {
  composeDashboard,
  type DashboardSummaries,
  type DomainResult,
} from "@/lib/registry/dashboard";
import type { RegistrationQueues } from "@/lib/registry/registrations";
import type { CommunicationSummary } from "@/lib/registry/communications";
import type { VetQueueSummary } from "@/lib/registry/vet-queue";

const ok = <T,>(value: T): DomainResult<T> => ({ ok: true, value });
const failed = <T,>(): DomainResult<T> => ({ ok: false });

function emptyRegistrations(): RegistrationQueues {
  return {
    year: 2026,
    unregistered: [],
    pendingSubmissions: 0,
    outstanding: [],
    completed: [],
  };
}

function emptyComms(): CommunicationSummary {
  return {
    queued: 0,
    sending: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
    needsAction: 0,
  };
}

function emptyVet(): VetQueueSummary {
  return {
    overdueFollowUps: 0,
    dueTodayFollowUps: 0,
    upcomingFollowUps: 0,
    overdueExpectations: 0,
    expectedToday: 0,
    upcomingExpectations: 0,
    overdueVaccinations: 0,
    dueSoonVaccinations: 0,
    criticalAlerts: 0,
    importantAlerts: 0,
    total: 0,
  };
}

function emptySummaries(): DashboardSummaries {
  return {
    registrations: ok(emptyRegistrations()),
    pendingPayments: ok(0),
    confirmations: ok(0),
    communications: ok(emptyComms()),
    vetQueue: ok(emptyVet()),
    lostFound: ok({ missing: 0, foundUnmatched: 0, foundMatched: 0 }),
    ownerRequests: ok(0),
    chipConflicts: ok(0),
  };
}

describe("composeDashboard", () => {
  test("everything empty is a genuine all-clear", () => {
    const work = composeDashboard(emptySummaries());
    expect(work.needsAttention).toHaveLength(0);
    expect(work.comingUp).toHaveLength(0);
    expect(work.failures).toHaveLength(0);
    // All eight domains loaded clean — the routine strip says so.
    expect(work.allClear).toHaveLength(8);
  });

  test("one domain at a time produces exactly one item", () => {
    const s = emptySummaries();
    s.lostFound = ok({ missing: 1, foundUnmatched: 0, foundMatched: 0 });
    const work = composeDashboard(s);
    expect(work.needsAttention).toHaveLength(1);
    expect(work.needsAttention[0].label).toBe("1 animal reported missing");
    expect(work.needsAttention[0].href).toBe("/admin/lost-found#missing");
  });

  test("multiple domains compose into one attention list", () => {
    const s = emptySummaries();
    s.lostFound = ok({ missing: 2, foundUnmatched: 1, foundMatched: 0 });
    s.chipConflicts = ok(1);
    s.ownerRequests = ok(3);
    const work = composeDashboard(s);
    expect(work.needsAttention.map((i) => i.key)).toEqual([
      "lost-found-missing",
      "lost-found-unmatched",
      "owner-requests-pending",
      "chip-conflicts",
    ]);
  });

  test("overdue items sort above ordinary actionable work", () => {
    const s = emptySummaries();
    s.vetQueue = ok({ ...emptyVet(), overdueFollowUps: 2 });
    s.ownerRequests = ok(5);
    const work = composeDashboard(s);
    expect(work.needsAttention[0].key).toBe("vet-overdue");
    expect(work.needsAttention[0].urgency).toBe("overdue");
  });

  test("due-soon work lands in comingUp, not needsAttention", () => {
    const s = emptySummaries();
    s.vetQueue = ok({
      ...emptyVet(),
      dueSoonVaccinations: 3,
      upcomingFollowUps: 1,
    });
    const work = composeDashboard(s);
    expect(work.needsAttention).toHaveLength(0);
    expect(work.comingUp).toHaveLength(1);
    expect(work.comingUp[0].href).toBe("/admin/vet?window=week");
    expect(work.comingUp[0].urgency).toBe("soon");
  });

  test("registration gap links to the unregistered queue section", () => {
    const s = emptySummaries();
    s.registrations = ok({
      ...emptyRegistrations(),
      unregistered: [
        {
          animalId: "a",
          name: "Rexley",
          registryRef: "SFPCA-1",
          species: "dog",
          sex: "male",
          lifecycleStatus: "active",
          ownerLabel: "Owner",
        },
      ],
    });
    const work = composeDashboard(s);
    const i = work.needsAttention[0];
    expect(i.label).toBe("1 animal missing 2026 registration");
    expect(i.href).toBe("/admin/registrations#unregistered");
  });

  test("unpaid and partial balances are both outstanding work", () => {
    const s = emptySummaries();
    const outstanding = (state: "unpaid" | "partial") => ({
      registrationId: `r-${state}`,
      animalId: "a",
      animalName: "Pet",
      registryRef: "SFPCA-2",
      species: "dog",
      lifecycleStatus: "active",
      ownerLabel: null,
      amountDueCents: 10000,
      currency: "USD",
      paidCents: state === "partial" ? 5000 : 0,
      outstandingCents: state === "partial" ? 5000 : 10000,
      paymentState: state,
      registeredAt: null,
    });
    s.registrations = ok({
      ...emptyRegistrations(),
      outstanding: [outstanding("unpaid"), outstanding("partial")],
    });
    const work = composeDashboard(s);
    const i = work.needsAttention.find(
      (x) => x.key === "registrations-outstanding",
    );
    expect(i?.count).toBe(2);
    expect(i?.href).toBe("/admin/registrations#outstanding");
  });

  test("pending submissions surface as reviewable work", () => {
    const s = emptySummaries();
    s.registrations = ok({ ...emptyRegistrations(), pendingSubmissions: 2 });
    const work = composeDashboard(s);
    const i = work.needsAttention[0];
    expect(i.label).toBe("2 registration submissions awaiting review");
    expect(i.href).toBe("/admin/registrations#submissions");
  });

  test("overdue ownership confirmations are dated work, not noise", () => {
    const s = emptySummaries();
    s.confirmations = ok(4);
    const work = composeDashboard(s);
    const i = work.needsAttention[0];
    expect(i.urgency).toBe("overdue");
    expect(i.href).toBe("/admin/registrations#confirmations");
  });

  test("a delivery failure surfaces; opted-out skips never do", () => {
    // needsAction is already the domain's own definition (failed +
    // fixable skips, opt-outs excluded) — compose trusts it verbatim.
    const s = emptySummaries();
    s.communications = ok({ ...emptyComms(), failed: 2, needsAction: 2 });
    let work = composeDashboard(s);
    expect(work.needsAttention[0].href).toBe(
      "/admin/communications#exceptions",
    );

    const s2 = emptySummaries();
    s2.communications = ok({ ...emptyComms(), skipped: 3, needsAction: 0 });
    work = composeDashboard(s2);
    expect(work.needsAttention).toHaveLength(0);
  });

  test("critical alerts read as urgent; important-only as action", () => {
    const s = emptySummaries();
    s.vetQueue = ok({ ...emptyVet(), criticalAlerts: 1, importantAlerts: 2 });
    const work = composeDashboard(s);
    const i = work.needsAttention.find((x) => x.key === "vet-alerts");
    expect(i?.count).toBe(3);
    expect(i?.urgency).toBe("overdue");
    expect(i?.href).toBe("/admin/vet?kind=alert");

    const s2 = emptySummaries();
    s2.vetQueue = ok({ ...emptyVet(), importantAlerts: 2 });
    expect(
      composeDashboard(s2).needsAttention.find((x) => x.key === "vet-alerts")
        ?.urgency,
    ).toBe("action");
  });

  test("pending payments are a reconciliation queue, not alarm", () => {
    const s = emptySummaries();
    s.pendingPayments = ok(2);
    const work = composeDashboard(s);
    const i = work.needsAttention[0];
    expect(i.label).toBe("2 payments awaiting confirmation");
    expect(i.href).toBe("/admin/registrations#awaiting-confirmation");
  });

  test("pending owner requests link to the pending queue", () => {
    const s = emptySummaries();
    s.ownerRequests = ok(1);
    const work = composeDashboard(s);
    expect(work.needsAttention[0].href).toBe("/admin/requests#pending");
  });

  test("open chip conflicts link to the chip-lookup conflict list", () => {
    const s = emptySummaries();
    s.chipConflicts = ok(2);
    const work = composeDashboard(s);
    expect(work.needsAttention[0].href).toBe("/admin/chip-lookup#conflicts");
  });

  test("a failed domain is a failure row, never a zero count", () => {
    const s = emptySummaries();
    s.vetQueue = failed();
    s.registrations = failed();
    const work = composeDashboard(s);
    // No vet/registrations items — nothing was fetched, nothing shown
    // as empty.
    expect(
      work.needsAttention.find((i) => i.domain.includes("Veter")),
    ).toBeUndefined();
    expect(
      work.needsAttention.find((i) => i.domain === "Registrations"),
    ).toBeUndefined();
    expect(work.failures.map((f) => f.domain)).toEqual(
      expect.arrayContaining(["Registrations", "Veterinary queue"]),
    );
    expect(work.failures).toHaveLength(2);
    // And never listed as clear either — unknown ≠ clear.
    expect(work.allClear).not.toContain("Registrations");
    expect(work.allClear).not.toContain("Veterinary queue");
    // The failure still hands the volunteer a manual destination.
    expect(
      work.failures.find((f) => f.key === "vetQueue")?.href,
    ).toBe("/admin/vet");
  });

  test("roles are equivalent today — admin and editor see the same work", () => {
    const s = emptySummaries();
    s.lostFound = ok({ missing: 1, foundUnmatched: 0, foundMatched: 0 });
    const admin = composeDashboard(s, "admin");
    const editor = composeDashboard(s, "editor");
    expect(editor.needsAttention).toEqual(admin.needsAttention);
  });

  test("items carry only presentation data — no PII surface", () => {
    const s = emptySummaries();
    s.chipConflicts = ok(1);
    const work = composeDashboard(s);
    for (const i of work.needsAttention) {
      expect(Object.keys(i).sort()).toEqual([
        "count",
        "domain",
        "href",
        "key",
        "label",
        "urgency",
      ]);
    }
  });

  test("every item destination is an admin surface that can act on it", () => {
    const s = emptySummaries();
    s.registrations = ok({
      ...emptyRegistrations(),
      pendingSubmissions: 1,
    });
    s.lostFound = ok({ missing: 1, foundUnmatched: 1, foundMatched: 1 });
    s.chipConflicts = ok(1);
    s.ownerRequests = ok(1);
    s.pendingPayments = ok(1);
    s.confirmations = ok(1);
    s.communications = ok({ ...emptyComms(), needsAction: 1 });
    s.vetQueue = ok({
      ...emptyVet(),
      overdueFollowUps: 1,
      dueSoonVaccinations: 1,
    });
    const work = composeDashboard(s);
    for (const i of [...work.needsAttention, ...work.comingUp]) {
      expect(i.href).toMatch(/^\/admin\//);
      expect(i.count).toBeGreaterThan(0);
      expect(i.label.length).toBeGreaterThan(3);
    }
  });
});
