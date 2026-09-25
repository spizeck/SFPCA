// Dashboard card for the lost/found queue (#176) — summary counts
// linking to /admin/lost-found, not a second queue. Counts come from
// getOpenCaseCounts(), which derives from the same open-case read the
// workspace uses, so the two surfaces can never disagree. #177's
// broader exception dashboard should compose this service too rather
// than re-querying the underlying tables.
//
// Rendered inside the admin layout, which already ran requireAdmin —
// this is a server component, not a public surface. A registry failure
// degrades to the card + link (no counts) instead of breaking the
// dashboard.

import Link from "next/link";
import { getOpenCaseCounts } from "@/lib/registry/lost-found";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";
import { logError } from "@/lib/logger";

export async function LostFoundCard() {
  let counts: Awaited<ReturnType<typeof getOpenCaseCounts>> | null = null;
  try {
    counts = await getOpenCaseCounts();
  } catch (error) {
    logError("lost-found", "queue-summary", error);
  }

  const parts: string[] = [];
  if (counts) {
    if (counts.missing > 0)
      parts.push(
        `${counts.missing} missing animal${counts.missing === 1 ? "" : "s"}`,
      );
    if (counts.foundUnmatched > 0)
      parts.push(
        `${counts.foundUnmatched} found to match${counts.foundUnmatched === 1 ? "" : ""}`,
      );
    if (counts.foundMatched > 0)
      parts.push(
        `${counts.foundMatched} matched awaiting resolution`,
      );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3 mb-2">
          <Search className="h-8 w-8 text-primary" />
          <CardTitle>Lost &amp; Found</CardTitle>
        </div>
        <CardDescription>
          Missing animals and found animals — open cases needing staff
          work
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {counts === null ? (
          <p className="text-sm text-muted-foreground">
            Queue counts unavailable — open the workspace directly.
          </p>
        ) : parts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open lost/found cases right now.
          </p>
        ) : (
          <p className="text-sm font-medium">{parts.join(" · ")}</p>
        )}
        <Button asChild className="w-full">
          <Link href="/admin/lost-found">Open lost &amp; found</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
