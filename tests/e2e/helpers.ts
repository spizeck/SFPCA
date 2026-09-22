// Shared Playwright helpers for the emulator-backed e2e suite.
import { expect, type Page } from "@playwright/test";

// Mirrors CONSENT_STORAGE_NAME in src/lib/consent.ts — kept as a literal so
// e2e helpers stay independent of app internals.
const CONSENT_KEY = "sfpca-consent";

// The Klaro consent notice mounts asynchronously after hydration and
// auto-focuses itself (correct dialog behavior). Tests that exercise the
// page itself dismiss it deterministically so it can't intercept pointer
// events, shift focus, or satisfy `getByRole("dialog")` locators meant for
// app dialogs.
export async function dismissConsentNotice(page: Page): Promise<void> {
  const notice = page.locator(".cookie-notice");
  // Once consent is stored (earlier navigation in the same context) the
  // notice never mounts — skip the wait rather than burn a timeout.
  const stored = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    CONSENT_KEY,
  );
  if (stored !== null) return;
  const appeared = await notice
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  // The Next dev overlay can cover the bottom-right notice buttons in small
  // viewports and intercept the pointer — dispatch directly on the button.
  await notice
    .getByRole("button", { name: "I decline" })
    .dispatchEvent("click");
  await expect(notice).toBeHidden();
}
