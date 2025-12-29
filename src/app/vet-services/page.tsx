import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { VetServices } from "@/components/vet-services/vet-services-page";
import { SiteSettings } from "@/lib/types";

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

export default async function VetServicesPage() {
  const settings = await getSiteSettings();

  return (
    <main className="min-h-screen">
      <VetServices />
    </main>
  );
}
