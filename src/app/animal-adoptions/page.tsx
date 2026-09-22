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

export const metadata: Metadata = pageMetadata({
  path: "/animal-adoptions",
  title: "Animal Adoptions",
  description:
    "Adopt a pet from SFPCA on Saba. Browse available dogs, cats, and other animals looking for loving forever homes in the Caribbean.",
});

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
  const content = await getAdoptionsContent();

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <AnimalAdoptions content={content} />
    </main>
  );
}
