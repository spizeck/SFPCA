import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";

const inter = Inter({ subsets: ["latin"] });

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.sabaspca.org";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "SFPCA - Saba Foundation for Preventing Cruelty to Animals",
    template: "%s | SFPCA",
  },
  description:
    "Dedicated to animal welfare, veterinary services, and pet adoption on the island of Saba. Register your pet, adopt an animal, or learn about our veterinary services.",
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
  return (
    <html lang="en" suppressHydrationWarning>
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
