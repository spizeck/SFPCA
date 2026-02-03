"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Home } from "lucide-react";
import { AdminThemeToggle } from "@/components/admin-theme-toggle";

export function Breadcrumbs() {
  const pathname = usePathname();
  
  // Don't show breadcrumbs on homepage
  if (pathname === "/") return null;

  const pathSegments = pathname.split("/").filter(Boolean);
  
  // Generate breadcrumb items
  const breadcrumbs = [
    { label: "Home", href: "/" },
    ...pathSegments.map((segment, index) => {
      const href = "/" + pathSegments.slice(0, index + 1).join("/");
      const label = formatBreadcrumbLabel(segment);
      return { label, href };
    })
  ];

  // Don't show the last segment as a link (current page)
  const lastBreadcrumb = breadcrumbs[breadcrumbs.length - 1];
  const otherBreadcrumbs = breadcrumbs.slice(0, -1);

  return (
    <nav className="py-4 px-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex items-center justify-between">
        <ol className="flex items-center space-x-2 text-sm text-muted-foreground">
          {otherBreadcrumbs.map((breadcrumb, index) => (
            <li key={breadcrumb.href} className="flex items-center">
              <Link
                href={breadcrumb.href}
                className="hover:text-foreground transition-colors flex items-center"
              >
                {index === 0 && <Home className="h-4 w-4 mr-1" />}
                {breadcrumb.label}
              </Link>
              <ChevronRight className="h-4 w-4 mx-2 text-muted-foreground/50" />
            </li>
          ))}
          <li className="text-foreground font-medium flex items-center">
            {lastBreadcrumb.label}
          </li>
        </ol>
        <AdminThemeToggle />
      </div>
    </nav>
  );
}

function formatBreadcrumbLabel(segment: string): string {
  // Handle special cases
  switch (segment) {
    case "vet-services":
      return "Veterinary Services";
    case "animal-adoptions":
      return "Animal Adoptions";
    case "animal-registration":
      return "Animal Registration";
    case "admin":
      return "Admin";
    case "homepage":
      return "Homepage";
    case "veterinary-services":
      return "Vet Services";
    case "registrations":
      return "Registrations";
    case "settings":
      return "Settings";
    case "animals":
      return "Animals";
    default:
      // Capitalize first letter and replace hyphens with spaces
      return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, " ");
  }
}
