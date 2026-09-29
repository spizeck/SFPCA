// Clinical document journey (#192): a staff member attaches a lab
// report to an animal's record — the file uploads to vet-docs/ under
// the admin-claim Storage rule, the vet_documents row registers through
// the server action, and staff read the object through the proxied
// /admin/documents/[id] route (deny-all client rules, audited access).
// Runs against the Firebase emulators + PGlite (seeded by
// tests/e2e/global-setup) — never production.
import { expect, test } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_APP_ORIGIN,
} from "./env";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("clinical documents", () => {
  test("staff can upload a document onto an animal and view it", async ({
    page,
  }) => {
    const label = `E2E Lab Report ${Date.now()}`;
    await signInAsAdmin(page);

    // Rexley is seeded in global-setup — a stable animal to attach to.
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);
    await page
      .getByRole("row", { name: /Rexley/ })
      .getByRole("link", { name: "Rexley" })
      .click();
    await expect(page.getByRole("heading", { name: "Rexley" })).toBeVisible();

    await page.getByRole("button", { name: "Upload document" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("File").setInputFiles({
      name: "lab-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 e2e synthetic lab report"),
    });
    await dialog.getByLabel("Label").fill(label);
    await dialog.getByLabel(/Notes/).fill("CBC panel — synthetic E2E file");
    await dialog.getByRole("button", { name: "Upload document" }).click();
    await expect(dialog).not.toBeVisible();

    // The document lands in the Registry card's Documents section.
    const docLink = page.getByRole("link", { name: label });
    await expect(docLink).toBeVisible();
    const href = await docLink.getAttribute("href");
    expect(href).toMatch(/^\/admin\/documents\/[0-9a-f-]{36}$/i);

    // The proxy route streams the object for the same authenticated
    // session — no signed URL, no client-readable Storage path.
    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    expect((await response.body()).toString()).toContain(
      "%PDF-1.4 e2e synthetic lab report",
    );
  });

  test("the download route refuses anonymous and forged sessions", async ({
    page,
    browser,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);
    await page
      .getByRole("row", { name: /Rexley/ })
      .getByRole("link", { name: "Rexley" })
      .click();
    await expect(page.getByRole("heading", { name: "Rexley" })).toBeVisible();

    const label = `E2E Boundary ${Date.now()}`;
    await page.getByRole("button", { name: "Upload document" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("File").setInputFiles({
      name: "boundary.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 boundary"),
    });
    await dialog.getByLabel("Label").fill(label);
    await dialog.getByRole("button", { name: "Upload document" }).click();
    await expect(dialog).not.toBeVisible();

    const href = await page
      .getByRole("link", { name: label })
      .getAttribute("href");
    expect(href).toBeTruthy();

    // Anonymous: no session cookie — the proxy redirects to /login
    // before the handler runs (manualRedirect off by default: assert
    // the final response is the login page, not the document).
    const anon = await browser.newContext();
    const anonResponse = await anon.request.get(href!);
    expect(anonResponse.status()).toBe(200);
    expect(anonResponse.url()).toContain("/login");
    await anon.close();

    // Forged cookie passes the proxy's presence check but fails
    // requireAdmin inside the handler — a hard 403, not the document.
    const forged = await browser.newContext();
    await forged.addCookies([
      {
        name: "session",
        value: "forged-not-a-real-session-cookie",
        url: E2E_APP_ORIGIN,
        httpOnly: true,
      },
    ]);
    const forgedResponse = await forged.request.get(href!);
    expect(forgedResponse.status()).toBe(403);
    await forged.close();
  });
});
