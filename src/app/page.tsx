import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Homepage, SiteSettings } from "@/lib/types";
import { HeroSection } from "@/components/homepage/hero-section";
import { AboutSection } from "@/components/homepage/about-section";
import { ServicesSection } from "@/components/homepage/services-section";
import { DonationSection } from "@/components/homepage/donation-section";
import { WhoWeAreSection } from "@/components/homepage/who-we-are-section";
import { FaqSection } from "@/components/homepage/faq-section";
import { ContactSection } from "@/components/homepage/contact-section";
import { Footer } from "@/components/homepage/footer";
import { ThemeToggle } from "@/components/theme-toggle";
import { HashClear } from "@/components/hash-clear";

async function getHomepageData(): Promise<Homepage | null> {
  try {
    const docRef = doc(db, "homepage", "main");
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
      return docSnap.data() as Homepage;
    }
    return null;
  } catch (error) {
    console.error("Error fetching homepage data:", error);
    return null;
  }
}

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

export default async function HomePage() {
  const [homepage, settings] = await Promise.all([
    getHomepageData(),
    getSiteSettings(),
  ]);

  if (!homepage || !settings) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Website Configuration Required</h1>
          <p className="text-muted-foreground">Please configure the website through the admin panel.</p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen scroll-smooth">
      <HashClear />
      <ThemeToggle />
      <HeroSection data={homepage.hero} />
      <AboutSection data={homepage.about} />
      <ServicesSection data={homepage.services} />
      <DonationSection data={homepage.donation} />
      <WhoWeAreSection data={homepage.whoWeAre} />
      <FaqSection />
      <ContactSection contact={settings.contact} mapEmbedUrl={settings.mapEmbedUrl} />
      <Footer social={settings.social} />
    </main>
  );
}
