"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { AdminThemeToggle } from "@/components/admin-theme-toggle";
import { cn } from "@/lib/utils";
import {
  CalendarClock,
  ChartColumn,
  CircleQuestionMark,
  ClipboardList,
  FileText,
  Heart,
  Home,
  Inbox,
  LogOut,
  Mail,
  Menu,
  PawPrint,
  ScanLine,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SquareArrowOutUpRight,
  Stethoscope,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

// Admin shell navigation (#238). Destinations are grouped by how staff
// actually use them, not alphabetically:
//
// - Operations: the day-to-day queues and workspaces staff live in.
// - Records: the registry itself — animals, people, intake review, and
//   the integrity/merge tooling that keeps it clean.
// - Content: editors for the PUBLIC site pages stored as CMS documents
//   (homepage/main, animalAdoptions/main, animalRegistration/main,
//   vetServices/main, faq/*) — see ARCHITECTURE's data table.
// - System: tenant-level configuration and operational self-checks.
//
// Route families: items stay active for their child routes
// (/admin/animals/<id>, /admin/data-quality/merge-person, …) via the
// href + "/" prefix rule in isActive — not bare equality. Adding a new
// section: append here; every route must keep a reachable entry.
type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operations",
    items: [
      { href: "/admin", label: "Dashboard", icon: Home },
      // Found-animal scanner workflow — first stop for strays.
      { href: "/admin/chip-lookup", label: "Chip Lookup", icon: ScanLine },
      // Lost/found case workspace (#176) — missing + found queues.
      { href: "/admin/lost-found", label: "Lost & Found", icon: Search },
      { href: "/admin/vet", label: "Vet Queue", icon: CalendarClock },
      // Owner-request inbox (#166) — claims, corrections, submissions.
      { href: "/admin/requests", label: "Requests", icon: Inbox },
      { href: "/admin/communications", label: "Communications", icon: Mail },
      // Reporting workspace (#179) — aggregate metrics, not a queue.
      { href: "/admin/reports", label: "Reports", icon: ChartColumn },
    ],
  },
  {
    label: "Records",
    items: [
      { href: "/admin/animals", label: "Animals", icon: PawPrint },
      { href: "/admin/persons", label: "People", icon: Users },
      { href: "/admin/registrations", label: "Registrations", icon: ClipboardList },
      // Duplicate/integrity review workspace (#178); merge child routes
      // keep this section active.
      { href: "/admin/data-quality", label: "Data Quality", icon: ShieldAlert },
    ],
  },
  {
    label: "Content",
    items: [
      { href: "/admin/homepage", label: "Homepage", icon: FileText },
      { href: "/admin/animal-adoptions", label: "Adoptions", icon: Heart },
      { href: "/admin/animal-registration", label: "Registration Page", icon: FileText },
      { href: "/admin/veterinary-services", label: "Vet Services", icon: Stethoscope },
      { href: "/admin/faq", label: "FAQ", icon: CircleQuestionMark },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin/settings", label: "Settings", icon: Settings },
      // Controlled Sentry verification (RUNBOOK §15).
      { href: "/admin/sentry-check", label: "Sentry Check", icon: ShieldCheck },
    ],
  },
];

// Active when the item's route family owns the current path. The
// `href + "/"` prefix keeps child routes (/admin/animals/abc,
// /admin/data-quality/merge) highlighting their section without
// matching siblings — /admin/animal-adoptions never matches
// /admin/animals because the boundary is the trailing slash.
function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavSectionList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-3 py-4">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label} className="pb-4 last:pb-0">
          <h2 className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {section.label}
          </h2>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground/80 hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
      router.push("/login");
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar — fixed, grouped, never scrolls horizontally. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r bg-card lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b px-4">
          <Link
            href="/admin"
            className="text-lg font-bold text-primary whitespace-nowrap"
          >
            SFPCA Admin
          </Link>
        </div>
        <NavSectionList />
        <div className="shrink-0 border-t px-3 py-3">
          <Link
            href="/"
            target="_blank"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          >
            <SquareArrowOutUpRight className="h-4 w-4 shrink-0" />
            View Site
          </Link>
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-sm text-muted-foreground">Theme</span>
            <AdminThemeToggle />
          </div>
          <Button
            variant="ghost"
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full justify-start gap-2.5 px-3 text-foreground/80 hover:text-foreground"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {loggingOut ? "Logging out…" : "Logout"}
          </Button>
        </div>
      </aside>

      {/* Mobile top bar — menu trigger + brand + reachable globals. */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-card px-3 lg:hidden">
        <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogPrimitive.Trigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Open navigation menu"
              aria-expanded={menuOpen}
            >
              <Menu className="h-5 w-5" />
            </Button>
          </DialogPrimitive.Trigger>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r bg-card shadow-lg focus:outline-hidden data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left"
            >
              <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
                <DialogPrimitive.Title className="text-lg font-bold text-primary">
                  SFPCA Admin
                </DialogPrimitive.Title>
                <DialogPrimitive.Close asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Close navigation menu"
                  >
                    <X className="h-5 w-5" />
                  </Button>
                </DialogPrimitive.Close>
              </div>
              <NavSectionList onNavigate={() => setMenuOpen(false)} />
              <div className="shrink-0 border-t px-3 py-3">
                <Link
                  href="/"
                  target="_blank"
                  className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <SquareArrowOutUpRight className="h-4 w-4 shrink-0" />
                  View Site
                </Link>
                <Button
                  variant="ghost"
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="w-full justify-start gap-2.5 px-3 text-foreground/80 hover:text-foreground"
                >
                  <LogOut className="h-4 w-4 shrink-0" />
                  {loggingOut ? "Logging out…" : "Logout"}
                </Button>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <Link
          href="/admin"
          className="text-lg font-bold text-primary whitespace-nowrap"
        >
          SFPCA Admin
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <AdminThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            disabled={loggingOut}
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" />
            <span className="sr-only">Log out</span>
          </Button>
        </div>
      </header>

      {/* Main content offset by the sidebar width at lg+. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="lg:pl-60"
      >
        <div className="container mx-auto px-4 py-8">{children}</div>
      </main>
    </div>
  );
}
