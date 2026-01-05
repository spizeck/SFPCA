"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Home, FileText, PawPrint, Settings, LogOut, Menu, ClipboardList, Stethoscope, Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { AdminThemeToggle } from "@/components/admin-theme-toggle";
import { useState } from "react";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: Home },
  { href: "/admin/homepage", label: "Homepage", icon: FileText },
  { href: "/admin/veterinary-services", label: "Vet Services", icon: Stethoscope },
  { href: "/admin/animal-adoptions", label: "Adoptions", icon: Heart },
  { href: "/admin/animal-registration", label: "Registration", icon: ClipboardList },
  { href: "/admin/animals", label: "Animals", icon: PawPrint },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = async () => {
    await fetch("/api/auth/session", { method: "DELETE" });
    router.push("/login");
  };

  return (
    <nav className="bg-card border-b">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-4 overflow-hidden">
            <Link href="/admin" className="text-xl font-bold text-primary whitespace-nowrap flex-shrink-0">
              SFPCA Admin
            </Link>
            <div className="hidden md:flex gap-1 overflow-x-auto">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-1 px-2 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground hover:bg-accent"
                    )}
                    title={item.label}
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    <span className="hidden xl:inline">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <Link href="/" target="_blank">
                  <span className="hidden sm:inline">View Site</span>
                  <span className="sm:hidden">Site</span>
                </Link>
              </Button>
              <AdminThemeToggle />
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                <LogOut className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="md:hidden"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              <Menu className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {mobileMenuOpen && (
          <div className="md:hidden border-t bg-card">
            <div className="px-2 pt-2 pb-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors w-full",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground hover:bg-accent"
                    )}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
            <div className="pt-4 pb-3 border-t">
              <div className="px-2 space-y-2">
                <Button variant="ghost" size="sm" asChild className="w-full justify-start">
                  <Link href="/" target="_blank">
                    View Site
                  </Link>
                </Button>
                <div className="flex items-center gap-2">
                  <AdminThemeToggle />
                  <span className="text-sm text-muted-foreground">Theme</span>
                </div>
                <Button variant="ghost" size="sm" onClick={handleLogout} className="w-full justify-start">
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
