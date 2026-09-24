// Dashboard card for communications/reminders (#172) — the count that
// matters is needsAction: failed deliveries plus skipped reminders whose
// reason is a fixable data gap. Successful sends are history, not work,
// so the card surfaces exceptions and links to /admin/communications.
// #177's broader exception dashboard should compose
// communicationSummary() rather than re-querying the ledger.
//
// Rendered inside the admin layout (requireAdmin already ran). A
// registry failure degrades to the card + link, never a broken
// dashboard.

import Link from "next/link";
import {
  communicationSummary,
  type CommunicationSummary,
} from "@/lib/registry/communications";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Mail } from "lucide-react";
import { logError } from "@/lib/logger";

function summaryLine(s: CommunicationSummary): string {
  const parts: string[] = [];
  if (s.needsAction > 0)
    parts.push(
      `${s.needsAction} exception${s.needsAction === 1 ? "" : "s"} need attention`,
    );
  if (s.queued > 0)
    parts.push(`${s.queued} queued to send`);
  if (s.delivered > 0)
    parts.push(`${s.delivered} delivered`);
  return parts.join(" · ");
}

export async function CommunicationsCard() {
  let summary: CommunicationSummary | null = null;
  try {
    summary = await communicationSummary();
  } catch (error) {
    logError("communications", "card-summary", error);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3 mb-2">
          <Mail className="h-8 w-8 text-primary" />
          <CardTitle>Communications</CardTitle>
        </div>
        <CardDescription>
          Automated owner reminders — delivery exceptions and send history
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary === null ? (
          <p className="text-sm text-muted-foreground">
            Counts unavailable — open communications directly.
          </p>
        ) : summary.needsAction === 0 &&
          summary.queued === 0 &&
          summary.delivered === 0 ? (
          <p className="text-sm text-muted-foreground">
            No exceptions and nothing queued.
          </p>
        ) : (
          <p className="text-sm font-medium">{summaryLine(summary)}</p>
        )}
        <Button asChild className="w-full">
          <Link href="/admin/communications">Open communications</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
