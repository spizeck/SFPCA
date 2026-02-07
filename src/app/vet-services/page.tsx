import type { Metadata } from "next";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { VeterinaryServices } from "@/components/veterinary-services/veterinary-services-page";
import { SiteSettings } from "@/lib/types";

export const metadata: Metadata = {
  title: "Veterinary Services",
  description:
    "Professional veterinary care on Saba. SFPCA offers spay/neuter programs, vaccinations, wellness exams, and emergency animal care.",
  openGraph: {
    title: "Veterinary Services | SFPCA",
    description:
      "Professional veterinary care on Saba. Spay/neuter programs, vaccinations, wellness exams, and emergency animal care.",
  },
};

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
      <VeterinaryServices />
    </main>
  );
}
