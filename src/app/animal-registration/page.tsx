import type { Metadata } from "next";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { AnimalRegistration } from "@/components/animal-registration/animal-registration-page";
import {
  AnimalRegistrationContent,
  DEFAULT_REGISTRATION_CONTENT,
  normalizeRegistrationContent,
} from "@/lib/page-content";
import { pageMetadata } from "@/lib/seo";
import { logError } from "@/lib/logger";

export const metadata: Metadata = pageMetadata({
  path: "/animal-registration",
  title: "Animal Registration",
  description:
    "Register your pet with SFPCA on Saba. Annual registration is required for all animals. Spayed/neutered pets qualify for reduced fees.",
});

async function getRegistrationContent(): Promise<AnimalRegistrationContent> {
  try {
    const docRef = doc(db, "animalRegistration", "main");
    const docSnap = await getDoc(docRef);
    return normalizeRegistrationContent(
      docSnap.exists() ? docSnap.data() : null,
    );
  } catch (error) {
    logError("content", "fetch-registration-content", error);
    return DEFAULT_REGISTRATION_CONTENT;
  }
}

export default async function AnimalRegistrationPage() {
  const content = await getRegistrationContent();

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <AnimalRegistration content={content} />
    </main>
  );
}
