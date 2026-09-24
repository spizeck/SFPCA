import type { Metadata } from "next";
import { requireOwner } from "@/lib/auth";
import { redirect } from "next/navigation";
import { NOINDEX_ROBOTS } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Owner Portal",
  robots: NOINDEX_ROBOTS,
};

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Session gate only — a signed-in account is enough to see the portal
  // chrome. The page itself decides what the account is linked to (an
  // unlinked identity sees the pending-claim state, not animal data).
  const { authorized } = await requireOwner();
  if (!authorized) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      <main id="main-content" tabIndex={-1} className="container mx-auto px-4 py-8 max-w-4xl">
        {children}
      </main>
    </div>
  );
}
