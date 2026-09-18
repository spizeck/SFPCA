import type { Metadata } from "next";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { AnimalAdoptions } from "@/components/animal-adoptions/animal-adoptions-page";
import { SiteSettings } from "@/lib/types";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/animal-adoptions",
  title: "Animal Adoptions",
  description:
    "Adopt a pet from SFPCA on Saba. Browse available dogs, cats, and other animals looking for loving forever homes in the Caribbean.",
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
    console.error("Error fetching site settings:", error);
    return null;
  }
}

export default async function AnimalAdoptionsPage() {
  const settings = await getSiteSettings();

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <AnimalAdoptions />
    </main>
  );
}
