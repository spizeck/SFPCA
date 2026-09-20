import type { Metadata } from "next";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { AnimalRegistration } from "@/components/animal-registration/animal-registration-page";
import { SiteSettings } from "@/lib/types";
import { pageMetadata } from "@/lib/seo";
import { logError } from "@/lib/logger";

export const metadata: Metadata = pageMetadata({
  path: "/animal-registration",
  title: "Animal Registration",
  description:
    "Register your pet with SFPCA on Saba. Annual registration is required for all animals. Spayed/neutered pets qualify for reduced fees.",
});

async function getSiteSettings(): Promise<SiteSettings | null> {
  try {
    const docRef = doc(db, "siteSettings", "global");
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
      return docSnap.data() as SiteSettings;
    }
    return null;
  } catch (error) {
    logError("content", "fetch-site-settings", error);
    return null;
  }
}

export default async function AnimalRegistrationPage() {
  const settings = await getSiteSettings();

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <AnimalRegistration />
    </main>
  );
}
