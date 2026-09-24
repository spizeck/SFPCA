"use client";

// Per-animal communication history (#172) — what was sent (or skipped)
// about THIS animal, newest first. Read-only context on the medical
// record; exceptions are worked from /admin/communications.

import type { AdminCommunication } from "@/lib/registry/communications";
import { Badge } from "@/components/ui/badge";
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

const DETAIL_LABELS: Record<string, string> = {
  "no-owner": "No owner",
  "ambiguous-ownership": "Ambiguous ownership",
  "household-no-contact": "No contactable person",
  "missing-email": "No email",
  "invalid-email": "Invalid email",
  "opted-out": "Opted out",
  "provider-rejected": "Rejected",
  "provider-unavailable": "Provider unavailable",
  "retry-exhausted": "Retries exhausted",
  interrupted: "Interrupted",
  bounced: "Bounced",
  complained: "Spam complaint",
  "delivery-failed": "Delivery failed",
  malformed: "Malformed",
};

export function CommunicationsPanel({
  communications,
}: {
  communications: AdminCommunication[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Communications</CardTitle>
        <CardDescription>
          Reminders and messages about this animal — newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-44">Kind</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead className="w-28">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {communications.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-gray-500">
                  No communications for this animal.
                </TableCell>
              </TableRow>
            ) : (
              communications.map((comm) => (
                <TableRow key={comm.id}>
                  <TableCell>
                    <Badge
                      variant={
                        comm.status === "failed"
                          ? "destructive"
                          : comm.status === "skipped"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {STATUS_LABELS[comm.status] ?? comm.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{KIND_LABELS[comm.kind] ?? comm.kind}</TableCell>
                  <TableCell>
                    {comm.personName ?? comm.recipient ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {comm.detail ? (DETAIL_LABELS[comm.detail] ?? comm.detail) : "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {(comm.sentAt ?? comm.createdAt).slice(0, 10)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
