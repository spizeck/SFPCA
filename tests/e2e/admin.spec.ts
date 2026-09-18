// Admin journeys: protection of /admin and a real authenticated login
// through the application's UI against the Firebase Auth emulator
// (user + admins doc seeded by tests/e2e/global-setup).
import { expect, test } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./global-setup";

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

  test("unauthenticated nested admin routes redirect to login", async ({
    page,
  }) => {
    // /admin/registrations is absent from AdminNav; authorization must
    // not depend on discoverability.
    for (const path of ["/admin/registrations", "/admin/settings"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("a forged session cookie fails closed to login", async ({
    page,
    context,
  }) => {
    // A cookie that fails server-side verification must behave like no
    // session at all — never as ambient authority.
    await context.addCookies([
      {
        name: "session",
        value: "forged-not-a-real-session-cookie",
        url: "http://localhost:3100",
        httpOnly: true,
      },
    ]);

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a signed-in non-admin is denied a session and cannot enter /admin", async ({
    page,
  }) => {
    // The synthetic user has a verified email but no admins/ document:
    // Firebase sign-in succeeds, session creation is refused, and the
    // admin area stays unreachable.
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_USER_EMAIL);
    await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(
      page.getByText("Access Denied", { exact: true }),
    ).toBeVisible();
    await expect(page).not.toHaveURL("/admin");

    // No session was issued, so direct navigation still fails closed —
    // even for nested routes.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/admin/registrations");
    await expect(page).toHaveURL(/\/login/);
  });
});
