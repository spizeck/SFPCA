// Component tests for the admin shell (#238): grouped sidebar nav,
// route-family active states, the mobile drawer, and the global
// actions (View Site / theme / Logout) that live outside the nav list.
// next/navigation and next-themes are mocked at the boundary.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockPathname, mockPush, mockSetTheme } = vi.hoisted(() => ({
  mockPathname: vi.fn(),
  mockPush: vi.fn(),
  mockSetTheme: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: mockSetTheme }),
}));

import { AdminShell } from "@/components/admin/admin-shell";

beforeEach(() => {
  vi.clearAllMocks();
  mockPathname.mockReturnValue("/admin");
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
});

function renderShell() {
  return render(
    <AdminShell>
      <div data-testid="admin-content" />
    </AdminShell>,
  );
}

// The desktop sidebar nav landmark (the drawer mounts a second nav
// only while open — querying before opening selects the sidebar).
function sidebarNav() {
  return screen.getByRole("navigation", { name: "Admin" });
}

describe("AdminShell desktop navigation", () => {
  test("renders all four section groups", () => {
    renderShell();
    const nav = sidebarNav();
    for (const label of ["Operations", "Records", "Content", "System"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
  });

  test("every admin destination is a reachable link", () => {
    renderShell();
    const nav = sidebarNav();
    const expected: Record<string, string> = {
      Dashboard: "/admin",
      "Chip Lookup": "/admin/chip-lookup",
      "Lost & Found": "/admin/lost-found",
      "Vet Queue": "/admin/vet",
      Requests: "/admin/requests",
      Communications: "/admin/communications",
      Reports: "/admin/reports",
      Animals: "/admin/animals",
      People: "/admin/persons",
      Registrations: "/admin/registrations",
      "Data Quality": "/admin/data-quality",
      Homepage: "/admin/homepage",
      Adoptions: "/admin/animal-adoptions",
      "Registration Page": "/admin/animal-registration",
      "Vet Services": "/admin/veterinary-services",
      FAQ: "/admin/faq",
      Settings: "/admin/settings",
      "Sentry Check": "/admin/sentry-check",
    };
    for (const [label, href] of Object.entries(expected)) {
      expect(
        within(nav).getByRole("link", { name: label }),
        `nav link ${label}`,
      ).toHaveAttribute("href", href);
    }
  });

  test("global actions live outside the nav list", () => {
    renderShell();
    const nav = sidebarNav();
    expect(
      within(nav).queryByRole("link", { name: /View Site/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /View Site/i }),
    ).toHaveAttribute("href", "/");
    expect(screen.getAllByRole("button", { name: /Log ?out/i }).length)
      .toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByRole("button", { name: /Toggle theme/i }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("exact /admin marks Dashboard current", () => {
    renderShell();
    const dashboard = within(sidebarNav()).getByRole("link", {
      name: "Dashboard",
    });
    expect(dashboard).toHaveAttribute("aria-current", "page");
    // Nothing else is current.
    const currents = sidebarNav().querySelectorAll('[aria-current="page"]');
    expect(currents).toHaveLength(1);
  });

  test("nested route marks the section item current", () => {
    mockPathname.mockReturnValue("/admin/animals/abc-123");
    renderShell();
    expect(
      within(sidebarNav()).getByRole("link", { name: "Animals" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("merge child route keeps Data Quality current", () => {
    mockPathname.mockReturnValue("/admin/data-quality/merge-person");
    renderShell();
    expect(
      within(sidebarNav()).getByRole("link", { name: "Data Quality" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("sibling prefix does not leak active state", () => {
    // /admin/animal-adoptions must NOT activate /admin/animals.
    mockPathname.mockReturnValue("/admin/animal-adoptions");
    renderShell();
    const nav = sidebarNav();
    expect(
      within(nav).getByRole("link", { name: "Adoptions" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(nav).getByRole("link", { name: "Animals" }),
    ).not.toHaveAttribute("aria-current");
  });

  test("logout posts the session delete and routes to login", async () => {
    renderShell();
    fireEvent.click(screen.getAllByRole("button", { name: "Logout" })[0]);
    await vi.waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/auth/session", {
        method: "DELETE",
      });
      expect(mockPush).toHaveBeenCalledWith("/login");
    });
  });
});

describe("AdminShell mobile drawer", () => {
  test("trigger opens the dialog carrying its own nav", () => {
    renderShell();
    fireEvent.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    const dialog = screen.getByRole("dialog", { name: "SFPCA Admin" });
    // The modal hides the background (aria-hidden): only the drawer's
    // nav remains in the accessibility tree while it's open.
    expect(
      within(dialog).getByRole("navigation", { name: "Admin" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("navigation", { name: "Admin" }),
    ).toHaveLength(1);
  });

  test("selecting a destination closes the drawer", () => {
    renderShell();
    fireEvent.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    const dialog = screen.getByRole("dialog", { name: "SFPCA Admin" });
    fireEvent.click(
      within(dialog).getByRole("link", { name: "Chip Lookup" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "SFPCA Admin" }),
    ).not.toBeInTheDocument();
  });

  test("Escape closes the drawer and returns focus to the trigger", async () => {
    renderShell();
    const trigger = screen.getByRole("button", {
      name: "Open navigation menu",
    });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "SFPCA Admin" });
    // Focus moved inside the dialog on open (Radix focus trap).
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  test("drawer carries the same grouped navigation", () => {
    renderShell();
    fireEvent.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    const dialog = screen.getByRole("dialog", { name: "SFPCA Admin" });
    const drawerNav = within(dialog).getByRole("navigation", {
      name: "Admin",
    });
    for (const label of ["Operations", "Records", "Content", "System"]) {
      expect(within(drawerNav).getByText(label)).toBeInTheDocument();
    }
    expect(
      within(dialog).getByRole("link", { name: /View Site/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Logout" }),
    ).toBeInTheDocument();
  });
});
