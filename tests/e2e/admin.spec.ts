// Admin journeys: protection of /admin and a real authenticated login
// through the application's UI against the Firebase Auth emulator
// (user + admins doc seeded by tests/e2e/global-setup).
import { expect, test } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";

test.describe("admin journeys", () => {
  test("unauthenticated /admin redirects to login", async ({ page }) => {
    await page.goto("/admin");

    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "SFPCA Admin" }),
    ).toBeVisible();
    await expect(
      page.getByText("Sign in to access the admin dashboard"),
    ).toBeVisible();
  });

  test("admin can sign in through the real login flow and reach the dashboard", async ({
    page,
  }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // The app posts the ID token to /api/auth/session, receives the
    // session cookie, then client-navigates to /admin.
    await expect(page).toHaveURL("/admin");
    await expect(
      page.getByRole("heading", { name: "Admin Dashboard" }),
    ).toBeVisible();
  });

  test("authenticated admin can navigate to a protected admin surface", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/admin");

    await page.getByRole("link", { name: "Manage Animals" }).click();

    await expect(page).toHaveURL("/admin/animals");
    await expect(
      page.getByRole("heading", { name: "Manage Animals" }),
    ).toBeVisible();
  });
});
