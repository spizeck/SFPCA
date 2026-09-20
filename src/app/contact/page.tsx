import type { Metadata } from "next";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { SiteSettings } from "@/lib/types";
import { ContactPageContent } from "@/components/contact/contact-page";
import { pageMetadata } from "@/lib/seo";
import { logError } from "@/lib/logger";

export const metadata: Metadata = pageMetadata({
  path: "/contact",
  title: "Contact Us",
  description:
    "Get in touch with SFPCA on Saba. Find our phone number, email, WhatsApp, address, hours, and location map.",
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

export default async function ContactPage() {
  const settings = await getSiteSettings();

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <ContactPageContent 
        contact={settings?.contact}
        social={settings?.social}
        mapEmbedUrl={settings?.mapEmbedUrl}
      />
    </main>
  );
}
