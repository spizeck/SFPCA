// Admin shell E2E (#238): the grouped sidebar at desktop widths, the
// drawer at mobile/tablet widths, route-family active states, and the
// no-horizontal-overflow guarantee the old navbar could not keep.
import { expect, test, type Page } from "./fixtures";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./env";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

// The document must never overflow horizontally — that was the exact
// defect of the old navbar (overflow-x-auto on a 17-item strip).
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("admin shell — desktop", () => {
  test("1440px: grouped sidebar, active state, no horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInAsAdmin(page);

    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav).toBeVisible();

    // All four groups render as labeled sections.
    for (const label of ["Operations", "Records", "Content", "System"]) {
      await expect(nav.getByText(label, { exact: true })).toBeVisible();
    }

    // Dashboard is current on /admin, and exactly one item is current.
    await expect(
      nav.getByRole("link", { name: "Dashboard" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

    // Global actions live outside the nav, in the sidebar footer.
    await expect(
      nav.getByRole("link", { name: "View Site" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "View Site" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Logout" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Toggle theme" }),
    ).toBeVisible();

    await expectNoHorizontalOverflow(page);
  });

  test("1024px: sidebar present, nested route keeps section active", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await signInAsAdmin(page);

    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav).toBeVisible();
    // No drawer trigger at this width.
    await expect(
      page.getByRole("button", { name: "Open navigation menu" }),
    ).toBeHidden();

    // Child route of a section → the section item stays current.
    await page.goto("/admin/data-quality/merge");
    await expect(
      nav.getByRole("link", { name: "Data Quality" }),
    ).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("admin shell — small screens", () => {
  test("768px: drawer opens, navigates, and closes on selection", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await signInAsAdmin(page);

    // Sidebar is hidden; the top bar trigger is the way in.
    await expect(
      page.getByRole("navigation", { name: "Admin" }),
    ).toBeHidden();
    const trigger = page.getByRole("button", {
      name: "Open navigation menu",
    });
    await expect(trigger).toBeVisible();

    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "SFPCA Admin" });
    await expect(drawer).toBeVisible();
    // Focus moves inside the drawer (the consent notice is also a
    // dialog — query the drawer element itself, not the first dialog
    // in DOM order).
    await expect.poll(() =>
      drawer.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);

    // Selecting a destination navigates AND closes the drawer.
    await drawer.getByRole("link", { name: "Animals" }).click();
    await expect(page).toHaveURL("/admin/animals");
    await expect(drawer).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });

  test("390px: drawer groups render and Escape restores trigger focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAsAdmin(page);

    const trigger = page.getByRole("button", {
      name: "Open navigation menu",
    });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "SFPCA Admin" });
    const drawerNav = drawer.getByRole("navigation", { name: "Admin" });
    for (const label of ["Operations", "Records", "Content", "System"]) {
      await expect(
        drawerNav.getByText(label, { exact: true }),
      ).toBeVisible();
    }
    // Global actions reachable inside the drawer.
    await expect(
      drawer.getByRole("link", { name: "View Site" }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Logout" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    // Focus returns to the trigger — keyboard users aren't stranded.
    await expect(trigger).toBeFocused();
    await expectNoHorizontalOverflow(page);
  });
});
