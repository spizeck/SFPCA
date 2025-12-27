import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/admin-nav";
import { ThemeToggle } from "@/components/theme-toggle";

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
      <ThemeToggle />
      <main className="container mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
