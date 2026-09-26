// Admin home (#177) — an exception dashboard, not a directory of
// tools. The page answers "what actually needs my attention?" by
// composing every domain's canonical summary through getDashboardWork
// (src/lib/registry/dashboard.ts) — no business logic lives here.
//
// Hierarchy: "Needs attention" (overdue first, then actionable work),
// then "Coming up" (legitimately due soon, not alarming), then the
// quiet all-clear when there's genuinely nothing. Each item links to
// the filtered list or anchored queue section where the work happens.
// A failed domain summary renders as an explicit "couldn't load" row —
// a failure is never painted as zero.
//
// Roles: admin_users defines 'admin' and 'editor', and today both see
// the same queues — every destination authorizes identically. The role
// is passed into the composition so future per-role queues filter in
// one place.

import Link from "next/link";
import { Suspense } from "react";
import { requireAdmin } from "@/lib/auth";
import {
  getDashboardWork,
  DASHBOARD_URGENCY_LABELS,
  type DashboardWorkItem,
  type DashboardFailure,
} from "@/lib/registry/dashboard";
import { logError } from "@/lib/logger";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  CircleCheck,
  CircleAlert,
  Clock,
  FileText,
  PawPrint,
  Settings,
  ClipboardList,
  CircleQuestionMark,
  ScanLine,
} from "lucide-react";

// Urgency has text + icon semantics — never color alone.
function UrgencyBadge({ urgency }: { urgency: DashboardWorkItem["urgency"] }) {
  if (urgency === "overdue") {
    return <Badge variant="destructive">Overdue</Badge>;
  }
  if (urgency === "action") {
    return <Badge variant="default">Needs action</Badge>;
  }
  return <Badge variant="secondary">Coming up</Badge>;
}

function WorkItemRow({ item }: { item: DashboardWorkItem }) {
  return (
    <li>
      <Link
        href={item.href}
        className="flex items-center gap-3 py-3 px-2 -mx-2 rounded-md hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group"
        aria-label={`${item.label} — ${DASHBOARD_URGENCY_LABELS[item.urgency]}. Open the ${item.domain} queue.`}
      >
        <span className="text-2xl font-bold tabular-nums w-10 text-center flex-shrink-0">
          {item.count}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-medium block truncate">{item.label}</span>
          <span className="text-xs text-muted-foreground">{item.domain}</span>
        </span>
        <UrgencyBadge urgency={item.urgency} />
        <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0 group-hover:translate-x-0.5 transition-transform" />
      </Link>
    </li>
  );
}

function FailureRow({ failure }: { failure: DashboardFailure }) {
  return (
    <li>
      <Link
        href={failure.href}
        className="flex items-center gap-3 py-3 px-2 -mx-2 rounded-md hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CircleAlert
          className="h-5 w-5 text-amber-600 flex-shrink-0"
          aria-hidden
        />
        <span className="min-w-0 flex-1 text-sm">
          <span className="font-medium">{failure.domain}</span>{" "}
          <span className="text-muted-foreground">
            counts couldn&apos;t load — check this area by hand.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      </Link>
    </li>
  );
}

async function WorkQueues({ role }: { role: "admin" | "editor" }) {
  let work;
  try {
    work = await getDashboardWork(role);
  } catch (error) {
    // The composition is built not to throw, but a total failure still
    // renders a safe page — never a blank admin home.
    logError("dashboard", "compose", error);
    work = null;
  }

  return (
    <section aria-labelledby="needs-attention-heading" className="mb-8">
      <h2
        id="needs-attention-heading"
        className="text-xl font-semibold mb-3 flex items-center gap-2"
      >
        <CircleAlert className="h-5 w-5 text-destructive" aria-hidden />
        Needs attention
      </h2>

      {work === null ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            The work queues couldn&apos;t be loaded — open the individual
            sections from the menu to check them by hand.
          </CardContent>
        </Card>
      ) : (
        <>
          {work.needsAttention.length === 0 && work.failures.length === 0 ? (
            <Card>
              <CardContent className="py-6 flex items-center gap-3">
                <CircleCheck
                  className="h-6 w-6 text-green-600 flex-shrink-0"
                  aria-hidden
                />
                <p className="text-sm">
                  <span className="font-medium">All clear.</span>{" "}
                  <span className="text-muted-foreground">
                    Nothing is overdue or waiting on staff right now.
                  </span>
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-2">
                <ul className="divide-y">
                  {work.needsAttention.map((item) => (
                    <WorkItemRow key={item.key} item={item} />
                  ))}
                  {work.failures.map((f) => (
                    <FailureRow key={f.key} failure={f} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {work.comingUp.length > 0 && (
            <>
              <h2 className="text-xl font-semibold mt-6 mb-3 flex items-center gap-2">
                <Clock className="h-5 w-5 text-muted-foreground" aria-hidden />
                Coming up
              </h2>
              <Card>
                <CardContent className="py-2">
                  <ul className="divide-y">
                    {work.comingUp.map((item) => (
                      <WorkItemRow key={item.key} item={item} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </>
          )}

          {work.allClear.length > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">
              <CircleCheck
                className="inline h-4 w-4 text-green-600 align-[-2px] mr-1"
                aria-hidden
              />
              Running normally:{" "}
              <span className="sr-only">
                these queues have no work right now —
              </span>
              {work.allClear.join(" · ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function WorkQueuesFallback() {
  return (
    <section aria-labelledby="needs-attention-heading" className="mb-8">
      <h2
        id="needs-attention-heading"
        className="text-xl font-semibold mb-3"
      >
        Needs attention
      </h2>
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Loading work queues…
        </CardContent>
      </Card>
    </section>
  );
}

export default async function AdminDashboard() {
  const { role } = await requireAdmin();

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">Operations dashboard</h1>
      <p className="text-muted-foreground mb-8">
        What needs your attention today — work the list top to bottom.
      </p>

      <Suspense fallback={<WorkQueuesFallback />}>
        <WorkQueues role={role ?? "admin"} />
      </Suspense>

      <section aria-labelledby="tools-heading">
        <h2
          id="tools-heading"
          className="text-xl font-semibold mb-3 text-muted-foreground"
        >
          Tools &amp; content
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3 mb-1">
                <ScanLine className="h-6 w-6 text-primary" />
                <CardTitle className="text-base">Chip Lookup</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Scan a found animal&apos;s microchip to find it and its
                owner
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" className="w-full">
                <Link href="/admin/chip-lookup">Look up a chip</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3 mb-1">
                <PawPrint className="h-6 w-6 text-primary" />
                <CardTitle className="text-base">Animals</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Registry records, photos, and adoption status
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" className="w-full">
                <Link href="/admin/animals">Manage animals</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3 mb-1">
                <ClipboardList className="h-6 w-6 text-primary" />
                <CardTitle className="text-base">Registrations</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Current-period queues, intake review, and receipts
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" className="w-full">
                <Link href="/admin/registrations">View registrations</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3 mb-1">
                <FileText className="h-6 w-6 text-primary" />
                <CardTitle className="text-base">Homepage</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Homepage content, hero, services, and donations
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" className="w-full">
                <Link href="/admin/homepage">Edit homepage</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3 mb-1">
                <CircleQuestionMark className="h-6 w-6 text-primary" />
                <CardTitle className="text-base">FAQ</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Frequently asked questions and help content
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" className="w-full">
                <Link href="/admin/faq">Manage FAQs</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3 mb-1">
                <Settings className="h-6 w-6 text-primary" />
                <CardTitle className="text-base">Settings</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Contact information, social links, and site settings
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" className="w-full">
                <Link href="/admin/settings">Edit settings</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
