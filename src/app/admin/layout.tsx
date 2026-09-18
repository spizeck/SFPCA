import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/admin-nav";
import { NOINDEX_ROBOTS } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Admin",
  robots: NOINDEX_ROBOTS,
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { authorized } = await requireAdmin();

  if (!authorized) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      <AdminNav />
      <main id="main-content" tabIndex={-1} className="container mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
