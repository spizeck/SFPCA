// Public registry statistics (#179). Everything on this page comes from
// getPublicStats — a dedicated anonymous DTO, NOT the staff report with
// fields removed. The DTO contains only aggregates: no owner, household,
// contact, microchip, payment, or medical data exists in it at all.
//
// Two promises this page makes in copy:
//   1. SCOPE — figures describe animals known to SFPCA. The registry is
//      not a census and cannot estimate Saba's total animal population.
//   2. PRIVACY — small categories are suppressed ("Fewer than N") so no
//      household can be singled out by combining attributes; the
//      threshold comes from the canonical policy in src/lib/reports.ts.
//
// force-dynamic: a count of known animals must never go stale on a
// prerender, and the DTO is already aggregate-only.

import type { Metadata } from "next";
import { getPublicStats } from "@/lib/registry/reports";
import { pageMetadata } from "@/lib/seo";
import { logError } from "@/lib/logger";
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
import type { PublicStatsReport } from "@/lib/registry/reports";

export const metadata: Metadata = pageMetadata({
  path: "/statistics",
  title: "Registry Statistics",
  description:
    "How many animals SFPCA knows, registers, and reunites on Saba — anonymized registry statistics, updated live.",
});

export const dynamic = "force-dynamic";

function StatCard({
  value,
  label,
  note,
}: {
  value: string | number;
  label: string;
  note?: string;
}) {
  return (
    <div className="rounded-lg border p-4 text-center">
      <div className="text-3xl font-bold tabular-nums">{value}</div>
      <div className="text-sm font-medium mt-1">{label}</div>
      {note && (
        <div className="text-xs text-muted-foreground mt-1">{note}</div>
      )}
    </div>
  );
}

function BreakdownTable({
  title,
  cells,
  smallCellMin,
}: {
  title: string;
  cells: PublicStatsReport["speciesBreakdown"];
  smallCellMin: number;
}) {
  const anySuppressed = cells.some((c) => c.suppressed);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        {anySuppressed && (
          <CardDescription>
            Categories with fewer than {smallCellMin} animals are not
            shown — on a small island, fine detail could identify
            individual households.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Category</TableHead>
              <TableHead scope="col" className="text-right">
                Animals
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cells.map((c) => (
              <TableRow key={c.key}>
                <TableCell>{c.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.suppressed ? (
                    <span className="text-muted-foreground">
                      Fewer than {smallCellMin}
                    </span>
                  ) : (
                    c.count
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default async function StatisticsPage() {
  let stats: PublicStatsReport | null = null;
  try {
    stats = await getPublicStats();
  } catch (error) {
    // Fail closed: never break the public page over a reporting hiccup.
    logError("reports", "public-stats", error);
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl font-bold mb-4">Registry Statistics</h1>
        <p className="text-lg text-muted-foreground mb-2">
          A look at the animals SFPCA knows and the work we do — from
          registrations and microchips to reuniting lost pets with their
          families.
        </p>
        <p className="text-sm text-muted-foreground mb-10">
          These figures describe <strong>animals known to SFPCA</strong>{" "}
          — pets registered with us or otherwise recorded in our
          registry. They are <strong>not</strong> a census and cannot
          estimate the total number of animals on Saba. All figures are
          anonymized aggregates.
        </p>

        {!stats ? (
          <p className="text-muted-foreground">
            Statistics are temporarily unavailable — please check back
            soon.
          </p>
        ) : (
          <div className="space-y-8">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                value={stats.activeKnownAnimals}
                label="Active animals known to SFPCA"
                note={`as of ${stats.asOf}`}
              />
              <StatCard
                value={stats.registeredThisPeriod}
                label={`Animals registered for ${stats.registrationYear}`}
                note={
                  stats.registeredPct !== null
                    ? `${stats.registeredPct}% of animals expected to register`
                    : undefined
                }
              />
              <StatCard
                value={stats.knownAnimals}
                label="Total animals in the registry"
                note="including deceased and departed animals kept for history"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                value={
                  stats.sterilizedPct === null
                    ? "—"
                    : `${stats.sterilizedPct}%`
                }
                label="recorded as sterilized"
                note="of active animals known to SFPCA"
              />
              <StatCard
                value={
                  stats.microchippedPct === null
                    ? "—"
                    : `${stats.microchippedPct}%`
                }
                label="have a current microchip"
                note="of active animals known to SFPCA"
              />
              <StatCard
                value={stats.program.animalsReunited}
                label={`lost animals reunited in ${stats.registrationYear}`}
              />
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <BreakdownTable
                title="Species"
                cells={stats.speciesBreakdown}
                smallCellMin={stats.smallCellMin}
              />
              <BreakdownTable
                title="Age distribution"
                cells={stats.ageBreakdown}
                smallCellMin={stats.smallCellMin}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  What we did in {stats.registrationYear}
                </CardTitle>
                <CardDescription>
                  Program activity so far this year.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div className="flex justify-between border-b pb-2">
                    <dt>New animals entering the registry</dt>
                    <dd className="font-medium tabular-nums">
                      {stats.program.newRegistryEntries}
                    </dd>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <dt>Registrations processed</dt>
                    <dd className="font-medium tabular-nums">
                      {stats.program.registrationsCompleted}
                    </dd>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <dt>Vaccinations administered</dt>
                    <dd className="font-medium tabular-nums">
                      {stats.program.vaccinationsAdministered}
                    </dd>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <dt>Spay/neuter procedures</dt>
                    <dd className="font-medium tabular-nums">
                      {stats.program.spayNeuterProcedures}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <section aria-labelledby="about-numbers">
              <h2
                id="about-numbers"
                className="text-lg font-semibold mb-2"
              >
                About these numbers
              </h2>
              <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
                <li>
                  <em>Active animals known to SFPCA</em> means registry
                  records whose current status is &ldquo;active&rdquo; —
                  living on Saba or in our care. Animals confirmed
                  deceased or moved off the island are excluded;
                  unconfirmed records are not counted as active.
                </li>
                <li>
                  <em>Registered for {stats.registrationYear}</em> counts
                  animals with a valid SFPCA registration for the{" "}
                  {stats.registrationYear} calendar-year period.
                </li>
                <li>
                  Percentages are share of active animals known to SFPCA.
                  &ldquo;Current microchip&rdquo; means a chip assignment
                  in effect now; replaced chips don&apos;t count.
                </li>
                <li>
                  To protect privacy, categories with fewer than{" "}
                  {stats.smallCellMin} animals are shown as
                  &ldquo;Fewer than {stats.smallCellMin}&rdquo; rather
                  than exact figures.
                </li>
                <li>
                  The registry cannot estimate the total number of
                  animals on Saba — only animals SFPCA knows about appear
                  here.
                </li>
              </ul>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
