"use server";

// Server actions for the communications/reminder surface (#172). Every
// action self-authorizes via requireAdmin — owner contact data and
// delivery outcomes are staff-only.
//
// The dry-run action is the pre-send check volunteers use before a
// change ships or a cron is enabled: it evaluates the SAME canonical
// eligibility as the live cycle but writes nothing and cannot send —
// the delivery drain is not invoked on that path.

import { requireAdmin } from "@/lib/auth";
import {
  listCommunicationExceptions,
  listRecentCommunications,
  communicationSummary,
  requeueCommunication,
  setCommunicationPreference,
  type AdminCommunication,
  type CommunicationSummary,
} from "@/lib/registry/communications";
import {
  runReminderCycle,
  type ReminderCycleResult,
} from "@/lib/registry/reminders";
import { REMINDER_POLICIES } from "@/lib/reminders/policy";
import { todayIsoDate } from "@/lib/vaccinations";
import { logError } from "@/lib/logger";

export interface CommunicationsOverview {
  summary: CommunicationSummary;
  exceptions: AdminCommunication[];
  recent: AdminCommunication[];
}

export async function getCommunicationsOverviewAction(): Promise<CommunicationsOverview> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const [summary, exceptions, recent] = await Promise.all([
    communicationSummary(),
    listCommunicationExceptions(),
    listRecentCommunications({ limit: 50 }),
  ]);
  return { summary, exceptions, recent };
}

// Evaluate today's reminder eligibility without writing or sending —
// the safe preview before bulk sends. The returned counts describe what
// the next live run would do.
export async function runReminderDryRunAction(): Promise<ReminderCycleResult> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return runReminderCycle({ asOf: todayIsoDate(), dryRun: true });
}

export interface CommActionResult {
  ok: boolean;
  reason?: string;
}

// Manual requeue of a terminal 'failed' row — the staff reconcile path
// for interrupted/uncertain sends and provider rejections. Bounded by
// the service's attempt cap; audited.
export async function requeueCommunicationAction(
  communicationId: string,
): Promise<CommActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await requeueCommunication(
      communicationId,
      user?.email ?? "unknown",
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch (error) {
    logError("communications", "admin-requeue", error);
    return { ok: false };
  }
}

// Record a recipient's opt-out/opt-in for an OPTIONAL reminder kind.
// Operational kinds are not suppressible — the service only accepts
// kinds the policy marks optional, enforced again here so the boundary
// is explicit.
export async function setReminderPreferenceAction(
  personId: string,
  kind: string,
  optedOut: boolean,
): Promise<CommActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const policy = (REMINDER_POLICIES as Record<string, { optional: boolean }>)[
    kind
  ];
  if (!policy?.optional) {
    return { ok: false, reason: "not-optional-kind" };
  }
  try {
    const result = await setCommunicationPreference(
      { personId, channel: "email", kind, optedOut },
      user?.email ?? "unknown",
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch (error) {
    logError("communications", "admin-preference", error);
    return { ok: false };
  }
}
