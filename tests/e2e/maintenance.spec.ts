// Maintenance-mode gate (#189). Runs under playwright.maintenance.config.ts,
// which starts the dev server with SITE_MAINTENANCE_MODE=true — the real
// proxy decision in a production-like configuration, not a mocked flag.
// The trust boundary is exercised end-to-end: forged and revoked session
// cookies are rejected by the same Firebase session-cookie + Postgres
// admin_users chain requireAdmin() uses — nothing here mocks it.
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { dbQuery, expect, test } from "./fixtures";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_FIREBASE_PROJECT_ID,
  E2E_OWNER_EMAIL,
  E2E_OWNER_PASSWORD,
} from "./env";

// Admin SDK in the worker process targets the Auth emulator purely via
// FIREBASE_AUTH_EMULATOR_HOST (exported by `firebase emulators:exec`).
function adminAuth() {
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ projectId: E2E_FIREBASE_PROJECT_ID });
  return getAuth(app);
}

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test.describe("maintenance mode", () => {
  test("anonymous visitors are gated on public routes", async ({ page }) => {
    for (const path of ["/", "/animal-adoptions", "/contact", "/faq"]) {
      await page.goto(path);
      await expect(page).toHaveURL("/under-construction");
    }
    await expect(
      page.getByRole("heading", { name: "Under Construction" }),
    ).toBeVisible();
  });

  test("the under-construction page offers a discreet staff sign-in", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/under-construction");
    const link = page.getByRole("link", { name: "sign in" });
    await expect(link).toHaveAttribute("href", "/login");
    await link.click();
    await expect(page).toHaveURL("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("a forged session cookie does not bypass the gate", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "session",
        value: "forged-not-a-real-session-cookie",
        url: "http://localhost:3100",
        httpOnly: true,
      },
    ]);
    // The cookie reaches the real proxy → real verifySessionCookie →
    // rejection → maintenance redirect. Not a mocked check.
    await page.goto("/");
    await expect(page).toHaveURL("/under-construction");
    await page.goto("/faq");
    await expect(page).toHaveURL("/under-construction");
    // A forged cookie on /admin gets past the cheap presence gate but is
    // refused by the page-level requireAdmin — destination is /login.
    await page.goto("/admin");
    await expect(page).toHaveURL("/login");
  });

  test("auth surfaces stay reachable so admins can authenticate", async ({
    page,
  }) => {
    // /login renders unauthenticated.
    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    // The session-establishment API answers itself (401 on a bodiless
    // POST) rather than redirecting into the maintenance page.
    const res = await page.request.post("/api/auth/session", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(401);
  });

  test("a valid non-admin session does not bypass the gate", async ({
    page,
  }) => {
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);
    // Owner sessions land on the portal — owner self-service stays
    // reachable under maintenance by design (#166).
    await expect(page).toHaveURL("/portal");

    // But a valid authenticated NON-admin session earns no public bypass:
    // the verified-admin check fails and the gate re-engages.
    await page.goto("/");
    await expect(page).toHaveURL("/under-construction");
    await page.goto("/animal-adoptions");
    await expect(page).toHaveURL("/under-construction");
    // And the admin area is refused by the page-level requireAdmin.
    await page.goto("/admin");
    await expect(page).toHaveURL("/login");
  });

  test("an authenticated admin browses the whole site", async ({ page }) => {
    await signIn(page, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
    await expect(page).toHaveURL("/admin");

    await page.goto("/");
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", {
        name: "Saba Foundation for Preventing Cruelty to Animals",
      }),
    ).toBeVisible();

    await page.goto("/animal-adoptions");
    await expect(
      page.getByRole("heading", { name: /Adopt/i }).first(),
    ).toBeVisible();

    await page.goto("/admin");
    await expect(page).toHaveURL("/admin");
  });

  test("logout re-engages the gate", async ({ page }) => {
    await signIn(page, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
    // Wait for the session cookie to exist (post-login navigation) before
    // the gated request — otherwise the goto races the session POST.
    await expect(page).toHaveURL("/admin");
    await page.goto("/");
    await expect(page).toHaveURL("/");

    // The real logout path: the session route clears the cookie.
    const res = await page.request.delete("/api/auth/session");
    expect(res.ok()).toBe(true);

    await page.goto("/");
    await expect(page).toHaveURL("/under-construction");
  });

  test("revoking the admin_users row re-engages the gate mid-session", async ({
    page,
  }) => {
    // A throwaway admin — created and revoked entirely inside this test
    // so the seeded accounts are untouched. admin_users is the
    // authoritative layer: once the row is gone the still-valid
    // (unexpired, still-signed) session cookie loses the bypass.
    const email = "e2e-temp-admin@example.com";
    const password = "e2e-test-only-password";
    const user = await adminAuth().createUser({
      email,
      password,
      emailVerified: true,
    });
    await dbQuery("INSERT INTO admin_users (email, role) VALUES ($1, 'admin')", [
      email,
    ]);

    await signIn(page, email, password);
    await expect(page).toHaveURL("/admin");
    await page.goto("/");
    await expect(page).toHaveURL("/");

    // Staff removes the role; the very next request is gated again even
    // though the session cookie itself is still cryptographically valid.
    await dbQuery("DELETE FROM admin_users WHERE lower(email) = lower($1)", [
      email,
    ]);
    await adminAuth().updateUser(user.uid, { disabled: true });
    await page.goto("/");
    await expect(page).toHaveURL("/under-construction");
  });

  test("ADMIN_EMAILS alone does not earn the bypass once the row is gone", async ({
    page,
  }) => {
    // The authority split (#189): the env allowlist is the emergency
    // bootstrap for /admin via requireAdmin → isAdmin, but the
    // maintenance gate consults admin_users only. This account IS in
    // ADMIN_EMAILS (playwright.maintenance.config.ts webServer env);
    // login provisions its admin_users row, so deleting the row
    // mid-session reproduces the env-only state — and the gate must
    // re-engage even though /admin stays reachable.
    const email = "e2e-env-admin@example.com";
    const password = "e2e-test-only-password";
    await adminAuth().createUser({ email, password, emailVerified: true });

    await signIn(page, email, password);
    // Session route provisioned the row (env-listed) → bypass works.
    await expect(page).toHaveURL("/admin");
    await page.goto("/");
    await expect(page).toHaveURL("/");

    // Delete the staff row — the env entry still authorizes /admin…
    await dbQuery("DELETE FROM admin_users WHERE lower(email) = lower($1)", [
      email,
    ]);
    await page.goto("/admin");
    await expect(page).toHaveURL("/admin");

    // …but the public-site bypass requires the live row: gated again
    // on the very next request.
    await page.goto("/");
    await expect(page).toHaveURL("/under-construction");
    await page.goto("/animal-adoptions");
    await expect(page).toHaveURL("/under-construction");
  });
});
