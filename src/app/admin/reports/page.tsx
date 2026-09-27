// Staff reporting workspace (#179) — turns the canonical registry into
// planning numbers. Presentation only: every figure comes from
// getStaffReport (src/lib/registry/reports.ts), which derives from the
// authoritative services; nothing is computed here.
//
// Two disciplines the page enforces visibly:
//   - population wording never overclaims — "active animals known to
//     SFPCA", never "animals on Saba";
//   - every metric carries its denominator/period in plain text next to
//     the number, so "73% microchipped" always says "of what, as of
//     when".
//
// Self-authorization: the admin layout guards the route, AND this page
// calls requireAdmin() itself — route protection alone is never the
// authorization boundary.

import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getStaffReport } from "@/lib/registry/reports";
import { REGISTRATION_PAYMENT_STATE_LABELS } from "@/lib/registrations";
import { VACCINATION_DUE_STATE_LABELS } from "@/lib/vaccinations";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download } from "lucide-react";

export const metadata: Metadata = {
  title: "Reports",
};

// Reports read live registry state — never prerender or cache.
export const dynamic = "force-dynamic";

const usd = (cents: number) => `${(cents / 100).toFixed(2)} USD`;
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

function Section({
  title,
  definition,
  children,
}: {
  title: string;
  definition: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{definition}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function CountTable({
  rows,
  caption,
}: {
  rows: { label: string; count: number; hint?: string }[];
  caption?: string;
}) {
  return (
    <Table>
      {caption && <caption className="sr-only">{caption}</caption>}
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Category</TableHead>
          <TableHead scope="col" className="text-right">
            Count
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.label}>
            <TableCell>
              {r.label}
              {r.hint && (
                <span className="block text-xs text-muted-foreground">
                  {r.hint}
                </span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {r.count}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; asof?: string }>;
}) {
  // Page-level authorization — never rely on layout/proxy alone.
  const { authorized } = await requireAdmin();
  if (!authorized) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Not authorized.</p>
      </div>
    );
  }

  const params = await searchParams;
  const report = await getStaffReport({
    year: params.year ? Number(params.year) : undefined,
    asOf: params.asof,
  });
  const { asOf, year } = report;

  const exportQuery = (name: string) =>
    `/admin/reports/export?report=${name}&year=${year}&asof=${asOf}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Registry reports</h1>
        <p className="text-muted-foreground mt-1">
          Figures describe <strong>animals known to SFPCA</strong> — the
          registry, not a census of all animals on Saba. Population
          counts are current as of <strong>{asOf}</strong>; the selected
          registration period is <strong>{year}</strong>.
        </p>
      </div>

      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-md border p-4"
      >
        <div className="space-y-1">
          <Label htmlFor="year">Registration period</Label>
          <select
            id="year"
            name="year"
            defaultValue={year}
            className="flex h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {report.availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="asof">As of date</Label>
          <Input
            id="asof"
            name="asof"
            type="date"
            defaultValue={asOf}
            className="w-auto"
          />
        </div>
        <Button type="submit">Update report</Button>
        <span className="text-xs text-muted-foreground">
          The period scopes registration and payment metrics; population
          figures always describe the registry as of the report date.
        </span>
      </form>

      <div className="flex flex-wrap gap-2 text-sm">
        <span className="text-muted-foreground self-center">
          Download CSV:
        </span>
        <Button asChild variant="outline" size="sm">
          <a href={exportQuery("overview")} download>
            <Download className="h-3.5 w-3.5 mr-1" />
            Overview ({year})
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={exportQuery("period")} download>
            <Download className="h-3.5 w-3.5 mr-1" />
            Registration detail ({year})
          </a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={exportQuery("trends")} download>
            <Download className="h-3.5 w-3.5 mr-1" />
            Yearly trends
          </a>
        </Button>
      </div>

      <Section
        title="Registry population"
        definition="Animals known to SFPCA are durable registry records (retired merge duplicates excluded). 'Active known' means lifecycle_status = active — living on Saba or in registry care per the current registry state."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.population.activeKnownAnimals}
            </div>
            <div className="text-sm text-muted-foreground">
              Active animals known to SFPCA
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.population.knownAnimals}
            </div>
            <div className="text-sm text-muted-foreground">
              Total known animals (all lifecycle states)
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.population.withCurrentOwner}
            </div>
            <div className="text-sm text-muted-foreground">
              Active animals with a recorded current owner
            </div>
          </div>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <CountTable
            caption="Lifecycle status of all known animals"
            rows={report.population.lifecycle.map((l) => ({
              label:
                l.key === "unknown"
                  ? `${l.label} (record exists; current status unconfirmed)`
                  : l.label,
              count: l.count,
            }))}
          />
          <CountTable
            caption="Species of active known animals"
            rows={report.population.speciesAmongActive.map((s) => ({
              label: s.label,
              count: s.count,
            }))}
          />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">
            Age distribution of active known animals{" "}
            <span className="font-normal text-muted-foreground">
              ({report.population.estimatedBirthDates} based on an
              estimated birth date)
            </span>
          </h3>
          <CountTable
            caption="Age bands of active known animals"
            rows={report.population.ageBandsAmongActive.map((b) => ({
              label: b.label,
              count: b.count,
            }))}
          />
        </div>
      </Section>

      <Section
        title={`Registration — ${year}`}
        definition="Authoritative registrations for the period (intake submissions never count). 'Eligible' animals are those whose lifecycle expects registration: active or unknown."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.registration.uniqueAnimalsRegistered}
            </div>
            <div className="text-sm text-muted-foreground">
              Animals registered for {year}
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.registration.eligibleRegistered}
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                of {report.registration.eligibleAnimals}
              </span>
            </div>
            <div className="text-sm text-muted-foreground">
              Eligible animals registered ({pct(report.registration.registeredPct)})
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.registration.eligibleUnregistered}
            </div>
            <div className="text-sm text-muted-foreground">
              Eligible animals not yet registered
            </div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {report.registration.rowsForPeriod} registration records exist
          for {year}: {report.registration.active} in effect,{" "}
          {report.registration.cancelledCorrection} cancelled as
          corrections, {report.registration.cancelledWithdrawn} withdrawn.
        </p>
        {report.registrationTrend.length > 0 && (
          <div>
            <h3 className="text-sm font-medium mb-2">
              Registrations by period
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Year</TableHead>
                  <TableHead scope="col" className="text-right">
                    In effect
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Unique animals
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Cancelled
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.registrationTrend.map((t) => (
                  <TableRow key={t.year}>
                    <TableCell>{t.year}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.active}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.uniqueAnimals}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.cancelled}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section
        title={`Registration payments — ${year}`}
        definition="Payment state is derived from the confirmed payment ledger for this period's active registrations. Pending money never counts as settled; waived and complimentary are resolutions, not payments. 'Financially resolved' = paid, waived, complimentary, or no fee due."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.registration.payments.resolved}
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                of {report.registration.active}
              </span>
            </div>
            <div className="text-sm text-muted-foreground">
              Financially resolved ({pct(report.registration.payments.resolvedPct)})
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {usd(report.registration.payments.settledCents)}
            </div>
            <div className="text-sm text-muted-foreground">
              Settled of {usd(report.registration.payments.assessedCents)}{" "}
              assessed
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {usd(report.registration.payments.outstandingCents)}
            </div>
            <div className="text-sm text-muted-foreground">
              Still outstanding
              {report.registration.payments.pendingCents > 0 &&
                ` · ${usd(report.registration.payments.pendingCents)} pending confirmation`}
            </div>
          </div>
        </div>
        <CountTable
          caption={`Payment state of ${year} registrations`}
          rows={report.registration.payments.byState.map((s) => ({
            label: REGISTRATION_PAYMENT_STATE_LABELS[s.state],
            count: s.count,
          }))}
        />
        {report.registration.payments.cancelledWithMoney > 0 && (
          <p className="text-sm text-muted-foreground">
            Note: {report.registration.payments.cancelledWithMoney}{" "}
            cancelled registration(s) still carry{" "}
            {usd(report.registration.payments.moneyOnCancelledCents)} of
            money — a data-quality item, not a debt.
          </p>
        )}
      </Section>

      <Section
        title="Health & prevention"
        definition="Among active known animals as of the report date. Sterilization is the authoritative animal-level status; 'unknown' is shown, never silently dropped. Vaccination state uses the latest recorded dose per animal and vaccine series."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <CountTable
            caption="Sterilization status of active known animals"
            rows={report.health.sterilizationAmongActive.map((s) => ({
              label: s.label,
              count: s.count,
            }))}
          />
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {pct(report.health.sterilizedPct)}
            </div>
            <div className="text-sm text-muted-foreground">
              of active known animals are recorded sterilized — the
              denominator includes animals whose status is unknown
            </div>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">
            Vaccination status — latest dose per animal &amp; series
          </h3>
          <p className="text-sm text-muted-foreground mb-2">
            {report.health.vaccination.animalsWithAnyRecord} of{" "}
            {report.population.activeKnownAnimals} active known animals
            have a vaccination on record;{" "}
            {report.health.vaccination.animalsWithoutRecord} have none
            (record unknown, not necessarily unvaccinated).
          </p>
          <CountTable
            caption="Vaccination due states"
            rows={report.health.vaccination.doseStates.map((s) => ({
              label: VACCINATION_DUE_STATE_LABELS[s.state],
              count: s.count,
            }))}
          />
        </div>
        {report.health.vaccination.series.length > 0 && (
          <div>
            <h3 className="text-sm font-medium mb-2">By vaccine series</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Series</TableHead>
                  <TableHead scope="col" className="text-right">
                    Animals
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Current
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Due soon
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Overdue
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.health.vaccination.series.map((s) => (
                  <TableRow key={s.seriesKey}>
                    <TableCell>{s.label}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.animals}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.current}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.dueSoon}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.overdue}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section
        title="Identification — microchips"
        definition="Among active known animals: an animal counts as chipped only with a current chip assignment (historical or replaced chips do not count)."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {pct(report.health.microchipCoveragePct)}
            </div>
            <div className="text-sm text-muted-foreground">
              Microchip coverage — {report.health.microchippedActive} of{" "}
              {report.population.activeKnownAnimals} active known animals
              have a current chip
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.health.notMicrochippedActive}
            </div>
            <div className="text-sm text-muted-foreground">
              Active known animals with no current chip
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-3xl font-bold tabular-nums">
              {report.health.openChipConflicts}
            </div>
            <div className="text-sm text-muted-foreground">
              Open microchip conflicts awaiting staff resolution
            </div>
          </div>
        </div>
      </Section>

      {report.lifecycleTrend.length > 0 && (
        <Section
          title="Lifecycle history"
          definition="Registry entry and outcome events by the real-world date they took effect — counts are distinct animals. Merge retirements are not losses and are excluded."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Year</TableHead>
                <TableHead scope="col" className="text-right">
                  Entered registry
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Confirmed active
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Recorded deceased
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Moved off Saba
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.lifecycleTrend.map((t) => (
                <TableRow key={t.year}>
                  <TableCell>{t.year}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.entered}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.becameActive}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.deceased}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.movedOffSaba}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      <Section
        title="Program workload"
        definition="Work actually performed, grouped by the year it happened — registrations processed, intake submissions, owner requests, lost/found cases, communications sent, and clinic activity. These are program volumes, not staff performance."
      >
        {report.workload.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Activity</TableHead>
                {report.workload.map((w) => (
                  <TableHead
                    key={w.year}
                    scope="col"
                    className="text-right"
                  >
                    {w.year}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(
                [
                  ["Registrations processed", "registrationsProcessed"],
                  ["Intake submissions", "intakeSubmissions"],
                  ["Owner requests opened", "ownerRequestsOpened"],
                  ["Owner requests resolved", "ownerRequestsResolved"],
                  ["Lost/found cases opened", "lostFoundOpened"],
                  ["Lost/found cases resolved", "lostFoundResolved"],
                  ["Animals reunited", "animalsReunited"],
                  ["Reminders & notices sent", "communicationsSent"],
                  ["Vaccinations administered", "vaccinationsAdministered"],
                  ["Spay/neuter procedures", "spayNeuterProcedures"],
                  ["Microchips assigned", "chipsAssigned"],
                  ["Annual confirmations", "annualConfirmations"],
                  ["Vet visits recorded", "vetVisitsRecorded"],
                ] as const
              ).map(([label, key]) => (
                <TableRow key={key}>
                  <TableCell>{label}</TableCell>
                  {report.workload.map((w) => (
                    <TableCell
                      key={w.year}
                      className="text-right tabular-nums"
                    >
                      {w[key]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">
            No recorded program activity yet.
          </p>
        )}
        <div>
          <h3 className="text-sm font-medium mb-2">Open right now</h3>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              {report.openWork.pendingSubmissions} pending intake
              submissions
            </Badge>
            <Badge variant="secondary">
              {report.openWork.pendingOwnerRequests} pending owner
              requests
            </Badge>
            <Badge variant="secondary">
              {report.openWork.openMissingCases} open missing-animal
              cases
            </Badge>
            <Badge variant="secondary">
              {report.openWork.openFoundUnmatched +
                report.openWork.openFoundMatched}{" "}
              open found-animal cases
            </Badge>
            <Badge variant="secondary">
              {report.openWork.openFollowUps} open vet follow-ups
            </Badge>
            <Badge variant="secondary">
              {report.openWork.expectedClinicAnimals} expected clinic
              animals
            </Badge>
          </div>
        </div>
      </Section>

      <Section
        title="Data quality context"
        definition="How complete the underlying data is — the denominators above are only as good as these. Unknowns are surfaced, never silently excluded."
      >
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="rounded-md border p-4">
            <div className="text-2xl font-bold tabular-nums">
              {report.dataQuality.unknownBirthDate}
            </div>
            <div className="text-xs text-muted-foreground">
              Active animals with no birth date
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-2xl font-bold tabular-nums">
              {report.dataQuality.unknownSterilization}
            </div>
            <div className="text-xs text-muted-foreground">
              Active animals with unknown sterilization
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-2xl font-bold tabular-nums">
              {report.dataQuality.noCurrentOwner}
            </div>
            <div className="text-xs text-muted-foreground">
              Active animals with no recorded owner
            </div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-2xl font-bold tabular-nums">
              {report.dataQuality.openChipConflicts}
            </div>
            <div className="text-xs text-muted-foreground">
              Open microchip conflicts
            </div>
          </div>
        </div>
      </Section>

      <p className="text-xs text-muted-foreground">
        Definitions: a <em>known animal</em> is a durable registry record
        (merge-retired duplicates excluded); <em>active known</em> means
        lifecycle status &ldquo;active&rdquo;; <em>registered for
        {" "}{year}</em> means an authoritative registration in effect for
        the {year} calendar-year period. These figures describe animals
        known to SFPCA and cannot estimate the total animal population of
        Saba. Full metric definitions: ARCHITECTURE.md &sect; reporting.
        Operational queues live on the{" "}
        <Link href="/admin" className="underline">
          dashboard
        </Link>
        .
      </p>
    </div>
  );
}
