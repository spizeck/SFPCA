import type { Metadata } from "next";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { FAQ } from "@/components/faq/faq-page";
import { SiteSettings } from "@/lib/types";

export const metadata: Metadata = {
  title: "Frequently Asked Questions",
  description:
    "Find answers to common questions about SFPCA on Saba — pet adoption, animal registration, veterinary services, volunteering, and donations.",
  openGraph: {
    title: "FAQ | SFPCA",
    description:
      "Find answers to common questions about SFPCA — pet adoption, registration, veterinary services, and more.",
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

export default async function FAQPage() {
  const settings = await getSiteSettings();

  return (
    <main className="min-h-screen">
      <FAQ />
    </main>
  );
}
