import type { Metadata } from "next";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { AnimalAdoptions } from "@/components/animal-adoptions/animal-adoptions-page";
import {
  AnimalAdoptionsContent,
  DEFAULT_ADOPTIONS_CONTENT,
  normalizeAdoptionsContent,
} from "@/lib/page-content";
import { pageMetadata } from "@/lib/seo";
import { logError } from "@/lib/logger";
import { getAvailableAnimals } from "@/lib/registry/public-animals";

export const metadata: Metadata = pageMetadata({
  path: "/animal-adoptions",
  title: "Animal Adoptions",
  description:
    "Adopt a pet from SFPCA on Saba. Browse available dogs, cats, and other animals looking for loving forever homes in the Caribbean.",
});

// Rendered per request: the animal list must reflect the current read
// authority at request time. Before #182 the browser fetched Firestore
// directly; now the server reads through the registry seam, so a static
// prerender would freeze the list at build time.
export const dynamic = "force-dynamic";

async function getAdoptionsContent(): Promise<AnimalAdoptionsContent> {
  try {
    const docRef = doc(db, "animalAdoptions", "main");
    const docSnap = await getDoc(docRef);
    return normalizeAdoptionsContent(
      docSnap.exists() ? docSnap.data() : null,
    );
  } catch (error) {
    logError("content", "fetch-adoptions-content", error);
    return DEFAULT_ADOPTIONS_CONTENT;
  }
}

export default async function AnimalAdoptionsPage() {
  const [content, animals] = await Promise.all([
    getAdoptionsContent(),
    // Fails closed to [] on error — the listing shows its empty state
    // rather than breaking the page.
    getAvailableAnimals(),
  ]);

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <AnimalAdoptions content={content} animals={animals} />
    </main>
  );
}
