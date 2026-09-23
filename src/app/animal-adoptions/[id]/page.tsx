import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnimalDetail } from "@/components/animal-adoptions/animal-detail";
import { getPublicAnimal } from "@/lib/registry/public-animals";
import { getSiteUrl } from "@/lib/seo";

// Rendered per request rather than statically: an animal's lifecycle
// status can change at any time, and a stale prerendered page must never
// keep an adopted/pending animal publicly viewable. Firestore rules deny
// non-public reads regardless; getPublicAnimal fails closed to 404.
export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ id: string }>;
}

async function resolveAnimal(params: PageParams["params"]) {
  const { id } = await params;
  return getPublicAnimal(id);
}

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const animal = await resolveAnimal(params);
  // A non-public or missing animal produces a 404 — metadata must not
  // reveal that the record exists.
  if (!animal) notFound();

  const name = animal.name?.trim() || "Animal";
  const path = `/animal-adoptions/${animal.id}`;
  const description =
    animal.description?.trim() ||
    `Meet ${name}, an adoptable ${animal.species} at SFPCA on Saba.`;

  return {
    title: `${name} — Available for Adoption`,
    description,
    alternates: { canonical: path },
    openGraph: {
      title: `${name} — Available for Adoption | SFPCA`,
      description,
      url: `${getSiteUrl()}${path}`,
    },
  };
}

export default async function AnimalDetailPage({ params }: PageParams) {
  const animal = await resolveAnimal(params);
  if (!animal) notFound();

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <AnimalDetail animal={animal} />
    </main>
  );
}
