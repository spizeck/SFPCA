import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SFPCA - Saba Foundation for Preventing Cruelty to Animals",
  description: "Dedicated to animal welfare, veterinary services, and adoption in Saba",
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
