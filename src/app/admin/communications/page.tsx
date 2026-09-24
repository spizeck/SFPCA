"use client";

// Communications + reminder exceptions (#172). The staff surface is
// exception-first: volunteers work the failures and data gaps, not a
// list of every successful send — delivery history stays visible below
// for context, and per-animal history lives on the animal record.
//
// "Preview next run" runs the same eligibility evaluation as the
// scheduled cron in dry-run mode: nothing is written, nothing is sent.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getCommunicationsOverviewAction,
  requeueCommunicationAction,
  runReminderDryRunAction,
  setReminderPreferenceAction,
  type CommunicationsOverview,
} from "./actions";
import type { AdminCommunication } from "@/lib/registry/communications";
import type { ReminderCycleResult } from "@/lib/registry/reminders";
import { REMINDER_POLICIES } from "@/lib/reminders/policy";
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
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { logError } from "@/lib/logger";
import { FlaskConical } from "lucide-react";

const KIND_LABELS: Record<string, string> = {
  "vaccination-reminder": "Vaccination reminder",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  queued: "secondary",
  sending: "secondary",
  sent: "default",
  delivered: "default",
  failed: "destructive",
  skipped: "outline",
};

// Human labels for the bounded detail vocabulary — staff should never
// have to decode a machine reason.
const DETAIL_LABELS: Record<string, string> = {
  "no-owner": "No current owner on record",
  "ambiguous-ownership": "Multiple owners recorded — needs cleanup",
  "household-no-contact": "Household has no contactable person",
  "missing-email": "Owner has no email address",
  "invalid-email": "Owner email looks invalid",
  "opted-out": "Recipient opted out",
  "provider-rejected": "Rejected by email provider",
  "provider-unavailable": "Provider unavailable — will retry",
  "retry-exhausted": "Retries exhausted",
  interrupted: "Send interrupted — verify in Resend before requeueing",
  bounced: "Bounced",
  complained: "Marked as spam by recipient",
  "delivery-failed": "Delivery failed",
  malformed: "Message malformed — missing content or recipient",
};

const SUPPRESS_LABELS: Record<string, string> = {
  cooldown: "in cooldown",
  exhausted: "touch limit reached",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function detailLabel(detail: string | null): string {
  if (!detail) return "—";
  return DETAIL_LABELS[detail] ?? detail;
}

function isOptionalKind(kind: string): boolean {
  return (
    (REMINDER_POLICIES as Record<string, { optional?: boolean }>)[kind]
      ?.optional === true
  );
}

function formatWhen(iso: string): string {
  // Date-only display — volunteers think in days, not timestamps.
  return iso.slice(0, 10);
}

function CommStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANTS[status] ?? "outline"}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

function ExceptionActions({
  comm,
  onChanged,
}: {
  comm: AdminCommunication;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const mutation = useMutation();
  const label = `${kindLabel(comm.kind)} — ${comm.animalName ?? "unknown animal"}`;

  const requeue = () =>
    mutation.run(async () => {
      const result = await requeueCommunicationAction(comm.id);
      if (result.ok) {
        toast({ title: "Done", description: `${label} queued to resend.` });
        onChanged();
      } else {
        toast({
          title: "Error",
          description:
            result.reason === "attempts-exhausted"
              ? "This message has hit its attempt limit."
              : "Could not requeue. Try again.",
          variant: "destructive",
        });
      }
    });

  const setOptOut = (optedOut: boolean) =>
    mutation.run(async () => {
      if (!comm.personId) return;
      const result = await setReminderPreferenceAction(
        comm.personId,
        comm.kind,
        optedOut,
      );
      if (result.ok) {
        toast({
          title: "Done",
          description: optedOut
            ? "Optional reminders suppressed for this owner."
            : "Reminders resumed for this owner.",
        });
        onChanged();
      } else {
        toast({
          title: "Error",
          description: "Could not save the preference. Try again.",
          variant: "destructive",
        });
      }
    });

  return (
    <div className="flex items-center justify-end gap-1">
      {comm.status === "failed" && (
        <Button
          variant="outline"
          size="sm"
          onClick={requeue}
          disabled={mutation.pending}
          aria-label={`Requeue ${label}`}
        >
          Requeue
        </Button>
      )}
      {comm.personId && isOptionalKind(comm.kind) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOptOut(!comm.optedOut)}
          disabled={mutation.pending}
          aria-label={
            comm.optedOut
              ? `Resume reminders for ${comm.personName ?? "this owner"}`
              : `Stop reminders for ${comm.personName ?? "this owner"}`
          }
        >
          {comm.optedOut ? "Resume reminders" : "Stop reminders"}
        </Button>
      )}
    </div>
  );
}

export default function CommunicationsPage() {
  const { toast } = useToast();
  const dryRun = useMutation();
  const [overview, setOverview] = useState<CommunicationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [preview, setPreview] = useState<ReminderCycleResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setOverview(await getCommunicationsOverviewAction());
    } catch (error) {
      logError("communications", "admin-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runPreview = () =>
    dryRun.run(async () => {
      try {
        setPreview(await runReminderDryRunAction());
      } catch (error) {
        logError("communications", "admin-dry-run", error);
        toast({
          title: "Error",
          description: "Dry run failed. Try again.",
          variant: "destructive",
        });
      }
    });

  if (loading) {
    return <div>Loading...</div>;
  }
  if (loadError || !overview) {
    return <LoadError label="communications" onRetry={load} />;
  }

  const { summary, exceptions, recent } = overview;
  const actionableExceptions = exceptions.filter(
    (e) => !(e.status === "skipped" && e.detail === "opted-out"),
  );

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Communications</h1>
        <p className="text-muted-foreground mt-1">
          Automated owner reminders and their delivery outcomes. Work the
          exceptions list — successful sends are history, not work.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Dry run</CardTitle>
          <CardDescription>
            Evaluate today&apos;s reminder eligibility without writing or
            sending anything — the safe check before the scheduled run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={runPreview}
            disabled={dryRun.pending}
          >
            <FlaskConical className="h-4 w-4 mr-2" />
            {dryRun.pending ? "Evaluating…" : "Preview next reminder run"}
          </Button>
          {preview && (
            <div className="mt-4 text-sm space-y-1" aria-live="polite">
              <p>
                As of {preview.asOf}: {preview.evaluated} evaluated,{" "}
                {preview.queued} would queue, {preview.skipped} would skip,{" "}
                {preview.suppressed} already recorded or suppressed.
              </p>
              {Object.entries(preview.skippedByReason).length > 0 && (
                <p className="text-muted-foreground">
                  Skip reasons:{" "}
                  {Object.entries(preview.skippedByReason)
                    .map(
                      ([reason, count]) =>
                        `${detailLabel(reason)} (${count})`,
                    )
                    .join(", ")}
                </p>
              )}
              {Object.entries(preview.suppressedByReason).length > 0 && (
                <p className="text-muted-foreground">
                  Suppressed:{" "}
                  {Object.entries(preview.suppressedByReason)
                    .map(
                      ([reason, count]) =>
                        `${SUPPRESS_LABELS[reason] ?? reason} (${count})`,
                    )
                    .join(", ")}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Exceptions</CardTitle>
          <CardDescription>
            {actionableExceptions.length === 0
              ? "Nothing needs attention — no failed deliveries or unresolved recipients."
              : `${actionableExceptions.length} item${actionableExceptions.length === 1 ? "" : "s"} need attention.`}{" "}
            Fix the underlying record, then requeue or suppress the
            reminder.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-40">Kind</TableHead>
                <TableHead>Animal</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-24">Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500">
                    No exceptions recorded.
                  </TableCell>
                </TableRow>
              ) : (
                exceptions.map((comm) => (
                  <TableRow key={comm.id}>
                    <TableCell>
                      <CommStatusBadge status={comm.status} />
                    </TableCell>
                    <TableCell>{kindLabel(comm.kind)}</TableCell>
                    <TableCell>
                      {comm.animalId && comm.animalName ? (
                        <Link
                          href={`/admin/animals/${comm.animalId}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {comm.animalName}
                        </Link>
                      ) : (
                        (comm.animalName ?? "—")
                      )}
                    </TableCell>
                    <TableCell>{comm.personName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {detailLabel(comm.detail)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatWhen(comm.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ExceptionActions comm={comm} onChanged={load} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Send history</CardTitle>
          <CardDescription>
            Recent messages across all reminder kinds —{" "}
            {summary.delivered} delivered, {summary.sent} sent,{" "}
            {summary.queued} queued, {summary.failed} failed,{" "}
            {summary.skipped} skipped overall.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-40">Kind</TableHead>
                <TableHead>Animal</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="w-24">Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-gray-500">
                    No messages recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                recent.map((comm) => (
                  <TableRow key={comm.id}>
                    <TableCell>
                      <CommStatusBadge status={comm.status} />
                    </TableCell>
                    <TableCell>{kindLabel(comm.kind)}</TableCell>
                    <TableCell>
                      {comm.animalId && comm.animalName ? (
                        <Link
                          href={`/admin/animals/${comm.animalId}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {comm.animalName}
                        </Link>
                      ) : (
                        (comm.animalName ?? "—")
                      )}
                    </TableCell>
                    <TableCell>{comm.personName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {comm.subject ?? detailLabel(comm.detail)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {comm.sentAt
                        ? formatWhen(comm.sentAt)
                        : formatWhen(comm.createdAt)}
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
