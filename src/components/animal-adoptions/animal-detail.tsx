import Link from "next/link";
import { ArrowLeft, PawPrint } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Animal } from "@/lib/types";
import { getAnimalAdoptionLabel } from "@/lib/animal-lifecycle";

// Presentational detail view for one publicly available animal. Every
// field is optional-rendered: a record missing optional data still
// produces a complete page rather than empty-looking sections.
export function AnimalDetail({ animal }: { animal: Animal }) {
  const photo = animal.photos?.[0];
  const name = animal.name?.trim() || "This animal";
  const description = animal.description?.trim();

  return (
    <div className="min-h-screen bg-background">
      <section className="py-12 md:py-20">
        <div className="container mx-auto px-4 max-w-4xl">
          <Button variant="ghost" size="sm" asChild className="mb-8">
            <Link href="/animal-adoptions">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              Back to Adoptable Animals
            </Link>
          </Button>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
            <div className="aspect-square rounded-lg overflow-hidden bg-muted flex items-center justify-center">
              {photo ? (
                // Photo URLs are admin-entered and may point at any host,
                // so a plain img avoids the next/image domain allowlist.
                <img
                  src={photo}
                  alt={`Photo of ${name}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <PawPrint
                  className="h-24 w-24 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </div>

            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h1 className="text-3xl md:text-4xl font-bold">{name}</h1>
                  <Badge variant="secondary">{animal.species}</Badge>
                </div>
                <p className="text-muted-foreground">
                  {getAnimalAdoptionLabel(animal.status)} for adoption
                </p>
              </div>

              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">
                    Age
                  </dt>
                  <dd>{animal.approxAge?.trim() || "Unknown"}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">
                    Sex
                  </dt>
                  <dd className="capitalize">
                    {animal.sex?.trim() || "Unknown"}
                  </dd>
                </div>
              </dl>

              {description && (
                <p className="text-lg text-foreground/90 whitespace-pre-wrap">
                  {description}
                </p>
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="text-xl">
                    Interested in {name}?
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-muted-foreground">
                    Contact SFPCA to start the adoption process — we&apos;ll
                    arrange a meeting and walk you through the next steps.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button asChild className="flex-1">
                      <Link href="/contact">Contact Us to Adopt</Link>
                    </Button>
                    <Button variant="outline" asChild className="flex-1">
                      <a href="tel:+5994167947">Call +599 416 7947</a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
