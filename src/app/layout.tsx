import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";

const inter = Inter({ 
  subsets: ["latin"],
  display: "swap",
  preload: true,
  variable: "--font-inter"
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.sabafpca.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "SFPCA - Saba Foundation for Preventing Cruelty to Animals",
    template: "%s | SFPCA",
  },
  description:
    "Dedicated to animal welfare, veterinary services, and pet adoption on Saba. Register your pet, adopt an animal, or learn about our veterinary services.",
  keywords: [
    "SFPCA",
    "Saba",
    "animal welfare",
    "pet adoption",
    "veterinary services",
    "animal registration",
    "Caribbean",
    "animal shelter",
    "spay neuter",
    "Saba Foundation for Preventing Cruelty to Animals",
  ],
  authors: [{ name: "SFPCA" }],
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "SFPCA",
    title: "SFPCA - Saba Foundation for Preventing Cruelty to Animals",
    description:
      "Dedicated to animal welfare, veterinary services, and pet adoption on the island of Saba.",
  },
  twitter: {
    card: "summary_large_image",
    title: "SFPCA - Saba Foundation for Preventing Cruelty to Animals",
    description:
      "Dedicated to animal welfare, veterinary services, and pet adoption on the island of Saba.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Saba Foundation for Preventing Cruelty to Animals",
    "alternateName": "SFPCA",
    "url": siteUrl,
    "logo": `${siteUrl}/favicon.ico`,
    "description": "Dedicated to animal welfare, veterinary services, and pet adoption on the island of Saba.",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Saba",
      "addressCountry": "Caribbean Netherlands"
    },
    "contactPoint": {
      "@type": "ContactPoint",
      "contactType": "animal welfare services"
    },
    "sameAs": []
  };

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData),
          }}
        />
        {process.env.NEXT_PUBLIC_GA_ID && (
          <>
            <script
              async
              src={`https://www.googletagmanager.com/gtag/js?id=${process.env.NEXT_PUBLIC_GA_ID}`}
            />
            <script
              dangerouslySetInnerHTML={{
                __html: `
                  window.dataLayer = window.dataLayer || [];
                  function gtag(){dataLayer.push(arguments);}
                  gtag('js', new Date());
                  gtag('config', '${process.env.NEXT_PUBLIC_GA_ID}');
                `,
              }}
            />
          </>
        )}
      </head>
      <body className={inter.className}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Breadcrumbs />
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
