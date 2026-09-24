// Dashboard card for the veterinary work queue (#175) — summary counts
// linking to /admin/vet, not a second queue. Counts come from
// vetQueueSummary(), which derives from the same canonical listVetQueue
// read the queue page uses, so the two surfaces can never disagree.
// #177's broader exception dashboard should compose this service too
// rather than re-querying the underlying tables.
//
// Rendered inside the admin layout, which already ran requireAdmin —
// this is a server component, not a public surface. A registry failure
// degrades to the card + link (no counts) instead of breaking the
// dashboard.

import Link from "next/link";
import { vetQueueSummary, type VetQueueSummary } from "@/lib/registry/vet-queue";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarClock } from "lucide-react";
import { logError } from "@/lib/logger";

function summaryLine(s: VetQueueSummary): string {
  const parts: string[] = [];
  if (s.overdueFollowUps > 0)
    parts.push(`${s.overdueFollowUps} overdue recheck${s.overdueFollowUps === 1 ? "" : "s"}`);
  if (s.dueTodayFollowUps > 0)
    parts.push(`${s.dueTodayFollowUps} due today`);
  if (s.expectedToday > 0)
    parts.push(`${s.expectedToday} expected at clinic today`);
  if (s.overdueExpectations > 0)
    parts.push(`${s.overdueExpectations} missed clinic visit${s.overdueExpectations === 1 ? "" : "s"}`);
  if (s.overdueVaccinations > 0)
    parts.push(`${s.overdueVaccinations} overdue vaccination${s.overdueVaccinations === 1 ? "" : "s"}`);
  if (s.dueSoonVaccinations > 0)
    parts.push(`${s.dueSoonVaccinations} vaccination${s.dueSoonVaccinations === 1 ? "" : "s"} due soon`);
  if (s.upcomingFollowUps > 0)
    parts.push(`${s.upcomingFollowUps} upcoming recheck${s.upcomingFollowUps === 1 ? "" : "s"}`);
  const alerts = s.criticalAlerts + s.importantAlerts;
  if (alerts > 0)
    parts.push(`${alerts} active alert${alerts === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export async function VetQueueCard() {
  let summary: VetQueueSummary | null = null;
  try {
    summary = await vetQueueSummary();
  } catch (error) {
    logError("medical", "queue-summary", error);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3 mb-2">
          <CalendarClock className="h-8 w-8 text-primary" />
          <CardTitle>Vet Queue</CardTitle>
        </div>
        <CardDescription>
          Rechecks, expected clinic animals, vaccinations due, and medical
          alerts needing attention
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary === null ? (
          <p className="text-sm text-muted-foreground">
            Queue counts unavailable — open the queue directly.
          </p>
        ) : summary.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing needs attention right now.
          </p>
        ) : (
          <p className="text-sm font-medium">{summaryLine(summary)}</p>
        )}
        <Button asChild className="w-full">
          <Link href="/admin/vet">Open vet queue</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
