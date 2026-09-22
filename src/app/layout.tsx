import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "klaro/dist/klaro.css";
import { ConsentManager } from "@/components/consent/consent-manager";
import { GOOGLE_CONSENT_DENIED } from "@/lib/consent";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import {
  getSiteUrl,
  organizationJsonLd,
  SITE_DESCRIPTION,
  SITE_NAME,
} from "@/lib/seo";

const inter = Inter({ 
  subsets: ["latin"],
  display: "swap",
  preload: true,
  variable: "--font-inter"
});

const siteUrl = getSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "SFPCA - Saba Foundation for Preventing Cruelty to Animals",
    template: "%s | SFPCA",
  },
  description: SITE_DESCRIPTION,
  authors: [{ name: SITE_NAME }],
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
    siteName: SITE_NAME,
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
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(organizationJsonLd()).replace(/</g, "\\u003c"),
          }}
        />
        {/* Google Consent Mode v2: deny optional storage before any Google
            tag can load. GTM itself is injected by the consent manager only
            after affirmative analytics consent (src/lib/consent.ts). */}
        <script
          dangerouslySetInnerHTML={{
            __html: [
              "window.dataLayer = window.dataLayer || [];",
              "window.gtag = window.gtag || function(){window.dataLayer.push(arguments);};",
              `window.gtag('consent','default',${JSON.stringify(GOOGLE_CONSENT_DENIED)});`,
            ].join("\n"),
          }}
        />
      </head>
      <body className={inter.className}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:outline-none"
        >
          Skip to main content
        </a>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Breadcrumbs />
          {children}
          <Toaster />
          <ConsentManager />
        </ThemeProvider>
      </body>
    </html>
  );
}
