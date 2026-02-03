import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { SiteSettings } from "@/lib/types";
import { ContactPageContent } from "@/components/contact/contact-page";

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

export default async function ContactPage() {
  const settings = await getSiteSettings();

  return (
    <main className="min-h-screen">
      <ContactPageContent 
        contact={settings?.contact}
        social={settings?.social}
        mapEmbedUrl={settings?.mapEmbedUrl}
      />
    </main>
  );
}
