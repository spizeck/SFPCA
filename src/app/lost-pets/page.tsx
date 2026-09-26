// Public lost-animal listing (#176). Shows ONLY cases staff explicitly
// published — the query behind listPublishedLostAnimals filters to
// publishedAt IS NOT NULL + status='open', so a resolved or
// un-published case disappears from here automatically while its
// internal history is retained.
//
// Privacy: the PublicLostAnimal DTO carries name/photo/species/sex/
// breed/date/location/public note only. No owner or reporter contact,
// no staff notes, no chip numbers. The "I've seen this animal" form
// submits TO SFPCA — it never opens a channel to the owner.
//
// Rendered per request rather than statically so a resolved case
// cannot linger on a stale prerender; the DTO is already
// privacy-minimal so dynamic rendering is belt-and-braces.

import type { Metadata } from "next";
import Image from "next/image";
import { listPublishedLostAnimals } from "@/lib/registry/lost-found";
import { SightingForm } from "@/components/lost-pets/sighting-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { pageMetadata } from "@/lib/seo";
import { logError } from "@/lib/logger";

export const metadata: Metadata = pageMetadata({
  path: "/lost-pets",
  title: "Lost Pets",
  description:
    "Animals reported missing on Saba. If you've seen one of these pets, let SFPCA know — please don't approach unfamiliar animals.",
});

export const dynamic = "force-dynamic";

export default async function LostPetsPage() {
  let animals: Awaited<ReturnType<typeof listPublishedLostAnimals>> = [];
  try {
    animals = await listPublishedLostAnimals();
  } catch (error) {
    // Fail closed to the empty state — never break the public page.
    logError("lost-found", "public-list", error);
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl font-bold mb-4">Lost Pets</h1>
        <p className="text-lg text-muted-foreground mb-2">
          These animals have been reported missing on Saba. If you think
          you&apos;ve seen one, use the report button on its card or contact
          SFPCA directly — please don&apos;t chase or approach unfamiliar
          animals.
        </p>
        <p className="text-sm text-muted-foreground mb-10">
          If your own pet is missing, report it through your owner portal
          or contact SFPCA.
        </p>

        {animals.length === 0 ? (
          <p className="text-muted-foreground">
            There are no animals listed as missing right now.
          </p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            {animals.map((a) => (
              <Card key={a.caseId}>
                <CardHeader>
                  <CardTitle>{a.name}</CardTitle>
                  <CardDescription>
                    {a.species}
                    {a.sex ? ` · ${a.sex}` : ""}
                    {a.approxAge ? ` · ${a.approxAge}` : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {a.photoUrl && (
                    <Image
                      src={a.photoUrl}
                      alt={a.name}
                      width={600}
                      height={400}
                      className="rounded-md w-full h-48 object-cover"
                    />
                  )}
                  <p className="text-sm">
                    {a.missingSince ? `Missing since ${a.missingSince}` : ""}
                    {a.missingSince && a.lastSeenLocation ? " — " : ""}
                    {a.lastSeenLocation ? `last seen ${a.lastSeenLocation}` : ""}
                  </p>
                  {a.publicNote && (
                    <p className="text-sm text-muted-foreground">
                      {a.publicNote}
                    </p>
                  )}
                  <SightingForm caseId={a.caseId} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
