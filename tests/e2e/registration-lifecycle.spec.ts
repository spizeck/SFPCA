// Registration lifecycle journey: an anonymous visitor submits the
// animal-registration form, the submission lands privately in Firestore,
// and an admin verifies it through the staff lifecycle. Runs entirely
// against the Firebase emulators — never production. All data is
// synthetic.
import { expect, test } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_OWNER_EMAIL,
  E2E_OWNER_PASSWORD,
} from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("animal registration lifecycle", () => {
  test("a visitor submits a registration and staff verify it", async ({
    page,
  }) => {
    // Unique synthetic values so retries in one emulator session never
    // collide with records from a previous attempt.
    const suffix = Date.now();
    const ownerName = `E2E Owner ${suffix}`;
    const animalName = `E2E Pet ${suffix}`;

    // Anonymous submission through the real public form.
    await page.goto("/animal-registration");
    await dismissConsentNotice(page);
    await page.getByLabel("Full Name").fill(ownerName);
    await page
      .getByRole("textbox", { name: "Address", exact: true })
      .fill("Windwardside, Saba (synthetic)");
    await page.getByLabel("Phone Number").fill("+599 416 0000");
    await page.getByLabel("Email Address").fill(`e2e-${suffix}@example.com`);
    await page.getByLabel("Animal's Name").fill(animalName);
    await page.getByLabel("Type of Animal").fill("Dog");
    // Click the option labels — the Radix radios expose both a button
    // and a hidden bubble input with the same accessible name.
    await page.getByText("Male", { exact: true }).click();
    await page.getByText("Yes", { exact: true }).click();
    await page.getByLabel(/I certify/).check();
    await page
      .getByRole("button", { name: /Submit Registration/ })
      .click();

    // Success is clearly communicated to the submitter.
    await expect(
      page.getByText("Registration Submitted").first(),
    ).toBeVisible();

    // The submission is not visible anywhere on the public site — the
    // private boundary itself is proven by the security-rules tests.
    await page.goto("/");
    await expect(page.getByText(ownerName)).not.toBeVisible();

    // Admin signs in and finds the pending submission.
    await signInAsAdmin(page);
    await page.goto("/admin/registrations");
    const row = page.getByRole("row", { name: new RegExp(ownerName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Pending");
    await expect(row).toContainText(animalName);

    // Staff transition it to verified through the lifecycle action.
    await row.getByRole("button", { name: "Verify registration" }).click();
    await expect(row).toContainText("Verified");

    // Reopening is available for corrections and returns it to pending.
    await row
      .getByRole("button", { name: "Reopen registration as pending" })
      .click();
    await expect(row).toContainText("Pending");
  });
});

// The #169 authoritative-registration journey: an active animal with
// only PRIOR-year history appears in the current-period exception
// queue; staff register it from the queue; the profile shows current +
// historical records; a recorded payment moves it to completed; the
// owner portal reflects the new state. A deceased animal seeded without
// a registration must never appear as a current-period gap.
test.describe("annual registrations (#169)", () => {
  test("queue → register → payment → profile history → portal", async ({
    page,
  }) => {
    const year = new Date().getFullYear();
    await signInAsAdmin(page);
    await page.goto("/admin/registrations");

    // Exception queue: Reggie is an active unregistered gap; the
    // deceased Oldbones is lifecycle-excluded, not merely absent.
    await expect(
      page.getByRole("row", { name: /Reggie/ }),
    ).toBeVisible();
    await expect(page.getByText("Oldbones")).not.toBeVisible();

    // Register straight from the queue — one authoritative row.
    await page
      .getByRole("row", { name: /Reggie/ })
      .getByRole("button", { name: "Register" })
      .click();
    // The animal leaves the gap queue and lands in outstanding.
    await expect(
      page.getByRole("row", { name: /Reggie.*Unpaid/ }),
    ).toBeVisible();

    // The animal profile shows current + prior-year history.
    await page
      .getByRole("row", { name: /Reggie.*Unpaid/ })
      .getByRole("link", { name: "Reggie" })
      .click();
    await expect(
      page.getByText(`${year} registration — registered`),
    ).toBeVisible();
    await expect(
      page.getByText(`${year - 1} registration`),
    ).toBeVisible();

    // Record a manual payment — payment state derives from the ledger.
    await page
      .getByRole("button", { name: "Record payment" })
      .first()
      .click();
    await page
      .locator('input[type="number"]')
      .first()
      .fill("100");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Paid").first()).toBeVisible();

    // Back on the queue page the registration is completed.
    await page.goto("/admin/registrations");
    await expect(
      page.getByRole("row", { name: /Reggie.*Paid/ }),
    ).toBeVisible();

    // The owner sees the new state — no staff notes, no internals.
    // Sign-in itself navigates to /portal; clearing cookies first drops
    // the admin session (the cookie is the server-side authority).
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_OWNER_EMAIL);
    await page.getByLabel("Password").fill(E2E_OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/portal");
    const reggieCard = page
      .locator("[class*=bg-card]")
      .filter({ has: page.getByRole("heading", { name: "Reggie" }) });
    await expect(
      reggieCard.getByText(`${year} registration:`),
    ).toBeVisible();
    await expect(reggieCard.getByText(/Paid/)).toBeVisible();
    await expect(reggieCard.getByText(/Registered:/)).toContainText(
      String(year - 1),
    );
  });
});

// The #170 ledger journey: registration money is truth, not flags.
// Penny ($100 due) proves the whole lifecycle — a pending bank
// transfer does NOT settle, staff confirmation does, cash settles the
// rest, a refund is a separate history row that puts the registration
// BACK into debt, and the owner portal only ever shows the balance.
test.describe("registration payment ledger (#170)", () => {
  test("pending → confirm → paid → refund → outstanding again", async ({
    page,
  }) => {
    const year = new Date().getFullYear();
    await signInAsAdmin(page);
    await page.goto("/admin/registrations");

    // Penny is an active unregistered gap — register from the queue.
    await page
      .getByRole("row", { name: /Penny/ })
      .getByRole("button", { name: "Register" })
      .click();
    await expect(
      page.getByRole("row", { name: /Penny.*Unpaid/ }),
    ).toBeVisible();
    await page
      .getByRole("row", { name: /Penny.*Unpaid/ })
      .getByRole("link", { name: "Penny" })
      .click();

    const editor = page.locator('[class*="bg-muted"]');

    // A claimed bank transfer records as PENDING — declared intent,
    // never settled money.
    await page
      .getByRole("button", { name: "Record payment" })
      .first()
      .click();
    await editor.locator('input[type="number"]').first().fill("40");
    await editor.getByRole("combobox").click();
    await page.getByRole("option", { name: "Bank transfer" }).click();
    await editor
      .getByRole("checkbox", { name: /Transfer claimed/ })
      .check();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    // The registration is still Unpaid — initiation is not truth.
    await expect(page.getByText("+40.00 USD")).toBeVisible();
    await expect(page.getByText("Pending").first()).toBeVisible();
    await expect(
      page.getByText(`${year} registration — registered`),
    ).toBeVisible();
    await expect(page.getByText("Unpaid").first()).toBeVisible();

    // Staff confirm the transfer arrived — now it is money truth.
    await page
      .getByRole("button", { name: "Confirm received" })
      .click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Partial").first()).toBeVisible();
    await expect(page.getByText(/60\.00 USD outstanding/)).toBeVisible();

    // Cash settles the remainder.
    await page
      .getByRole("button", { name: "Record payment" })
      .first()
      .click();
    await editor.locator('input[type="number"]').first().fill("60");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Paid").first()).toBeVisible();

    // Refund part of it — the original rows stay, a separate −25
    // refund row appears, and the balance goes back into debt.
    await page.getByRole("button", { name: "Refund" }).first().click();
    await editor.locator('input[type="number"]').first().fill("25");
    await editor
      .getByPlaceholder(/money is being returned/)
      .fill("Owner overpaid in cash");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("−25.00 USD")).toBeVisible();
    await expect(page.getByText("Partial").first()).toBeVisible();
    await expect(page.getByText(/25\.00 USD outstanding/)).toBeVisible();
    // Both original payments survive — append-only history.
    await expect(page.getByText("+40.00 USD")).toBeVisible();
    await expect(page.getByText("+60.00 USD")).toBeVisible();

    // The registration is back on the outstanding queue.
    await page.goto("/admin/registrations");
    await expect(
      page.getByRole("row", { name: /Penny.*Partial/ }),
    ).toBeVisible();

    // The owner sees the real outstanding amount — no internals.
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_OWNER_EMAIL);
    await page.getByLabel("Password").fill(E2E_OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/portal");
    const pennyCard = page
      .locator("[class*=bg-card]")
      .filter({ has: page.getByRole("heading", { name: "Penny" }) });
    await expect(
      pennyCard.getByText(`${year} registration:`),
    ).toBeVisible();
    await expect(pennyCard.getByText(/25\.00 USD outstanding/)).toBeVisible();
  });
});
